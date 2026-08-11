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

  it('fits the mobile workspace to its WebView when the software keyboard resizes it', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
    const mobileStart = css.indexOf('@media (max-width: 920px)');
    const nextViewportRule = css.indexOf('@media (max-width: 600px)', mobileStart);
    const mobileCss = css.slice(mobileStart, nextViewportRule);

    expect(mobileStart).toBeGreaterThanOrEqual(0);
    expect(nextViewportRule).toBeGreaterThan(mobileStart);
    expect(mobileCss).toMatch(/html\[data-cod-host-platform\][^{]*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;/);
    expect(mobileCss).toMatch(/html\[data-cod-host-platform\] body\s*\{[^}]*overflow:\s*hidden;/);
    expect(mobileCss).toMatch(/html\[data-cod-host-platform\] \.app-shell\s*\{[^}]*min-height:\s*0;[^}]*height:\s*100%;/);
    expect(mobileCss).toMatch(/html\[data-cod-host-platform\] \.workspace\s*\{[^}]*min-height:\s*0;/);
  });
});
