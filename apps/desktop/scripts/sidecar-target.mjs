import { open, stat } from 'node:fs/promises';

const supportedPlatforms = new Set(['darwin', 'linux', 'win32']);
const supportedArchitectures = new Set(['arm64', 'x64']);

export function resolveSidecarTarget(argumentsList, host = { platform: process.platform, arch: process.arch }) {
  const option = (name) => {
    const prefix = `--${name}=`;
    return argumentsList.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  };
  const platform = option('platform') || host.platform;
  const arch = option('arch') || host.arch;
  if (!supportedPlatforms.has(platform) || !supportedArchitectures.has(arch) || (platform === 'win32' && arch !== 'x64')) {
    throw new Error(`No Goose sidecar target is supported for ${platform}-${arch}`);
  }
  return Object.freeze({ platform, arch, suffix: `${platform}-${arch}` });
}

export function expectedGoosePackage(target) {
  return `@aaif/goose-binary-${target.suffix}`;
}

export function detectGooseBinaryTarget(header) {
  if (header.length >= 20 && header[0] === 0x7f && header.subarray(1, 4).toString('ascii') === 'ELF') {
    if (header[5] !== 1) return null;
    const machine = header.readUInt16LE(18);
    if (machine === 0x3e) return { platform: 'linux', arch: 'x64' };
    if (machine === 0xb7) return { platform: 'linux', arch: 'arm64' };
    return null;
  }

  if (header.length >= 8 && header.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = header.readUInt32LE(4);
    if (cpu === 0x01000007) return { platform: 'darwin', arch: 'x64' };
    if (cpu === 0x0100000c) return { platform: 'darwin', arch: 'arm64' };
    return null;
  }

  if (header.length >= 64 && header[0] === 0x4d && header[1] === 0x5a) {
    const peOffset = header.readUInt32LE(0x3c);
    if (peOffset + 6 > header.length || header.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return null;
    const machine = header.readUInt16LE(peOffset + 4);
    if (machine === 0x8664) return { platform: 'win32', arch: 'x64' };
    return null;
  }
  return null;
}

export async function validateGooseBinary(source, target) {
  const details = await stat(source);
  if (!details.isFile() || details.size < 1024 * 1024) {
    throw new Error(`Goose sidecar is missing or unexpectedly small: ${source}`);
  }
  const handle = await open(source, 'r');
  try {
    const header = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const detected = detectGooseBinaryTarget(header.subarray(0, bytesRead));
    if (!detected || detected.platform !== target.platform || detected.arch !== target.arch) {
      const actual = detected ? `${detected.platform}-${detected.arch}` : 'an unknown binary format';
      throw new Error(`Goose sidecar target mismatch: expected ${target.suffix}, received ${actual}`);
    }
  } finally {
    await handle.close();
  }
}
