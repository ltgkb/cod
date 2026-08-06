import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '@cod/contracts';

const bridge: DesktopBridge = {
  platform: process.platform,
  controlPlaneUrl: process.env.COD_CONTROL_PLANE_URL ?? 'http://95.41.23.60',
  selectProject: () => ipcRenderer.invoke('cod:select-project'),
  listFiles: (root) => ipcRenderer.invoke('cod:list-files', root),
  readTextFile: (root, relativePath) => ipcRenderer.invoke('cod:read-text-file', root, relativePath),
  gitDiff: (root) => ipcRenderer.invoke('cod:git-diff', root),
  runCommand: (root, command) => ipcRenderer.invoke('cod:run-command', root, command),
  getGooseAcpUrl: () => ipcRenderer.invoke('cod:get-goose-acp-url'),
};

contextBridge.exposeInMainWorld('codDesktop', bridge);
