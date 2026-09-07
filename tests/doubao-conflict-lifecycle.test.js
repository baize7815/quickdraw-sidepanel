'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AI = require('../ai-protocol.js');
require('../ai-task-store.js');
require('../ai-gpt-provider.js');
require('../ai-doubao-provider.js');
const Router = require('../ai-router.js');

test('豆包会话冲突保留页面和输入，继续只恢复监听；取消才清理', async () => {
  const saved = global.chrome, data = {}, deleted = [];
  const storage = { get: async key => ({ [key]: structuredClone(data[key]) }), set: async value => Object.assign(data, structuredClone(value)) };
  global.chrome = { runtime: { id: 'test', sendMessage: async () => ({}) }, storage: { local: storage, session: storage }, tabs: { get: async () => ({ id: 7, url: 'https://www.doubao.com/chat/test' }) } };
  const router = new Router({ assetStore: { deleteAsset: async id => deleted.push(id) } });
  let stopped = 0, closed = 0, sent = 0, resumed = 0;
  try {
    await router.ready;
    const task = { ...AI.createTask({ provider: 'doubao', kind: 'image-edit', prompt: '图一参考图二上色', boardId: 'board', sourceInstanceId: 'instance', inputAssets: [{ assetId: 'one' }, { assetId: 'two' }] }), status: 'waiting', stage: 'generating', tabId: 7, requestFingerprint: 'sent', requestMessageId: 'original' };
    await router.store.upsert(task);
    const provider = router.providers.doubao;
    provider.accepts = () => true;
    provider.stop = async () => { stopped++; };
    provider.cleanup = async () => { closed++; };
    provider.send = async () => { sent++; };
    provider.resume = async current => { resumed++; assert.equal(current.requestMessageId, 'original'); };
    const event = { type: 'qd-ai-provider-event', taskId: task.taskId, kind: 'needs-attention', code: 'conversation-conflict', error: '会话需要确认', eventId: 'first' };
    const sender = { id: 'test', frameId: 0, tab: { id: 7 }, url: 'https://www.doubao.com/chat/test' };
    const response = await router.handleProviderEvent(event, sender);
    assert.equal(response.paused, true);
    assert.equal((await router.store.find(task.taskId)).pauseReason, 'conversation-conflict');
    assert.equal(stopped, 1); assert.equal(closed, 0); assert.deepEqual(deleted, []);
    assert.equal((await router.resumePausedTask({ taskId: task.taskId })).ok, true);
    assert.equal(sent, 0); assert.equal(resumed, 1);
    await router.handleProviderEvent({ ...event, eventId: 'second' }, sender);
    chrome.tabs.get = async () => { throw new Error('tab gone'); };
    assert.equal((await router.resumePausedTask({ taskId: task.taskId })).ok, false);
    assert.equal(sent, 0); assert.equal(resumed, 1); assert.equal(closed, 0);
    chrome.tabs.get = async () => ({ id: 7, url: 'https://www.doubao.com/chat/test' });
    provider.resume = async () => { throw new Error('listener unavailable'); };
    assert.equal((await router.resumePausedTask({ taskId: task.taskId })).ok, false);
    assert.equal((await router.store.find(task.taskId)).status, 'paused');
    assert.equal(closed, 0); assert.deepEqual(deleted, []);
    await router.cancelTask({ taskId: task.taskId });
    assert.equal(closed, 1); assert.deepEqual(deleted.sort(), ['one', 'two']);
  } finally {
    for (const timer of router.timers.values()) clearTimeout(timer);
    global.chrome = saved;
  }
});
