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

The first-stage UI uses a local demo transport when an ACP endpoint is not configured. This keeps visual and desktop-shell development independent from commercial API credentials.
