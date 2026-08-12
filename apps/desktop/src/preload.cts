import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '@cod/contracts';

const controlPlaneArgumentPrefix = '--cod-control-plane-url=';
const controlPlaneArguments = process.argv.filter((argument: string) => argument.startsWith(controlPlaneArgumentPrefix));
const controlPlaneArgument = controlPlaneArguments[controlPlaneArguments.length - 1];
const controlPlaneUrl = controlPlaneArgument
  ? decodeURIComponent(controlPlaneArgument.slice(controlPlaneArgumentPrefix.length))
  : '';
let parsedControlPlane: URL | null = null;
try { parsedControlPlane = new URL(controlPlaneUrl); } catch { /* Rejected below. */ }
if (!parsedControlPlane
  || parsedControlPlane.origin !== controlPlaneUrl
  || (parsedControlPlane.protocol !== 'https:'
    && !(parsedControlPlane.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsedControlPlane.hostname)))) {
  throw new Error('COD Desktop did not provide a valid control-plane URL');
}

const bridge: DesktopBridge = {
  platform: process.platform,
  controlPlaneUrl,
  selectProject: () => ipcRenderer.invoke('cod:select-project'),
  listFiles: (root) => ipcRenderer.invoke('cod:list-files', root),
  readTextFile: (root, relativePath) => ipcRenderer.invoke('cod:read-text-file', root, relativePath),
  gitDiff: (root) => ipcRenderer.invoke('cod:git-diff', root),
  runCommand: (root, command) => ipcRenderer.invoke('cod:run-command', root, command),
  getGooseAcpUrl: (config) => ipcRenderer.invoke('cod:get-goose-acp-url', config),
  stopGoose: () => ipcRenderer.invoke('cod:stop-goose'),
  getTaskboardUrl: () => ipcRenderer.invoke('cod:get-taskboard-url'),
  getDesktopPetStatus: () => ipcRenderer.invoke('cod:get-desktop-pet-status'),
  launchDesktopPet: (config) => ipcRenderer.invoke('cod:launch-desktop-pet', config),
  stopDesktopPet: () => ipcRenderer.invoke('cod:stop-desktop-pet'),
};

contextBridge.exposeInMainWorld('codDesktop', bridge);
