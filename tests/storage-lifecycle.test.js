'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AI = require('../ai-protocol.js');
const previousCore = globalThis.QDCore;
globalThis.QDCore = { newId: prefix => `${prefix}-test` };
require('../storage.js');
globalThis.QDCore = previousCore;
const Storage = globalThis.QuickdrawStorage;
const TaskStore = require('../ai-task-store.js');

test('同一资源的并发 URL 请求只创建并缓存一个 Blob URL', async () => {
  const originalURL = globalThis.URL;
  const revoked = [];
  let created = 0;
  globalThis.URL = {
    createObjectURL: () => `blob:test-${++created}`,
    revokeObjectURL: url => revoked.push(url)
  };
  try {
    const store = new Storage();
    let reads = 0;
    let release;
    store.getAsset = async () => {
      reads += 1;
      await new Promise(resolve => { release = resolve; });
      return { blob: {} };
    };
    store.transaction = async () => {};

    const first = store.getAssetUrl('asset-a');
    const second = store.getAssetUrl('asset-a');
    release();
    assert.deepEqual(await Promise.all([first, second]), ['blob:test-1', 'blob:test-1']);
    assert.equal(reads, 1);
    assert.equal(store.objectUrls.size, 1);

    await store.deleteAsset('asset-a');
    assert.deepEqual(revoked, ['blob:test-1']);
  } finally {
    globalThis.URL = originalURL;
  }
});

test('资源 URL 读取被释放后，迟到的 Blob URL 会立即回收', async () => {
  const originalURL = globalThis.URL;
  const revoked = [];
  globalThis.URL = {
    createObjectURL: () => 'blob:late',
    revokeObjectURL: url => revoked.push(url)
  };
  try {
    const store = new Storage();
    let release;
    store.getAsset = async () => {
      await new Promise(resolve => { release = resolve; });
      return { blob: {} };
    };
    const pending = store.getAssetUrl('asset-late');
    store.releaseObjectUrlsExcept([]);
    release();
    assert.equal(await pending, '');
    assert.deepEqual(revoked, ['blob:late']);
    assert.equal(store.objectUrls.size, 0);
  } finally {
    globalThis.URL = originalURL;
  }
});

test('任务历史清理会限制所有保留状态到 MAX_TASKS，并在超限时保留较新的任务', async () => {
  const data = {};
  const storage = {
    get: async key => ({ [key]: structuredClone(data[key]) }),
    set: async values => Object.assign(data, structuredClone(values))
  };
  const previousChrome = globalThis.chrome;
  globalThis.chrome = { storage: { local: storage } };
  try {
    data.quickdraw_ai_tasks_v1 = Array.from({ length: AI.MAX_TASKS + 8 }, (_, index) => ({
      ...AI.createTask({ prompt: `任务-${index}`, boardId: 'board', sourceInstanceId: 'instance' }),
      taskId: `task-${index}`,
      status: 'ready',
      updatedAt: index
    }));
    const store = new TaskStore();
    assert.equal((await store.list()).length, AI.MAX_TASKS);
    await store.pruneHistory();
    assert.equal(data.quickdraw_ai_tasks_v1.length, AI.MAX_TASKS);
    assert.equal((await store.list()).length, AI.MAX_TASKS);
    assert.equal(data.quickdraw_ai_tasks_v1[0].taskId, `task-${AI.MAX_TASKS + 7}`);
  } finally {
    globalThis.chrome = previousChrome;
  }
});
