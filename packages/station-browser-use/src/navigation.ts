import { BrowserUseError } from './browser.js';
/** Page destinations are web URLs. Local/browser-internal schemes never enter the browser. */
export function navigationUrl(value: string): string {
  if (value === 'about:blank') return value;
  let url: URL;
  try { url = new URL(value); } catch { throw new BrowserUseError('invalid_input', 'Navigation requires an absolute HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new BrowserUseError('invalid_input', 'Only HTTP(S) navigation and about:blank are allowed.');
  return url.href;
}
export function permittedDocument(value: string): boolean {
  if (value === 'about:srcdoc' || value === 'chrome-error://chromewebdata/') return true;
  try { navigationUrl(value); return true; } catch { return false; }
}
/** Chromium receives a fresh, minimal environment, never the worker's credentials. */
export function browserEnvironment(privateDirectory: string): Record<string, string> {
  return {
    PATH: process.platform === 'win32' ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32` : '/usr/local/bin:/usr/bin:/bin',
    HOME: privateDirectory, TMPDIR: privateDirectory, TMP: privateDirectory, TEMP: privateDirectory,
    LANG: 'C.UTF-8',
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {}),
  };
}
