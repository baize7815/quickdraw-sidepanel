'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AIImage = require('../ai-image-utils.js');
const AI = require('../ai-protocol.js');
require('../ai-task-store.js');
require('../ai-gpt-provider.js');
const DoubaoProvider = require('../ai-doubao-provider.js');
const Router = require('../ai-router.js');

const png = () => new Blob([new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0])], { type: 'image/png' });

function setup(assetStore) {
  const data = {};
  const storage = { get: async key => ({ [key]: structuredClone(data[key]) }), set: async value => Object.assign(data, structuredClone(value)) };
  global.chrome = { runtime: { id: 'test-extension', sendMessage: async () => ({}) }, storage: { local: storage, session: storage } };
  const router = new Router({ assetStore });
  return { router, data };
}

test('图片资源校验拒绝伪装类型并接受 PNG 签名', async () => {
  await assert.rejects(() => AIImage.inspectBlob(new Blob(['not an image'], { type: 'image/png' })), /受支持的图片|类型声明/);
  const result = await AIImage.inspectBlob(png(), { maxBytes: 100 });
  assert.equal(result.type, 'image/png');
});

test('图片字节通过 JSON 安全的 data URL 往返且拒绝损坏编码', async () => {
  const encoded = await AIImage.blobToDataUrl(png(), { maxBytes: 100 });
  assert.match(encoded, /^data:image\/png;base64,/);
  const decoded = await AIImage.dataUrlToBlob(encoded, { maxBytes: 100 });
  assert.equal(decoded.type, 'image/png');
  assert.deepEqual([...new Uint8Array(await decoded.blob.arrayBuffer())], [...new Uint8Array(await png().arrayBuffer())]);
  await assert.rejects(() => AIImage.dataUrlToBlob('data:image/png;base64,bm90LWEtcG5n', { maxBytes: 100 }), /受支持的图片/);
});

test('图片发送命令不跨 runtime 传 Blob', async () => {
  const Provider = globalThis.QuickdrawGPTProvider;
  const provider = new Provider({ getAsset: async () => ({ blob: png() }) });
  let command;
  provider.command = async (_task, value) => { command = value; };
  await provider.send({ kind: 'image-edit', inputAssetId: 'input', prompt: '改成红色背景', taskId: 'task-a' });
  assert.equal(typeof command.imageDataUrl, 'string');
  assert.equal('imageBlob' in command, false);
  assert.match(command.prompt, /任务编号：task-a/);
  assert.match(command.prompt, /改成红色背景/);
  assert.doesNotMatch(command.prompt, /图片编辑助手/);
});

test('图片任务启动只请求 Provider 页面权限，已有 data URL 结果不再请求图片源站权限', async () => {
  const Provider = globalThis.QuickdrawGPTProvider;
  const provider = new Provider();
  assert.deepEqual(provider.getPermissionOrigins({ kind: 'image-edit' }), ['https://chatgpt.com/*', 'https://chat.openai.com/*', 'https://auth.openai.com/*']);
  const previousChrome = global.chrome;
  const previousDecode = AIImage.dataUrlToBlob;
  const previousInspect = AIImage.inspectBlob;
  let containsCalls = 0;
  global.chrome = { permissions: { contains: async () => { containsCalls += 1; return false; } } };
  AIImage.dataUrlToBlob = async () => ({ blob: png(), type: 'image/png', bytes: 12, width: 64, height: 64 });
  AIImage.inspectBlob = async blob => ({ blob, type: 'image/png', bytes: blob.size, width: 64, height: 64 });
  try {
    const result = await provider.materializeImage({ imageUrl: 'https://cdn.example.com/result.png', imageDataUrl: 'data:image/png;base64,AAAA' });
    assert.equal(result.imageUrl, 'https://cdn.example.com/result.png');
    assert.equal(containsCalls, 0);
  } finally {
    AIImage.dataUrlToBlob = previousDecode;
    AIImage.inspectBlob = previousInspect;
    global.chrome = previousChrome;
  }
});

