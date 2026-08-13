import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DesktopPetStatus } from '@cod/contracts';

const desktopPetVersion = '0.7.0';
const desktopPetAsarSha256 = '00f337940b821a05e9bdf33dad3ef1fa83b49313c6a86ca7ece748ab3de51efb';
const desktopPetHashes: Partial<Record<NodeJS.Platform, string>> = {
  darwin: '989179852e8ed2b2642001f1793dae2f5f0eef26dce8de4474d71f56a84700e4',
  win32: '63199769cfaeb23d5a7ac91900184288642dd821b11a1e4f8abc896cd1aa2172',
  linux: '6853bb400e98582dcc104ca8b9e90f013cd2223575253731e0c429925981c733',
};
const linuxAppImageSha256 = '7cb003b999cb00ec9cf3f83450e77100eda22a0c25eda0a6de56531adf2b9695';
// Electron treats every path segment ending in `.asar` as a virtual archive.
// Integrity verification needs the raw archive bytes, so use Electron's
// original-fs in the main process and ordinary Node fs in tests/tooling.
const rawFileSystem = process.versions.electron
  ? createRequire(import.meta.url)('original-fs') as typeof nodeFs
  : nodeFs;
const fs = rawFileSystem.promises;

export interface DesktopPetInstallation {
  rootPath: string;
  executablePath: string;
  kind: 'integrated' | 'bundle' | 'portable' | 'appimage';
}

interface DesktopPetDiscoveryOptions {
  platform: NodeJS.Platform;
  homeDirectory: string;
  resourcesPath: string;
  environment?: NodeJS.ProcessEnv;
  developmentOverride?: string;
  bundledResourcePath?: string;
}

function pathApi(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

function uniqueAbsolutePaths(values: Array<string | undefined>, platform: NodeJS.Platform): string[] {
  const platformPath = pathApi(platform);
  return [...new Set(values.filter((value): value is string => Boolean(value && platformPath.isAbsolute(value))))];
}

export function desktopPetCandidates(options: DesktopPetDiscoveryOptions): string[] {
  const { platform, homeDirectory, resourcesPath, environment = {}, developmentOverride } = options;
  const platformPath = pathApi(platform);
  if (platform === 'darwin') {
    return uniqueAbsolutePaths([
      developmentOverride,
      platformPath.join(resourcesPath, 'desktop-pet', 'COD桌宠.app'),
      '/Applications/COD桌宠.app',
      platformPath.join(homeDirectory, 'Applications', 'COD桌宠.app'),
    ], platform);
  }
  if (platform === 'win32') {
    const localAppData = environment.LOCALAPPDATA || platformPath.join(homeDirectory, 'AppData', 'Local');
    const programFiles = environment.ProgramFiles || environment.PROGRAMFILES;
    return uniqueAbsolutePaths([
      developmentOverride,
      platformPath.join(resourcesPath, 'desktop-pet', 'COD-Desktop-Pet.exe'),
      platformPath.join(localAppData, 'Programs', 'COD Desktop Pet', 'COD-Desktop-Pet.exe'),
      platformPath.join(localAppData, 'Programs', 'cod-desktop-pet', 'COD-Desktop-Pet.exe'),
      programFiles ? platformPath.join(programFiles, 'COD Desktop Pet', 'COD-Desktop-Pet.exe') : undefined,
    ], platform);
  }
  if (platform === 'linux') {
    return uniqueAbsolutePaths([
      developmentOverride,
      platformPath.join(resourcesPath, 'desktop-pet', 'cod-desktop-pet'),
      platformPath.join(homeDirectory, '.local', 'opt', 'cod-desktop-pet', 'cod-desktop-pet'),
      platformPath.join(homeDirectory, 'Applications', `COD-Desktop-Pet-${desktopPetVersion}-linux-x64`, 'cod-desktop-pet'),
      platformPath.join(homeDirectory, 'Applications', `COD-Desktop-Pet-${desktopPetVersion}-linux-x86_64.AppImage`),
      '/opt/cod-desktop-pet/cod-desktop-pet',
      '/opt/COD-Desktop-Pet/cod-desktop-pet',
    ], platform);
  }
  return [];
}

async function sha256(filename: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const digest = createHash('sha256');
    const stream = rawFileSystem.createReadStream(filename);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(digest.digest('hex')));
  });
}

function installationFromCandidate(candidate: string, platform: NodeJS.Platform): DesktopPetInstallation {
  const platformPath = pathApi(platform);
  if (platform === 'darwin') {
    return {
      rootPath: candidate,
      executablePath: platformPath.join(candidate, 'Contents', 'MacOS', 'COD桌宠'),
      kind: 'bundle',
    };
  }
  return {
    rootPath: platformPath.dirname(candidate),
    executablePath: candidate,
    kind: platform === 'linux' && candidate.endsWith('.AppImage') ? 'appimage' : 'portable',
  };
}

