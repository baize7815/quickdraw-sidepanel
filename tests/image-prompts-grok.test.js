const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const AI = require('../ai-protocol.js');
const source = fs.readFileSync(path.join(__dirname, '../grok-content.js'), 'utf8');
const element = (text = '', attrs = {}) => ({ textContent: text, offsetParent: {}, getAttribute: key => attrs[key] || null, querySelector: () => null });
function setup(images = [], markers = [], messages = []) {
  let elapsed = 1000;
  const document = { querySelectorAll(selector) {
    if (selector === 'img') return images;
    if (selector.includes('[data-testid*="attachment"')) return markers;
    if (selector === 'body *' || selector === '[data-message-author-role="user"]') return messages;
    return [];
  } };
  const context = { module: { exports: {} }, document, Date: { now: () => elapsed },
    setTimeout: fn => { elapsed += 350; queueMicrotask(fn); }, location: { origin: 'https://grok.com', href: 'https://grok.com/' } };
  vm.runInNewContext(source, context);
  const api = context.module.exports;
  api.active.set('test', {});
  return { api, elapsed: () => elapsed - 1000 };
}
test('all image providers send only user text, including empty and multiline input', () => {
  for (const build of [AI.buildGPTImagePrompt, AI.buildGrokImagePrompt, AI.buildDoubaoImagePrompt]) {
    for (const prompt of ['', '移除这两个元素', '保留主体\n背景改成白色']) assert.equal(build(prompt, 'task-private-id'), prompt);
  }
});
test('Grok accepts a loaded small thumbnail promptly without a send button', async () => {
  const image = { ...element(), src: 'blob:upload', complete: true, naturalWidth: 24, naturalHeight: 24 };
  const { api, elapsed } = setup([image]);
  assert.equal(await api.waitForAttachment('test', null, new Map()), true);
  assert.ok(elapsed() < 2000);
});
test('Grok waits for incomplete images and refuses upload errors', async () => {
  const image = { ...element(), src: 'blob:upload', complete: false, naturalWidth: 24, naturalHeight: 24 };
  const { api } = setup([image]);
  assert.equal(await api.waitForAttachment('test', null, new Map()), false);
  const failed = setup([{ ...image, complete: true }], [element('', { 'data-state': 'error' })]);
  assert.equal(await failed.api.waitForAttachment('test', null, new Map()), false);
});
test('Grok finds plain requests and recovers them by fingerprint without a task marker', () => {
  const bubble = element('移除这两个元素');
  const { api } = setup([], [], [bubble]);
  const messages = api.userMessages('移除这两个元素');
  assert.equal(messages.length, 1);
  assert.equal(api.taskRequest('test', messages[0].fingerprint).element, bubble);
});
test('Grok recognizes an image-only user message', () => {
  const bubble = { ...element('', { 'data-message-author-role': 'user' }), innerHTML: '<img src="image">', querySelector: selector => selector === 'img' ? {} : null };
  const { api } = setup([], [], [bubble]);
  assert.equal(api.userMessages('').length, 1);
});
