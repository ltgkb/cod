export function shouldObscureWorkspace(appState: string | null | undefined): boolean {
  return appState !== 'active';
}
