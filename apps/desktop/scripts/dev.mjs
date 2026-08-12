import concurrently from 'concurrently';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  controlPlanePort,
  resolveDesktopDevelopmentEndpoints,
  resolveDesktopDevelopmentProcessEnvironments,
} from '../../../scripts/desktop-dev-config.mjs';

const desktopDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(desktopDirectory, '../..');
const smoke = process.argv.includes('--smoke');

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to allocate a local development port'));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function developmentEnvironment() {
  if (!smoke) return { ...process.env };
  const [rendererPort, controlPlanePortValue] = await Promise.all([availablePort(), availablePort()]);
  return {
    ...process.env,
    COD_DEV_SERVER_URL: `http://127.0.0.1:${rendererPort}`,
    COD_DEV_CONTROL_PLANE_URL: `http://127.0.0.1:${controlPlanePortValue}`,
  };
}

const baseEnvironment = await developmentEnvironment();
const { renderer, controlPlane } = resolveDesktopDevelopmentEndpoints(baseEnvironment);
const developmentEnvironmentOverrides = {
  ...baseEnvironment,
  COD_DEV_SERVER_URL: renderer.origin,
  COD_DEV_CONTROL_PLANE_URL: controlPlane.origin,
};
const {
  shared: sharedEnvironment,
  controlPlane: controlPlaneEnvironment,
} = resolveDesktopDevelopmentProcessEnvironments(developmentEnvironmentOverrides);

// `concurrently` merges each command environment over its own process.env.
// Sanitize this orchestration process before it can reintroduce isolated
// production configuration into any development child process.
for (const name of Object.keys(process.env)) {
  if (!(name in sharedEnvironment)) delete process.env[name];
}
for (const [name, value] of Object.entries(sharedEnvironment)) process.env[name] = value;

const { result } = concurrently([
  {
    name: 'control-plane',
    command: 'npm run dev -w @cod/control-plane',
    env: {
      ...controlPlaneEnvironment,
      COD_CONTROL_PORT: controlPlanePort(controlPlane),
      // The renderer uses a same-origin Vite proxy, while the control plane
      // retains an exact development-origin allowlist for direct requests.
      COD_ALLOWED_ORIGINS: renderer.origin,
    },
  },
  {
    name: 'renderer',
    command: 'npm run dev -w @cod/web',
    env: sharedEnvironment,
  },
  {
    name: 'desktop',
    command: `node apps/desktop/scripts/launch-dev.mjs${smoke ? ' --smoke' : ''}`,
    env: sharedEnvironment,
  },
], {
  cwd: repositoryRoot,
  prefix: 'name',
  prefixColors: 'auto',
  killOthersOn: ['failure', 'success'],
  successCondition: 'command-desktop',
});

try {
  await result;
} catch (events) {
  const desktop = Array.isArray(events) ? events.find((event) => event.command?.name === 'desktop') : null;
  if (desktop?.exitCode === 0) process.exitCode = 0;
  else process.exitCode = 1;
}
