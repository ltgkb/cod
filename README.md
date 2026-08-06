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
- When KAI model or Wiki credentials are absent, the account panel and responses explicitly identify demo mode. Demo data is never presented as a live integration.
- The packaged desktop receives its control-plane URL through `COD_CONTROL_PLANE_URL` and defaults to the current pilot server.

## Production configuration

The control plane requires PostgreSQL and a pilot access-code hash in production. Generate the hash without storing the plaintext code in Git:

```bash
printf %s 'your-access-code' | sha256sum
```

Configure `COD_PILOT_ACCESS_CODE_HASH` in the root-only `/etc/cod/control-plane.env`. Safe, versioned runtime flags live in `deploy/runtime.env`; secrets do not.

See `FUNCTION_AUDIT.md` for the verified internal scope and the external integrations that still require provider contracts or credentials.
