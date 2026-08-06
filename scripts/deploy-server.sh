#!/usr/bin/env bash
set -euo pipefail

project_root="${COD_PROJECT_ROOT:-/home/ubuntu/cod-project/cod}"
release_root="${COD_RELEASE_ROOT:-/opt/cod/releases}"
current_link="${COD_CURRENT_LINK:-/opt/cod/current}"
revision="$(git -C "${project_root}" rev-parse --short=12 HEAD)"
release="${release_root}/${revision}"
previous="$(readlink -f "${current_link}" 2>/dev/null || true)"
previous_revision="$(basename "${previous}" 2>/dev/null || true)"

source /home/ubuntu/cod-project/upstream/goose/bin/activate-hermit
cd "${project_root}"
npm ci
npm run typecheck
npm test
npm run lint
npm run build
npm audit --audit-level=high

sudo install -d -m 755 "${release_root}" "${release}"
sudo rsync -a --delete services/control-plane/dist/ "${release}/services/control-plane/dist/"
sudo install -m 644 services/control-plane/package.json "${release}/services/control-plane/package.json"
sudo rsync -a --delete scripts/ "${release}/scripts/"
sudo chmod 755 "${release}/scripts/"*.sh
sudo rsync -a --delete node_modules/ "${release}/node_modules/"
sudo rsync -a --delete apps/web/dist/ "${release}/web/"
sudo ln -sfn "${release}" "${current_link}"
revision_file="$(mktemp)"
printf 'COD_REVISION=%s\n' "${revision}" > "${revision_file}"
sudo install -o root -g root -m 644 "${revision_file}" /etc/cod/revision.env
rm -f "${revision_file}"
sudo install -o root -g root -m 644 deploy/cod-control-plane.service /etc/systemd/system/cod-control-plane.service
sudo install -o root -g root -m 644 deploy/cod-backup.service /etc/systemd/system/cod-backup.service
sudo install -o root -g root -m 644 deploy/cod-backup.timer /etc/systemd/system/cod-backup.timer
sudo install -o root -g root -m 644 deploy/cod-healthcheck.service /etc/systemd/system/cod-healthcheck.service
sudo install -o root -g root -m 644 deploy/cod-healthcheck.timer /etc/systemd/system/cod-healthcheck.timer
sudo install -o root -g root -m 644 deploy/cod.nginx.conf /etc/nginx/sites-available/cod
sudo install -o root -g root -m 644 deploy/nginx-http.conf /etc/nginx/conf.d/cod-limits.conf
sudo install -d -o postgres -g postgres -m 700 /var/lib/cod/backups
sudo systemctl daemon-reload
sudo nginx -t
sudo systemctl restart cod-control-plane
sudo systemctl reload nginx

ready=false
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8787/ready >/dev/null 2>&1; then ready=true; break; fi
  sleep 0.25
done

if [[ "${ready}" != true ]]; then
  if [[ -n "${previous}" && -d "${previous}" ]]; then
    sudo ln -sfn "${previous}" "${current_link}"
    rollback_revision_file="$(mktemp)"
    printf 'COD_REVISION=%s\n' "${previous_revision}" > "${rollback_revision_file}"
    sudo install -o root -g root -m 644 "${rollback_revision_file}" /etc/cod/revision.env
    rm -f "${rollback_revision_file}"
    sudo systemctl restart cod-control-plane
    sudo systemctl reload nginx
  fi
  sudo journalctl -u cod-control-plane -n 100 --no-pager
  exit 1
fi

sudo systemctl enable --now cod-backup.timer cod-healthcheck.timer

curl -fsS http://127.0.0.1:8787/version
printf '\nrelease=%s\n' "${release}"
