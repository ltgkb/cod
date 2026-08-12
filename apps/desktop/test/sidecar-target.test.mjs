import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectGooseBinaryTarget,
  expectedGoosePackage,
  resolveSidecarTarget,
} from '../scripts/sidecar-target.mjs';

test('resolves explicit build targets instead of silently using the host binary', () => {
  assert.deepEqual(resolveSidecarTarget(['--platform=linux', '--arch=arm64'], { platform: 'darwin', arch: 'arm64' }), {
    platform: 'linux', arch: 'arm64', suffix: 'linux-arm64',
  });
  assert.equal(expectedGoosePackage(resolveSidecarTarget(['--platform=win32', '--arch=x64'])), '@aaif/goose-binary-win32-x64');
  assert.throws(() => resolveSidecarTarget(['--platform=win32', '--arch=arm64']), /No Goose sidecar target/);
});

test('detects Mach-O, ELF, and PE target architectures from executable headers', () => {
  const mach = Buffer.alloc(64);
  mach.writeUInt32LE(0xfeedfacf, 0);
  mach.writeUInt32LE(0x0100000c, 4);
  assert.deepEqual(detectGooseBinaryTarget(mach), { platform: 'darwin', arch: 'arm64' });

  const elf = Buffer.alloc(64);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  elf.writeUInt16LE(0x3e, 18);
  assert.deepEqual(detectGooseBinaryTarget(elf), { platform: 'linux', arch: 'x64' });

  const pe = Buffer.alloc(256);
  pe.set([0x4d, 0x5a]);
  pe.writeUInt32LE(128, 0x3c);
  pe.write('PE\0\0', 128, 'ascii');
  pe.writeUInt16LE(0x8664, 132);
  assert.deepEqual(detectGooseBinaryTarget(pe), { platform: 'win32', arch: 'x64' });
  assert.equal(detectGooseBinaryTarget(Buffer.from('not executable')), null);
});
