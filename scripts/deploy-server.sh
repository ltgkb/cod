#!/usr/bin/env bash
set -euo pipefail

project_root="${COD_PROJECT_ROOT:-/home/ubuntu/cod-project/cod}"
release_root="${COD_RELEASE_ROOT:-/opt/cod/releases}"
current_link="${COD_CURRENT_LINK:-/opt/cod/current}"
if [[ -n "$(git -C "${project_root}" status --porcelain --untracked-files=normal)" ]]; then
  echo "Refusing to deploy a dirty worktree; commit or remove all changes first" >&2
  exit 1
fi
revision="$(git -C "${project_root}" rev-parse --short=12 HEAD)"
release="${release_root}/${revision}"
release_staging="${release}.staging"
previous="$(readlink -f "${current_link}" 2>/dev/null || true)"
previous_revision="$(basename "${previous}" 2>/dev/null || true)"
activated=false
configuration_backup=""
configuration_targets=(
  /etc/systemd/system/cod-control-plane.service
  /etc/systemd/system/cod-backup.service
  /etc/systemd/system/cod-backup.timer
  /etc/systemd/system/cod-healthcheck.service
  /etc/systemd/system/cod-healthcheck.timer
  /etc/cod/runtime.env
  /etc/nginx/sites-available/cod
  /etc/nginx/conf.d/cod-limits.conf
)

backup_configuration() {
  configuration_backup="$(mktemp -d)"
  local index target
  for index in "${!configuration_targets[@]}"; do
    target="${configuration_targets[$index]}"
    if sudo test -e "${target}"; then
      sudo cp -a -- "${target}" "${configuration_backup}/${index}"
    else
      touch "${configuration_backup}/${index}.missing"
    fi
  done
}

restore_configuration() {
  [[ -n "${configuration_backup}" && -d "${configuration_backup}" ]] || return 0
  local index target
  for index in "${!configuration_targets[@]}"; do
    target="${configuration_targets[$index]}"
    if [[ -f "${configuration_backup}/${index}.missing" ]]; then
      sudo rm -f -- "${target}"
    else
      sudo cp -a -- "${configuration_backup}/${index}" "${target}"
    fi
  done
}

cleanup_configuration_backup() {
  if [[ -n "${configuration_backup}" && -d "${configuration_backup}" ]]; then
    sudo rm -rf --one-file-system -- "${configuration_backup}"
  fi
}

trap cleanup_configuration_backup EXIT

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
  restore_configuration
  sudo systemctl daemon-reload
  if [[ "${activated}" == true && -n "${previous}" && -d "${previous}" ]]; then
    echo "Release activation failed; rolling back to ${previous}" >&2
    sudo ln -sfn "${previous}" "${current_link}"
    write_revision "${previous_revision}"
    sudo systemctl restart cod-control-plane
  fi
  sudo nginx -t
  sudo systemctl reload nginx
  sudo journalctl -u cod-control-plane -n 100 --no-pager >&2
  exit "${exit_code}"
}

source /home/ubuntu/cod-project/upstream/goose/bin/activate-hermit
cd "${project_root}"
node_binary="$(node -p 'process.execPath')"
[[ -x "${node_binary}" ]] || { echo "Node runtime is unavailable" >&2; exit 1; }
node_version="$(node -p 'process.versions.node')"
if ! isolated_node_version="$(env -i HOME=/nonexistent PATH=/usr/bin:/bin "${node_binary}" -p 'process.versions.node' 2>/dev/null)" || [[ "${isolated_node_version}" != "${node_version}" ]]; then
  echo "Resolved Node runtime is not self-contained" >&2
  exit 1
fi
npm ci
node --test scripts/check-npm-audit.test.mjs
node scripts/check-npm-audit.mjs
npm run typecheck
npm test
npm run lint
npm run build
# This release contains only the Web client and control plane. Keep the server
# gate scoped to those deployable workspaces so native Expo build tooling does
# not block an otherwise unaffected server rollout.
npm audit --workspace @cod/web --workspace @cod/control-plane --audit-level=high

sudo install -d -m 755 "${release_root}"
if ! getent group cod >/dev/null; then
  sudo groupadd --system cod
fi
if ! getent passwd cod >/dev/null; then
  sudo useradd --system --gid cod --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin cod
fi

