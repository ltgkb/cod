# COD

COD is a cross-platform agent workspace for code optimization and everyday AI conversations.

## Architecture

- `apps/web`: shared React product UI for desktop, web, and the future PWA.
- `apps/desktop`: Electron shell with local project, file, diff, and terminal access.
- `packages/contracts`: shared types for the control plane and integrations.
- `distribution`: COD branding, provider defaults, and packaging metadata.
- Goose runs as the local ACP execution sidecar and remains independently upgradeable.

## Development

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run build
```

## Product behavior

- Web and desktop clients use a pilot access-code login and retain the signed session on the current device.
- Tasks, devices, status transitions, wallet entries, and audit records come from the control plane; the UI does not render static task or terminal-success fixtures.
- The Web client can create, search, synchronize, execute, retry, and complete tasks. Local files, Git Diff, terminal commands, and Goose execution are available only through the desktop bridge.
- Model sources are discovered from their live catalogs. The selected source controls the model list, upstream route, displayed price, wallet settlement, and ledger payment direction.
- `ai.kai.com` can run as a live OpenAI-compatible source. `chase.kai.com` is included as a catalog-only example until its own key is configured; catalog-only sources cannot execute prompts.
- The pilot wallet supports explicitly labelled test-credit preloads. Real payment acquisition and provider settlement remain disabled until payment contracts and callbacks are configured.
- The packaged desktop receives its control-plane URL through `COD_CONTROL_PLANE_URL` and defaults to the current pilot server.

## Production configuration

The control plane requires PostgreSQL and a pilot access-code hash in production. Generate the hash without storing the plaintext code in Git:

```bash
printf %s 'your-access-code' | sha256sum
```

Configure `COD_PILOT_ACCESS_CODE_HASH` in the root-only `/etc/cod/control-plane.env`. Safe, versioned runtime flags live in `deploy/runtime.env`; secrets do not.

Configure model source keys only in `/etc/cod/control-plane.env`, for example `KAI_API_KEY`. Additional sources can be supplied with `COD_MODEL_SOURCES_JSON`; each entry names an `apiKeyEnv`, so credentials stay outside the JSON and Git.

See `FUNCTION_AUDIT.md` for the verified internal scope and the external integrations that still require provider contracts or credentials.
