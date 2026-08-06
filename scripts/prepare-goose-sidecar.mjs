import { copyFile, chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';

const source = process.env.COD_GOOSE_BINARY;
if (!source) {
  console.error('COD_GOOSE_BINARY must point to a release Goose binary.');
  process.exit(1);
}

const targetDirectory = path.resolve('apps/desktop/resources/bin');
const target = path.join(targetDirectory, process.platform === 'win32' ? 'goose.exe' : 'goose');
await mkdir(targetDirectory, { recursive: true });
await copyFile(source, target);
if (process.platform !== 'win32') await chmod(target, 0o755);
console.log(`Prepared Goose sidecar at ${target}`);