release_complete=false
release_integrity_violation=""
if [[ -x "${release}/bin/node" && -f "${release}/start.mjs" && -f "${release}/web/index.html" && -f "${release}/web/app/index.html" ]] &&
  release_integrity_violation="$(sudo find "${release}" \( ! -user root -o ! -group root -o -perm /022 \) -print -quit)" &&
  [[ -z "${release_integrity_violation}" ]] &&
  existing_node_version="$(sudo -u cod -- env -i HOME=/nonexistent PATH=/usr/bin:/bin "${release}/bin/node" -p 'process.versions.node' 2>/dev/null)" &&
  [[ "${existing_node_version}" == "${node_version}" ]]; then
  release_complete=true
fi

if [[ "${release}" == "${previous}" && "${release_complete}" == true ]]; then
  curl -fsS http://127.0.0.1:8787/ready >/dev/null
  curl -fsS http://127.0.0.1:8787/version
  printf '\nrelease=%s (already active)\n' "${release}"
  trap - ERR
  exit 0
fi

if [[ "${release_complete}" != true ]]; then
  if [[ "${release}" == "${previous}" ]]; then
    echo "Current release is incomplete; refusing to overwrite it in place" >&2
    exit 1
  fi
  sudo rm -rf --one-file-system "${release}" "${release_staging}"
  sudo install -d -m 755 "${release_staging}" "${release_staging}/bin" "${release_staging}/scripts" "${release_staging}/web"
  ./node_modules/.bin/esbuild services/control-plane/dist/server.js --bundle --platform=node --format=esm --target=node22 \
    --banner:js='import { createRequire as __codCreateRequire } from "node:module"; const require = __codCreateRequire(import.meta.url);' \
    --outfile="/tmp/cod-server-${revision}.mjs"
  sudo install -m 644 "/tmp/cod-server-${revision}.mjs" "${release_staging}/start.mjs"
  sudo install -o root -g root -m 755 "${node_binary}" "${release_staging}/bin/node"
  if ! staged_node_version="$(sudo -u cod -- env -i HOME=/nonexistent PATH=/usr/bin:/bin "${release_staging}/bin/node" -p 'process.versions.node' 2>/dev/null)" || [[ "${staged_node_version}" != "${node_version}" ]]; then
    echo "Staged Node runtime is not self-contained" >&2
    exit 1
  fi
  rm -f "/tmp/cod-server-${revision}.mjs"
  sudo rsync -a --delete scripts/ "${release_staging}/scripts/"
  sudo chmod 755 "${release_staging}/scripts/"*.sh
  sudo rsync -a --delete apps/web/dist/ "${release_staging}/web/"
  sudo chown -R root:root "${release_staging}"
  sudo chmod -R go-w "${release_staging}"
  if sudo find "${release_staging}" \( ! -user root -o ! -group root -o -perm /022 \) -print -quit | grep -q .; then
    echo "Release staging contains mutable or non-root-owned files" >&2
    exit 1
  fi
  sudo mv "${release_staging}" "${release}"
fi
backup_configuration
trap rollback ERR
sudo install -o root -g root -m 644 deploy/cod-control-plane.service /etc/systemd/system/cod-control-plane.service
sudo install -o root -g root -m 644 deploy/cod-backup.service /etc/systemd/system/cod-backup.service
sudo install -o root -g root -m 644 deploy/cod-backup.timer /etc/systemd/system/cod-backup.timer
sudo install -o root -g root -m 644 deploy/cod-healthcheck.service /etc/systemd/system/cod-healthcheck.service
sudo install -o root -g root -m 644 deploy/cod-healthcheck.timer /etc/systemd/system/cod-healthcheck.timer
sudo install -o root -g root -m 600 deploy/runtime.env /etc/cod/runtime.env
sudo install -o root -g root -m 644 deploy/cod.nginx.conf /etc/nginx/sites-available/cod
sudo install -o root -g root -m 644 deploy/nginx-http.conf /etc/nginx/conf.d/cod-limits.conf
sudo install -d -o postgres -g postgres -m 700 /var/lib/cod/backups
sudo systemctl daemon-reload
sudo nginx -t
sudo ln -sfn "${release}" "${current_link}"
activated=true
write_revision "${revision}"
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

main_pid="$(systemctl show --property=MainPID --value cod-control-plane)"
if [[ ! "${main_pid}" =~ ^[1-9][0-9]*$ ]] || ! sudo grep -zqx 'NODE_ENV=production' "/proc/${main_pid}/environ"; then
  echo "Control plane is not running with NODE_ENV=production" >&2
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
