import test from 'node:test';
import assert from 'node:assert/strict';
import { navigationUrl, browserEnvironment } from '../src/navigation.js';

test('browser destinations reject local and executable schemes and embedded credentials', () => {
  for (const url of ['file:///proc/self/environ', 'file:///etc/passwd', 'data:text/html,hello', 'javascript:alert(1)', 'chrome://version', 'ftp://example.com', 'https://user:password@example.com', 'relative']) {
    assert.throws(() => navigationUrl(url));
  }
  assert.equal(navigationUrl('https://example.com'), 'https://example.com/');
  assert.equal(navigationUrl('about:blank'), 'about:blank');
});

test('browser subprocess gets a private home and no ambient worker secrets or loader overrides', () => {
  const prior = process.env.STATION_BROWSER_TEST_SECRET;
  process.env.STATION_BROWSER_TEST_SECRET = 'not-for-browser';
  try {
    const env = browserEnvironment('/private/session');
    assert.equal(env.STATION_BROWSER_TEST_SECRET, undefined);
    assert.equal(env.HOME, '/private/session');
    for (const key of ['NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'AWS_SECRET_ACCESS_KEY', 'HTTP_PROXY', 'BASH_ENV']) assert.equal(env[key], undefined);
  } finally { if (prior === undefined) delete process.env.STATION_BROWSER_TEST_SECRET; else process.env.STATION_BROWSER_TEST_SECRET = prior; }
});