test('豆包 CDN 子域共享权限范围，已授权后直接读取且读取失败不再伪报权限', async () => {
  const provider = new DoubaoProvider();
  assert.deepEqual(provider.getOutputPermissionOrigins('https://p3-flow-imagex-sign.byteimg.com/a.png?sig=1'), ['https://*.byteimg.com/*']);
  assert.deepEqual(provider.getOutputPermissionOrigins('https://p9-flow-imagex-sign.byteimg.com/b.png?sig=2'), ['https://*.byteimg.com/*']);
  const previousChrome = global.chrome, previousFetch = global.fetch;
  let granted = false, containsCalls = 0, fetchCalls = 0;
  global.chrome = { permissions: { contains: async value => { containsCalls += 1; assert.deepEqual(value.origins, ['https://*.byteimg.com/*']); return granted; } } };
  try {
    await assert.rejects(() => provider.materializeImage({ imageUrl: 'https://p3-flow-imagex-sign.byteimg.com/a.png?sig=1' }), error => error.code === 'image-origin-permission' && error.permissionOrigins[0] === 'https://*.byteimg.com/*');
    granted = true;
    global.fetch = async () => { fetchCalls += 1; throw new TypeError('Failed to fetch'); };
    await assert.rejects(() => provider.materializeImage({ imageUrl: 'https://p9-flow-imagex-sign.byteimg.com/b.png?sig=2' }), error => error.code === 'image-fetch-failed' && !/授权/.test(error.message));
    assert.equal(containsCalls, 2); assert.equal(fetchCalls, 1);
  } finally { global.chrome = previousChrome; global.fetch = previousFetch; }
});

test('图片回复转为待插入资产并清理输入资产', async () => {
  const records = new Map([['input', { blob: png() }]]);
  const assetStore = {
    getAsset: async id => records.get(id) || null,
    putAsset: async blob => { const id = `output-${records.size}`; records.set(id, { blob }); return id; },
    deleteAsset: async id => records.delete(id)
  };
  const { router } = setup(assetStore);
  await router.ready;
  const task = AI.createTask({ kind: 'image-edit', prompt: '把背景改成蓝色', boardId: 'board-a', sourceInstanceId: 'instance-a', inputAssetId: 'input' });
  Object.assign(task, { status: 'waiting', tabId: 7 });
  await router.store.upsert(task);
  router.providers.gpt.accepts = () => true;
  router.providers.gpt.materializeImage = async () => ({ blob: png(), type: 'image/png', bytes: 12, width: 100, height: 80, imageUrl: 'https://foo.oaiusercontent.com/a.png' });
  const result = await router.handleMessage({ type: 'qd-ai-provider-event', taskId: task.taskId, kind: 'image-reply', phase: 'complete', imageUrl: 'https://foo.oaiusercontent.com/a.png' }, { id: chrome.runtime.id, frameId: 0, tab: { id: 7 }, url: 'https://chatgpt.com/' });
  assert.equal(result.ok, true);
  const stored = await router.store.find(task.taskId);
  assert.equal(stored.status, 'image-ready');
  assert.equal(typeof stored.outputAssetId, 'string');
  assert.equal(records.has('input'), false);
  for (const timer of router.timers.values()) clearTimeout(timer);
});

test('未授权图片地址保留任务并等待权限重试', async () => {
  const assetStore = { putAsset: async () => 'out', deleteAsset: async () => {} };
  const { router } = setup(assetStore);
  await router.ready;
  const task = AI.createTask({ kind: 'image-edit', prompt: '编辑', boardId: 'board-a', sourceInstanceId: 'instance-a', inputAssetId: 'input' });
  Object.assign(task, { status: 'waiting', tabId: 7 });
  await router.store.upsert(task);
  router.providers.gpt.accepts = () => true;
  router.providers.gpt.materializeImage = async () => { const error = new Error('permission'); error.code = 'image-origin-permission'; error.imageUrl = 'https://cdn.example.com/image.png'; throw error; };
  const result = await router.handleMessage({ type: 'qd-ai-provider-event', taskId: task.taskId, kind: 'image-reply', phase: 'complete', imageUrl: 'https://cdn.example.com/image.png' }, { id: chrome.runtime.id, frameId: 0, tab: { id: 7 }, url: 'https://chatgpt.com/' });
  assert.equal(result.pendingImagePermission, true);
  assert.equal((await router.store.find(task.taskId)).status, 'pending-image');
  for (const timer of router.timers.values()) clearTimeout(timer);
});

