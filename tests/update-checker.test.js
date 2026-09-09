const test = require('node:test');
const assert = require('node:assert/strict');
const updates = require('../update-checker.js');
test('compares numeric versions and rejects malformed versions', () => {
  assert.equal(updates.newer('v3.10.0', '3.9.9'), true);
  assert.equal(updates.newer('3.7.5', '3.7.5.0'), false);
  assert.equal(updates.newer('3.7.4', '3.7.5'), false);
  assert.throws(() => updates.newer('3.8.0-beta', '3.7.5'));
});
test('accepts only the expected repository ZIP and ignores draft releases', () => {
  const url = 'https://github.com/baize7815/quickdraw-sidepanel/releases/download/v3.7.5/quickdraw-sidepanel-v3.7.5.zip';
  const release = { tag_name: 'v3.7.5', assets: [{ name: 'quickdraw-sidepanel-v3.7.5.zip', browser_download_url: url }] };
  assert.equal(updates.releaseInfo(release, '3.7.4').downloadUrl, url);
  assert.equal(updates.releaseInfo({ ...release, draft: true }, '3.7.4').available, false);
  release.assets[0].browser_download_url = 'https://example.com/untrusted.zip';
  assert.equal(updates.releaseInfo(release, '3.7.4').downloadUrl, '');
});
test('checks on explicit invocation and reports HTTP failures', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return { ok: true, json: async () => ({ tag_name: 'v3.7.5' }) }; };
  assert.equal(calls, 0);
  assert.equal((await updates.check('3.7.4', fetcher)).available, true);
  assert.equal(calls, 1);
  await assert.rejects(updates.check('3.7.4', async () => ({ ok: false, status: 403 })), /请求受限/);
});
