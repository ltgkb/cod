import { chmod, copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expectedGoosePackage, resolveSidecarTarget, validateGooseBinary } from './sidecar-target.mjs';

const require = createRequire(import.meta.url);
const target = resolveSidecarTarget(process.argv.slice(2));
const packageName = expectedGoosePackage(target);
let source = process.env.COD_GOOSE_BINARY;
if (!source) {
  try {
    const packagePath = require.resolve(`${packageName}/package.json`);
    source = path.join(path.dirname(packagePath), 'bin', target.platform === 'win32' ? 'goose.exe' : 'goose');
  } catch {
    throw new Error(
      `${packageName} is not installed on this build host. Build on ${target.suffix}, or provide a verified ${target.suffix} binary through COD_GOOSE_BINARY.`,
    );
  }
}
source = path.resolve(source);
await validateGooseBinary(source, target);

const desktopDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetDirectory = path.join(desktopDirectory, 'resources', 'bin');
const targetName = target.platform === 'win32' ? 'goose.exe' : 'goose';
const destination = path.join(targetDirectory, targetName);
const temporary = `${destination}.${process.pid}.tmp`;
await mkdir(targetDirectory, { recursive: true });
try {
  await copyFile(source, temporary);
  if (target.platform !== 'win32') await chmod(temporary, 0o755);
  await rm(destination, { force: true });
  await rename(temporary, destination);
  await rm(path.join(targetDirectory, target.platform === 'win32' ? 'goose' : 'goose.exe'), { force: true });
} catch (error) {
  await rm(temporary, { force: true }).catch(() => undefined);
  throw error;
}
console.log(`Prepared verified ${target.suffix} Goose sidecar at ${destination}`);
