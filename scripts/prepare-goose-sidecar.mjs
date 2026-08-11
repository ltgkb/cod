import { access, copyFile, chmod, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageSuffix = process.platform === 'win32'
  ? process.arch === 'x64' ? 'win32-x64' : null
  : (process.platform === 'darwin' || process.platform === 'linux') && (process.arch === 'arm64' || process.arch === 'x64')
    ? `${process.platform}-${process.arch}`
    : null;

let source = process.env.COD_GOOSE_BINARY;
if (!source && packageSuffix) {
  try {
    const packagePath = require.resolve(`@aaif/goose-binary-${packageSuffix}/package.json`);
    source = path.join(path.dirname(packagePath), 'bin', process.platform === 'win32' ? 'goose.exe' : 'goose');
  } catch {
    // Report one actionable error below.
  }
}
if (!source) throw new Error(`No Goose sidecar is available for ${process.platform}-${process.arch}. Set COD_GOOSE_BINARY to a release binary.`);
await access(source);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetDirectory = path.join(repositoryRoot, 'apps', 'desktop', 'resources', 'bin');
const target = path.join(targetDirectory, process.platform === 'win32' ? 'goose.exe' : 'goose');
await mkdir(targetDirectory, { recursive: true });
await copyFile(source, target);
if (process.platform !== 'win32') await chmod(target, 0o755);
console.log(`Prepared Goose sidecar at ${target}`);
