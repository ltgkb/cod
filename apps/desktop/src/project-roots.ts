import { promises as fs } from 'node:fs';
import path from 'node:path';

export const maximumApprovedProjectRoots = 20;

interface ProjectRootsFile {
  version: 1;
  roots: string[];
}

function limitedUniqueRoots(roots: Iterable<string>, maximum: number): string[] {
  const unique = [...new Set([...roots].filter((root) => typeof root === 'string'
    && root.length > 0
    && root.length <= 4_096
    && path.isAbsolute(root)))];
  return unique.slice(-maximum);
}

export async function loadApprovedProjectRoots(filePath: string, maximum = maximumApprovedProjectRoots): Promise<string[]> {
  try {
    const fileStats = await fs.stat(filePath);
    if (!fileStats.isFile() || fileStats.size > 128 * 1024) return [];
    if (process.platform !== 'win32') await fs.chmod(filePath, 0o600);
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as Partial<ProjectRootsFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.roots)) return [];
    const restored: string[] = [];
    for (const savedRoot of limitedUniqueRoots(parsed.roots, maximum)) {
      try {
        const realRoot = await fs.realpath(savedRoot);
        const stats = await fs.stat(realRoot);
        if (stats.isDirectory() && !restored.includes(realRoot)) restored.push(realRoot);
      } catch {
        // Missing, moved, or inaccessible projects are not re-approved.
      }
    }
    return restored;
  } catch {
    return [];
  }
}

export async function saveApprovedProjectRoots(
  filePath: string,
  roots: Iterable<string>,
  maximum = maximumApprovedProjectRoots,
): Promise<void> {
  const payload: ProjectRootsFile = { version: 1, roots: limitedUniqueRoots(roots, maximum) };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (process.platform !== 'win32') await fs.chmod(temporaryPath, 0o600);
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
