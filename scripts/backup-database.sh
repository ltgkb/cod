#!/usr/bin/env bash
set -euo pipefail
umask 077

backup_root="${COD_BACKUP_ROOT:-/var/lib/cod/backups}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="${backup_root}/cod-${timestamp}.dump"
temp="${target}.tmp"

install -d -m 700 "${backup_root}"
pg_dump --format=custom --compress=9 --file="${temp}" cod
pg_restore --list "${temp}" >/dev/null
mv "${temp}" "${target}"
sha256sum "${target}" > "${target}.sha256"
find "${backup_root}" -type f -name 'cod-*.dump' -mtime +14 -delete
find "${backup_root}" -type f -name 'cod-*.dump.sha256' -mtime +14 -delete
printf '%s\n' "${target}"
