import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('responsive workspace styles', () => {
  it('wraps the context actions when the workspace container is narrow', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
    const containerStart = css.indexOf('@container (max-width: 760px)');
    const nextViewportRule = css.indexOf('@media (max-width: 920px)', containerStart);

    expect(containerStart).toBeGreaterThanOrEqual(0);
    expect(nextViewportRule).toBeGreaterThan(containerStart);
    expect(css.slice(containerStart, nextViewportRule)).toMatch(
      /\.context-strip\s*\{[^}]*flex-wrap:\s*wrap;[^}]*overflow-x:\s*visible;/,
    );
  });
});
