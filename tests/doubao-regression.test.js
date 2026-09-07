'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const AI = require('../ai-protocol.js');
const Doubao = require('../ai-doubao-provider.js');

test('豆包复用专用标签页时自动展开并激活，不需用户手动点开', async () => {
  const saved = global.chrome, calls = [];
  const provider = new Doubao();
  provider.tabMeta = { tabId: 7, ownedByExtension: true, taskId: 'task', groupId: 3 };
  global.chrome = {
    storage: { session: { set: async () => {} } },
    tabs: {
      get: async () => ({ id: 7, url: 'https://www.doubao.com/chat/', groupId: 3 }),
      update: async (id, options) => calls.push({ id, ...options })
    },
    tabGroups: { update: async (id, options) => calls.push({ group: id, ...options }) }
  };
  try {
    assert.equal(await provider.ensureTab(1, { taskId: 'task' }), 7);
    assert.deepEqual(calls, [{ group: 3, collapsed: false }, { id: 7, active: true }]);
  } finally { global.chrome = saved; }
});

test('豆包 DOM：完整多行脑图和豆包复制按钮触发一次回传，恢复不取末行', async () => {
  const browser = await chromium.launch({ channel: process.env.QD_BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div data-message-id="request" data-role="user">任务编号：map-task。 用户需求：流程图</div>
      <div data-message-id="answer" data-role="assistant">
        <div class="message-content"><p>flowchart TD</p><p>A[开始]</p><p>B[结束]</p><p class="message-line">A --&gt; B</p></div>
        <button data-testid="message-action-copy">复制</button>
      </div><textarea></textarea>`);
    await page.evaluate(() => {
      window.module = { exports: {} };
      window.events = [];
      window.chrome = { runtime: { id: 'test', sendMessage: async event => { window.events.push(event); return { ok: true }; } } };
    });
    await page.addScriptTag({ path: path.resolve(__dirname, '../doubao-content.js') });
    const probe = await page.evaluate(() => module.exports.probeTask('map-task'));
    assert.equal(AI.validateMermaid(probe.replyText).ok, true);
    await page.evaluate(() => {
      const content = module.exports;
      const record = { taskId: 'map-task', mode: 'mindmap', baselineElements: new Set(), sawBusy: false };
      content.active.set(record.taskId, record);
      content.watchReply(record);
    });
    await page.waitForFunction(() => window.events.some(event => event.kind === 'reply'));
    const replies = await page.evaluate(() => window.events.filter(event => event.kind === 'reply'));
    assert.equal(replies.length, 1);
    const checked = AI.validateMermaid(replies[0].text);
    assert.equal(checked.ok, true);
    assert.deepEqual(checked.stats, { nodes: 2, edges: 1 });
    assert.equal(await page.evaluate(() => module.exports.active.size), 0);
  } finally { await browser.close(); }
});

test('豆包 DOM：图片字节转换异常仍将 HTTPS 原图交给后台读取', async () => {
  const browser = await chromium.launch({ channel: process.env.QD_BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div data-message-id="request" data-role="user">任务编号：image-task。 用户需求：图片</div>
      <div data-message-id="answer" data-role="assistant">已完成图片生成<img id="result" src="https://example.invalid/result.png"></div>`);
    await page.evaluate(() => {
      const image = document.getElementById('result');
      Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 512 }, naturalHeight: { value: 512 } });
      window.module = { exports: {} }; window.events = [];
      window.chrome = { runtime: { id: 'test', sendMessage: async event => { events.push(event); return { ok: true }; } } };
      window.fetch = async () => ({ ok: true, blob: async () => ({ size: 100, arrayBuffer: async () => { throw new Error('decode failed'); } }) });
    });
    await page.addScriptTag({ path: path.resolve(__dirname, '../doubao-content.js') });
    await page.evaluate(() => {
      const content = module.exports;
      const record = { taskId: 'image-task', mode: 'image-edit', baselineElements: new Set(), baselineHashes: [] };
      content.active.set(record.taskId, record); content.watchReply(record);
    });
    await page.waitForFunction(() => events.some(event => event.kind === 'image-reply'));
    const result = await page.evaluate(() => events.find(event => event.kind === 'image-reply'));
    assert.equal(result.images[0].imageUrl, 'https://example.invalid/result.png');
    assert.equal(result.images[0].imageDataUrl, '');
    assert.equal(await page.evaluate(() => module.exports.active.size), 0);
  } finally { await browser.close(); }
});
