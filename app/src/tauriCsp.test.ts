import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type TauriConfig = {
  app?: {
    security?: {
      csp?: string;
    };
  };
};

function directiveSources(csp: string, directive: string): string[] {
  const policy = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.split(/\s+/, 1)[0] === directive);
  return policy ? policy.split(/\s+/).slice(1) : [];
}

describe('桌面 WebView CSP', () => {
  it('允许 WaveSurfer 以 fetch 读取本地音频 Blob URL', () => {
    const config = JSON.parse(
      readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
    ) as TauriConfig;
    const csp = config.app?.security?.csp;

    expect(csp).toBeTruthy();
    expect(directiveSources(csp ?? '', 'connect-src')).toContain('blob:');
    expect(directiveSources(csp ?? '', 'media-src')).toContain('blob:');
  });
});
