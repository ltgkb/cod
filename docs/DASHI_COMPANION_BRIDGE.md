# Dashi Taskboard companion bridge

COD Desktop integrates Dashi Taskboard as an optional local companion while the license-safe native taskboard described in `DASHI_TASKBOARD_INTEGRATION.md` is implemented. The Desktop shell discovers a live loopback URL, exposes only that validated URL to the renderer, and opens the board in a sandboxed iframe.

The upstream repository currently has no `LICENSE` file. COD therefore does not copy, bundle, redistribute, or deploy its source or release artifacts. The companion remains independently installed and upgradeable. This bridge is transitional and is not a native schema merge.

## Local setup

```bash
git clone https://github.com/chuspeeism/dashi-taskboard.git ~/.codex/dashi-taskboard
cd ~/.codex/dashi-taskboard
npm ci
npm run build
CODEX_TASKBOARD_HOST=127.0.0.1 \
CODEX_TASKBOARD_RUNTIME_FILE="$HOME/.codex/dashi-taskboard/.data/runtime.json" \
npm run codex
```

The **任务看板** entry appears whenever the companion is reachable. COD checks at startup, every 15 seconds, and when its window regains focus, so either application may start first. The entry is hidden in web/mobile builds and removed if the companion stops.

`COD_TASKBOARD_URL` may specify another loopback port or authenticated path. Only credential-free `http://127.0.0.1`, `http://localhost`, and `http://[::1]` URLs are accepted. `COD_TASKBOARD_RUNTIME_FILE` must be an absolute path.

## Boundary

- Dashi retains its own SQLite/cloud data and workflow semantics.
- COD retains its task, device, agent, wallet, and billing records as authoritative.
- The iframe receives no COD session token and cannot navigate the COD top-level window.
- Native schema merging remains blocked until an explicit mapping, idempotent migration, and upstream redistribution license exist.
