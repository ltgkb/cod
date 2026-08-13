import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { desktopPetCandidates, desktopPetEnvironment, discoverDesktopPet } from '../dist/desktop-pet.js';

test('uses only explicit absolute overrides and known per-platform locations', () => {
  const resourcesPath = '/opt/cod/resources';
  assert.deepEqual(desktopPetCandidates({ platform: 'darwin', homeDirectory: '/Users/kai', resourcesPath, developmentOverride: 'relative.app' }), [
    '/opt/cod/resources/desktop-pet/COD桌宠.app',
    '/Applications/COD桌宠.app',
    '/Users/kai/Applications/COD桌宠.app',
  ]);
  assert.ok(desktopPetCandidates({ platform: 'win32', homeDirectory: 'C:\\Users\\kai', resourcesPath: 'C:\\COD\\resources', environment: { LOCALAPPDATA: 'C:\\Users\\kai\\AppData\\Local' } })
    .some((candidate) => candidate.endsWith('COD-Desktop-Pet.exe')));
  assert.ok(desktopPetCandidates({ platform: 'linux', homeDirectory: '/home/kai', resourcesPath })
    .some((candidate) => candidate.endsWith('.AppImage')));
});

test('passes only an allowlisted process environment and ephemeral chat credentials', () => {
  const result = desktopPetEnvironment({
    HOME: '/home/kai',
    PATH: '/usr/bin',
    AWS_SECRET_ACCESS_KEY: 'must-not-leak',
    COD_DATABASE_URL: 'must-not-leak',
  }, { url: 'http://127.0.0.1:43210/v1/chat/completions', secret: 'ephemeral', model: 'gpt-test' });
  assert.equal(result.HOME, '/home/kai');
  assert.equal(result.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(result.COD_DATABASE_URL, undefined);
  assert.equal(result.COD_CHAT_API_KEY, 'ephemeral');
  assert.equal(result.COD_CHAT_MODEL, 'gpt-test');
});

test('prefers the audited desktop pet bundled inside COD', async () => {
  const resourceAsar = path.resolve('resources/desktop-pet/app.asar');
  const result = await discoverDesktopPet({
    platform: process.platform,
    homeDirectory: os.homedir(),
    resourcesPath: path.dirname(path.dirname(resourceAsar)),
    bundledResourcePath: resourceAsar,
  });
  assert.equal(result.installation?.kind, 'integrated');
  assert.equal(result.installation?.executablePath, resourceAsar);
  assert.equal(result.status.installed, true);
  assert.equal(result.status.verified, true);
  assert.equal(result.status.reason, 'ready');
});

test('rejects a modified bundled desktop pet resource', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cod-integrated-pet-test-'));
  const resourceAsar = path.join(directory, 'app.asar');
  await writeFile(resourceAsar, 'modified desktop pet resource');
  const result = await discoverDesktopPet({
    platform: 'linux',
    homeDirectory: directory,
    resourcesPath: directory,
    bundledResourcePath: resourceAsar,
  });
  assert.equal(result.installation, null);
  assert.equal(result.status.installed, true);
  assert.equal(result.status.verified, false);
  assert.equal(result.status.reason, 'integrity-failed');
});

test('refuses a companion at a known path when its audited hashes do not match', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cod-pet-test-'));
  const executable = path.join(directory, 'cod-desktop-pet');
  await writeFile(executable, 'not the reviewed desktop pet');
  const result = await discoverDesktopPet({
    platform: 'linux',
    homeDirectory: directory,
    resourcesPath: directory,
    developmentOverride: executable,
  });
  assert.equal(result.installation, null);
  assert.equal(result.status.installed, true);
  assert.equal(result.status.verified, false);
  assert.equal(result.status.reason, 'integrity-failed');
});
