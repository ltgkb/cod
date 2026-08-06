#!/usr/bin/env bash
set -euo pipefail

project_root="${COD_PROJECT_ROOT:-/home/ubuntu/cod-project/cod}"
release_root="${COD_RELEASE_ROOT:-/opt/cod/releases}"
current_link="${COD_CURRENT_LINK:-/opt/cod/current}"
revision="$(git -C "${project_root}" rev-parse --short=12 HEAD)"
release="${release_root}/${revision}"
release_staging="${release}.staging"
previous="$(readlink -f "${current_link}" 2>/dev/null || true)"
previous_revision="$(basename "${previous}" 2>/dev/null || true)"
activated=false

write_revision() {
  local value="$1"
  local revision_file
  revision_file="$(mktemp)"
  printf 'COD_REVISION=%s\n' "${value}" > "${revision_file}"
  sudo install -o root -g root -m 644 "${revision_file}" /etc/cod/revision.env
  rm -f "${revision_file}"
}

rollback() {
  local exit_code=$?
  trap - ERR
  set +e
  if [[ "${activated}" == true && -n "${previous}" && -d "${previous}" ]]; then
    echo "Release activation failed; rolling back to ${previous}" >&2
    sudo ln -sfn "${previous}" "${current_link}"
    write_revision "${previous_revision}"
    sudo systemctl daemon-reload
    sudo systemctl restart cod-control-plane
    sudo systemctl reload nginx
  fi
  sudo journalctl -u cod-control-plane -n 100 --no-pager >&2
  exit "${exit_code}"
}

trap rollback ERR

source /home/ubuntu/cod-project/upstream/goose/bin/activate-hermit
cd "${project_root}"
npm ci
npm run typecheck
npm test
npm run lint
npm run build
npm audit --audit-level=high

sudo install -d -m 755 "${release_root}"
if [[ ! -f "${release}/start.mjs" || ! -f "${release}/web/index.html" ]]; then
  if [[ "${release}" == "${previous}" ]]; then
    echo "Current release is incomplete; refusing to overwrite it in place" >&2
    exit 1
  fi
  sudo rm -rf --one-file-system "${release}" "${release_staging}"
  sudo install -d -m 755 "${release_staging}" "${release_staging}/scripts" "${release_staging}/web"
  ./node_modules/.bin/esbuild services/control-plane/dist/server.js --bundle --platform=node --format=esm --target=node22 \
    --banner:js='import { createRequire as __codCreateRequire } from "node:module"; const require = __codCreateRequire(import.meta.url);' \
    --outfile="/tmp/cod-server-${revision}.mjs"
  sudo install -m 644 "/tmp/cod-server-${revision}.mjs" "${release_staging}/start.mjs"
  rm -f "/tmp/cod-server-${revision}.mjs"
  sudo rsync -a --delete scripts/ "${release_staging}/scripts/"
  sudo chmod 755 "${release_staging}/scripts/"*.sh
  sudo rsync -a --delete apps/web/dist/ "${release_staging}/web/"
  sudo mv "${release_staging}" "${release}"
fi
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
sudo ln -sfn "${release}" "${current_link}"
write_revision "${revision}"
activated=true
sudo systemctl restart cod-control-plane
sudo systemctl reload nginx

if [[ "${COD_DEPLOY_TEST_FAILURE_AFTER_ACTIVATE:-false}" == true ]]; then
  false
fi

ready=false
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8787/ready >/dev/null 2>&1; then ready=true; break; fi
  sleep 0.25
done

if [[ "${ready}" != true ]]; then
  false
fi

sudo systemctl enable --now cod-backup.timer cod-healthcheck.timer

mapfile -t stale_releases < <(find "${release_root}" -mindepth 1 -maxdepth 1 -type d ! -name '*.staging' -printf '%T@ %p\n' | sort -nr | tail -n +6 | cut -d' ' -f2-)
for stale_release in "${stale_releases[@]}"; do
  if [[ "${stale_release}" != "$(readlink -f "${current_link}")" && "${stale_release}" != "${previous}" ]]; then
    sudo rm -rf --one-file-system "${stale_release}"
  fi
done
sudo find "${release_root}" -mindepth 1 -maxdepth 1 -type d -name '*.staging' -mmin +60 -exec rm -rf --one-file-system {} +

curl -fsS http://127.0.0.1:8787/version
printf '\nrelease=%s\n' "${release}"
trap - ERR