test('图片权限失败后只重试既有结果，保留输入和标签页直到导入确认', async () => {
  const records = new Map([['input', { blob: png() }]]);
  const assetStore = {
    getAsset: async id => records.get(id) || null,
    putAsset: async blob => { const id = `output-${records.size}`; records.set(id, { blob }); return id; },
    deleteAsset: async id => records.delete(id)
  };
  const { router, data } = setup(assetStore);
  await router.ready;
  const task = AI.createTask({ kind: 'image-edit', prompt: '', boardId: 'board-a', sourceInstanceId: 'instance-a', inputAssetId: 'input' });
  Object.assign(task, { status: 'waiting', tabId: 7, tabOwned: true, tabOwnerToken: 'owner' });
  await router.store.upsert(task);
  router.activeByProvider.set('gpt', task.taskId);
  router.providers.gpt.accepts = () => true;
  let materializeCalls = 0;
  router.providers.gpt.materializeImage = async event => {
    materializeCalls += 1;
    if (materializeCalls === 1) { const error = new Error('permission'); error.code = 'image-origin-permission'; error.imageUrl = 'https://cdn.example.com/result.png'; throw error; }
    assert.equal(event.imageUrl, 'https://cdn.example.com/result.png');
    return { blob: png(), type: 'image/png', bytes: 12, width: 64, height: 64, imageUrl: event.imageUrl };
  };
  let cleanupCalls = 0;
  router.providers.gpt.cleanup = async () => { cleanupCalls += 1; return true; };
  const webSender = { id: chrome.runtime.id, frameId: 0, tab: { id: 7 }, url: 'https://chatgpt.com/' };
  const pending = await router.handleMessage({ type: 'qd-ai-provider-event', taskId: task.taskId, kind: 'image-reply', phase: 'complete', imageUrl: 'https://cdn.example.com/result.png' }, webSender);
  assert.equal(pending.pendingImagePermission, true);
  const waiting = await router.store.find(task.taskId);
  assert.equal(waiting.status, 'pending-image');
  assert.equal(waiting.inputAssetId, 'input');
  assert.equal(waiting.tabId, 7);
  assert.equal(waiting.tabOwned, true);
  assert.equal(records.has('input'), true);
  const retried = await router.retryImage({ taskId: task.taskId });
  assert.equal(retried.ok, true);
  assert.equal(retried.task.status, 'image-ready');
  assert.equal(materializeCalls, 2);
  assert.equal(cleanupCalls, 0);
  data['quickdraw_v2_file:board-a'] = { aiTaskReceipts: { [task.taskId]: { createdAt: Date.now() } } };
  const imported = await router.markImported({ taskId: task.taskId, ownerId: 'instance-a', targetBoardId: 'board-a' });
  assert.equal(imported.ok, true);
  assert.equal(cleanupCalls, 1);
  for (const timer of router.timers.values()) clearTimeout(timer);
});

test('图片导入领取状态在重启后释放为待导入且不丢失资源', async () => {
  const assetStore = { getAsset: async () => null, deleteAsset: async () => {} };
  const { router } = setup(assetStore);
  await router.ready;
  const task = AI.createTask({ kind: 'image-edit', prompt: '编辑', boardId: 'board-a', sourceInstanceId: 'instance-a', inputAssetId: 'input' });
  Object.assign(task, { status: 'importing', outputAssetId: 'output', claimedBy: 'old-owner' });
  await router.store.upsert(task);
  await router.restore();
  const stored = await router.store.find(task.taskId);
  assert.equal(stored.status, 'image-ready');
  assert.equal(stored.outputAssetId, 'output');
  assert.equal(stored.claimedBy, null);
});
