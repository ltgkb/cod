#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <backup.dump> <target_database>" >&2
  exit 2
fi

backup="$1"
target_database="$2"
[[ "${target_database}" =~ ^cod_restore_[a-zA-Z0-9_]+$ ]] || { echo "Target must start with cod_restore_" >&2; exit 2; }
[[ -f "${backup}" ]] || { echo "Backup not found" >&2; exit 2; }
[[ -f "${backup}.sha256" ]] && sha256sum --check "${backup}.sha256"

dropdb --if-exists "${target_database}"
createdb "${target_database}"
pg_restore --exit-on-error --no-owner --dbname="${target_database}" "${backup}"
psql --dbname="${target_database}" --tuples-only --no-align --command="SELECT count(*) FROM cod_users;"