async function regularFileWithoutSymlink(filename: string): Promise<boolean> {
  try {
    const stats = await fs.lstat(filename);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch { return false; }
}

async function verifiedInstallation(candidate: string, platform: NodeJS.Platform): Promise<DesktopPetInstallation | null> {
  const installation = installationFromCandidate(candidate, platform);
  if (installation.kind === 'bundle') {
    try {
      const rootStats = await fs.lstat(installation.rootPath);
      if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return null;
    } catch { return null; }
  }
  if (!await regularFileWithoutSymlink(installation.executablePath)) return null;
  const expectedExecutableHash = installation.kind === 'appimage'
    ? linuxAppImageSha256
    : desktopPetHashes[platform];
  if (!expectedExecutableHash || await sha256(installation.executablePath) !== expectedExecutableHash) return null;
  if (installation.kind !== 'appimage') {
    const asarPath = installation.kind === 'bundle'
      ? path.join(installation.rootPath, 'Contents', 'Resources', 'app.asar')
      : path.join(installation.rootPath, 'resources', 'app.asar');
    if (!await regularFileWithoutSymlink(asarPath) || await sha256(asarPath) !== desktopPetAsarSha256) return null;
  }
  return installation;
}

async function verifiedBundledResource(candidate: string | undefined): Promise<DesktopPetInstallation | null> {
  if (!candidate || !path.isAbsolute(candidate) || !await regularFileWithoutSymlink(candidate)) return null;
  if (await sha256(candidate) !== desktopPetAsarSha256) return null;
  return {
    rootPath: path.dirname(candidate),
    executablePath: candidate,
    kind: 'integrated',
  };
}

export async function discoverDesktopPet(options: DesktopPetDiscoveryOptions): Promise<{
  installation: DesktopPetInstallation | null;
  status: DesktopPetStatus;
}> {
  const bundledResourcePath = options.bundledResourcePath ?? path.join(options.resourcesPath, 'desktop-pet', 'app.asar');
  const bundledInstallation = await verifiedBundledResource(bundledResourcePath);
  if (bundledInstallation) {
    return {
      installation: bundledInstallation,
      status: {
        supported: true,
        installed: true,
        verified: true,
        running: false,
        version: desktopPetVersion,
        publisherVerified: false,
        reason: 'ready',
      },
    };
  }
  let bundledResourceFound = false;
  try { bundledResourceFound = (await fs.lstat(bundledResourcePath)).isFile(); } catch { /* Optional on older builds. */ }
  const candidates = desktopPetCandidates(options);
  let unverifiedFound = bundledResourceFound;
  for (const candidate of candidates) {
    try {
      await fs.lstat(candidate);
      const installation = await verifiedInstallation(candidate, options.platform);
      if (installation) {
        return {
          installation,
          status: {
            supported: true,
            installed: true,
            verified: true,
            running: false,
            version: desktopPetVersion,
            publisherVerified: false,
            reason: 'ready',
          },
        };
      }
      unverifiedFound = true;
    } catch { /* Continue through known installation locations. */ }
  }
  const supported = ['darwin', 'win32', 'linux'].includes(options.platform);
  return {
    installation: null,
    status: {
      supported,
      installed: unverifiedFound,
      verified: false,
      running: false,
      version: unverifiedFound ? null : desktopPetVersion,
      publisherVerified: false,
      reason: !supported ? 'unsupported' : unverifiedFound ? 'integrity-failed' : 'not-installed',
    },
  };
}

export function desktopPetEnvironment(environment: NodeJS.ProcessEnv, chat: {
  url: string;
  secret: string;
  model: string;
}): NodeJS.ProcessEnv {
  const allowedNames = new Set([
    'APPDATA', 'COLORTERM', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'LOCALAPPDATA', 'PATH', 'Path', 'SHELL', 'SystemDrive', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR',
    'USER', 'USERNAME', 'USERPROFILE', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_CONFIG_HOME', 'XDG_CURRENT_DESKTOP',
    'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE',
  ]);
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (allowedNames.has(name) && typeof value === 'string') result[name] = value;
  }
  return {
    ...result,
    COD_CHAT_API_URL: chat.url,
    COD_CHAT_API_KEY: chat.secret,
    COD_CHAT_MODEL: chat.model,
  };
}

export const desktopPetAudit = Object.freeze({
  version: desktopPetVersion,
  asarSha256: desktopPetAsarSha256,
  publisherVerified: false,
});
