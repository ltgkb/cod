import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import waitOn from 'wait-on';

import { resolveDesktopDevelopmentEndpoints } from '../../../scripts/desktop-dev-config.mjs';

const desktopDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { renderer, controlPlane } = resolveDesktopDevelopmentEndpoints(process.env);

await waitOn({
  resources: [
    `http-get://${controlPlane.host}/ready`,
    `http-get://${renderer.host}/app/`,
  ],
  interval: 200,
  timeout: 30_000,
});

if (process.argv.includes('--smoke')) {
  const capabilitiesResponse = await fetch(new URL('/api/capabilities', renderer));
  if (!capabilitiesResponse.ok) throw new Error(`Renderer proxy returned ${capabilitiesResponse.status} for capabilities`);
  const capabilities = await capabilitiesResponse.json();
  if (capabilities?.authentication?.mode !== 'password' || capabilities?.authentication?.registrationEnabled !== true) {
    throw new Error('Development authentication capabilities are unavailable through the renderer proxy');
  }

  const email = `desktop-smoke-${Date.now()}@example.com`;
  const password = 'DesktopSmoke123';
  const registerResponse = await fetch(new URL('/api/auth/register', renderer), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: renderer.origin },
    body: JSON.stringify({ email, password }),
  });
  if (registerResponse.status !== 201) throw new Error(`Development registration returned ${registerResponse.status}`);

  const loginResponse = await fetch(new URL('/api/auth/login', renderer), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: renderer.origin },
    body: JSON.stringify({ email, password }),
  });
  const login = await loginResponse.json();
  if (!loginResponse.ok || typeof login?.token !== 'string' || login.token.length === 0) {
    throw new Error(`Development login returned ${loginResponse.status}`);
  }
  console.log(`Desktop development smoke check passed via ${renderer.origin} -> ${controlPlane.origin}`);
  process.exit(0);
}

const require = createRequire(import.meta.url);
const electronExecutable = require('electron');
const electron = spawn(electronExecutable, ['.'], {
  cwd: desktopDirectory,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    COD_DEV_SERVER_URL: renderer.origin,
    COD_CONTROL_PLANE_URL: controlPlane.origin,
  },
  stdio: 'inherit',
});

const forwardSignal = (signal) => {
  if (electron.exitCode === null && !electron.killed) electron.kill(signal);
};
process.once('SIGINT', () => forwardSignal('SIGINT'));
process.once('SIGTERM', () => forwardSignal('SIGTERM'));
electron.once('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
electron.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
