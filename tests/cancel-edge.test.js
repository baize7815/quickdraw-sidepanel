const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
require('../koukoutu-client.js');
require('../ai-protocol.js');
require('../ai-gpt-provider.js');
const Doubao = require('../ai-doubao-provider.js');
require('../core-utils.js');
require('../sidepanel.js');
const client = () => Object.create(globalThis.QuickdrawKoukoutuClient.prototype);
test('first cutout visits the service once and subsequent visits use the saved marker', async () => {
  const original = global.chrome, saved = {};
  let opened = 0;
  global.chrome = { storage: { local: { get: async () => saved, set: async data => Object.assign(saved, data) } }, tabs: { create: async () => { opened++; return { id: 1 }; }, get: async () => ({ status: 'complete', url: 'https://www.koukoutu.com/' }) } };
  try {
    await client().ensureSiteVisit();
    await client().ensureSiteVisit();
    assert.equal(opened, 1);
    assert.equal(saved.quickdraw_koukoutu_site_visited_v1, true);
  } finally { global.chrome = original; }
});
test('cancelling website initialization does not record a successful visit', async () => {
  const original = global.chrome, controller = new AbortController();
  let saved = false;
  global.chrome = { storage: { local: { get: async () => ({}), set: async () => { saved = true; } } }, tabs: { create: async () => { controller.abort(); return { id: 1 }; } } };
  try { await assert.rejects(client().ensureSiteVisit(controller.signal), { name: 'AbortError' }); assert.equal(saved, false); }
  finally { global.chrome = original; }
});
test('cancel aborts an in-flight request', async () => {
  const original = global.fetch;
  const controller = new AbortController();
  global.fetch = (_url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  try {
    const pending = client().postForm('/api/query', {}, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  } finally { global.fetch = original; }
});
test('cancel interrupts polling before another request', async () => {
  const c = client(), controller = new AbortController();
  let requests = 0;
  c.postForm = async () => { requests++; };
  const pending = c.waitForResult('task', null, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(requests, 0);
});
test('cancel between upload and task creation does not create a server task', async () => {
  const c = client(), controller = new AbortController();
  c.requestUploadSignature = async () => ({});
  c.uploadImage = async () => { controller.abort(); return 'url'; };
  c.createTask = async () => assert.fail('task created after cancellation');
  await assert.rejects(c.removeBackground(new Blob(['x'], { type: 'image/png' }), { width: 100, height: 100 }, null, controller.signal), { name: 'AbortError' });
});
test('normal cutout sequence still returns the result', async () => {
  const c = client(), calls = [], output = new Blob(['result']);
  for (const name of ['requestUploadSignature', 'uploadImage', 'createTask', 'waitForResult', 'downloadResult']) c[name] = async () => { calls.push(name); return output; };
  assert.equal(await c.removeBackground(new Blob(['x'], { type: 'image/png' }), { width: 100, height: 100 }), output);
  assert.equal(calls.length, 5);
});
test('cancelled cutout cannot overwrite an image or start the next image, including cancellation during saving', async () => {
  for (const cancelAt of ['service', 'save']) {
    const board = Object.create(globalThis.QuickdrawBoard.prototype);
    const targets = [{ type: 'image', assetId: 'original' }, { type: 'image', assetId: 'second' }];
    let requests = 0, commits = 0;
    const deleted = [];
    Object.assign(board, { elements: targets, getSelectedElements: () => targets, updateHistoryUI() {}, render() {}, toast() {}, setSelection() {},
      decodeImageBlob: async () => ({ width: 100, height: 100 }), imageBlobToPng: async value => value,
      store: { getAsset: async () => ({ blob: new Blob(['x']) }), putAsset: async () => { board.backgroundRemovalController.abort(); return 'new'; }, deleteAsset: async id => deleted.push(id) },
      koukoutuClient: { removeBackground: async () => { requests++; if (cancelAt === 'service') board.backgroundRemovalController.abort(); return new Blob(['result']); } },
      commit() { commits++; }
    });
    await board.removeSelectedImageBackground();
    assert.equal(requests, 1);
    assert.equal(commits, 0);
    assert.equal(targets[0].assetId, 'original');
    assert.equal(board.backgroundRemovalInProgress, false);
    assert.deepEqual(deleted, cancelAt === 'save' ? ['new'] : []);
  }
});
test('Doubao activation survives unsupported tab group updates', async () => {
  const original = global.chrome;
  let activated = false;
  global.chrome = { tabs: { get: async () => ({ url: 'https://www.doubao.com/chat/', groupId: 1 }), update: async (_id, value) => { activated = value.active; } }, tabGroups: { update: async () => { throw new Error('unsupported'); } } };
  try { await new Doubao().activateTaskTab(1); assert.equal(activated, true); }
  finally { global.chrome = original; }
});
test('Edge requests permissions in the click; Chrome keeps the existing permission check', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../sidepanel.js'), 'utf8');
  const method = source.slice(source.indexOf('    async ensureProviderPermission('), source.indexOf('    async ensureGPTPermission('));
  for (const [ua, expected] of [['Chrome/140 Edg/140', ['request']], ['Chrome/140', ['contains']]]) {
    const calls = [];
    const context = { navigator: { userAgent: ua }, QuickdrawAI: { provider: () => ({ enabled: true, origins: ['https://www.doubao.com/*'] }) }, chrome: { permissions: { contains: async () => { calls.push('contains'); return true; }, request: async () => { calls.push('request'); return true; } } } };
    const ui = vm.runInNewContext(`({${method}})`, context);
    assert.equal(await ui.ensureProviderPermission('doubao', true), true);
    assert.deepEqual(calls, expected);
  }
});
