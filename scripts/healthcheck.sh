#!/usr/bin/env bash
set -euo pipefail
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8787/health >/dev/null
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8787/ready >/dev/null
curl --fail --silent --show-error --max-time 5 http://127.0.0.1/ >/dev/null
curl --fail --silent --show-error --max-time 5 http://127.0.0.1/app/ >/dev/null
