const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../gpt-content.js'), 'utf8');
function element(attrs = {}, extra = {}) {
  return { offsetParent: {}, getAttribute: name => attrs[name] ?? null, ...extra };
}
function harness({ files = [], localFiles = [], previews = [], localPreviews = previews, markers = [], chips = [], onPaste = null } = {}) {
  let now = 1000;
  const root = { querySelectorAll(selector) {
    if (selector === 'input[type="file"]') return localFiles;
    if (selector === 'img') return localPreviews;
    return markers;
  } };
  const composer = element({}, { closest: () => root, focus() {}, dispatchEvent(event) { onPaste?.(event); return false; } });
  const context = {
    module: { exports: {} }, location: { origin: 'https://chatgpt.com', href: 'https://chatgpt.com/' },
    document: {
      querySelector: selector => selector === '#prompt-textarea' ? composer : null,
      querySelectorAll: selector => selector === 'input[type="file"]' ? files : selector === 'span,div,button' ? chips : selector === 'img' ? previews : selector.includes('[data-testid*="attachment"') ? markers : []
    },
    Date: { now: () => now },
    File: class { constructor(parts, name, options) { this.name = name; this.type = options.type; } },
    DataTransfer: class { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } },
    ClipboardEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    setTimeout: callback => { now += 350; queueMicrotask(callback); }
  };
  vm.runInNewContext(source.replace('module.exports = { extractAssistantText', 'module.exports = { findAttachmentInput, extractAssistantText'), context);
  const api = context.module.exports;
  api.active.set('test', {});
  return api;
}
const preview = () => element({}, { src: 'blob:uploaded', complete: true, naturalWidth: 100, naturalHeight: 100 });
test('detects a pasted preview in a separate attachment tray outside the composer subtree', async () => {
  const previews = [];
  const api = harness({ previews, localPreviews: [], onPaste() { previews.push(preview()); } });
  assert.equal(await api.attachImages([{ type: 'image/png' }], 'test'), true);
});
test('new images in conversation history cannot confirm an attachment', async () => {
  const previews = [];
  const api = harness({ previews, localPreviews: [], onPaste() { previews.push({ ...preview(), closest: () => ({}) }); } });
  await assert.rejects(api.attachImages([{ type: 'image/png' }], 'test'), /未显示收到的图片/);
});
test('recognizes filename-only attachments outside the editor form', async () => {
  const chips = [];
  const api = harness({ chips, onPaste() { chips.push(element({}, { textContent: 'quickdraw-source-01.png' })); } });
  assert.equal(await api.attachImages([{ type: 'image/png' }], 'test'), true);
});
test('uploads through composer paste without touching unrelated hidden file inputs', async () => {
  const previews = [], events = [];
  const wrongInput = { accept: 'image/*', dispatchEvent() { throw new Error('wrong input'); } };
  const api = harness({ files: [wrongInput], previews, onPaste(event) { events.push(event); previews.push({ ...preview(), naturalWidth: 24, naturalHeight: 24 }); } });
  assert.equal(await api.attachImages([{ type: 'image/png' }], 'test'), true);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'paste');
  assert.equal(events[0].clipboardData.files.length, 1);
});
test('unacknowledged paste reports an error without repeating the upload', async () => {
  let attempts = 0;
  const api = harness({ onPaste() { attempts++; } });
  await assert.rejects(api.attachImages([{ type: 'image/png' }], 'test'), /未显示收到的图片/);
  assert.equal(attempts, 1);
});
test('selects composer upload input instead of the first page input', () => {
  const unrelated = { accept: 'image/*' }, chat = { accept: 'image/*' };
  assert.equal(harness({ files: [unrelated, chat], localFiles: [chat] }).findAttachmentInput(), chat);
});
test('ignores disabled and incompatible upload inputs; refuses ambiguity', () => {
  const chat = { accept: 'image/png' };
  assert.equal(harness({ files: [{ accept: '.pdf' }, { accept: 'image/*', disabled: true }, chat] }).findAttachmentInput(), chat);
  assert.equal(harness({ files: [{ accept: 'image/*' }, { accept: 'image/*' }] }).findAttachmentInput(), null);
});
test('completed upload proceeds while send button is absent', async () => {
  const api = harness({ previews: [preview()] });
  assert.equal(await api.waitForAttachment('test', null, new Map()), true);
});
test('preview alone cannot bypass a busy upload', async () => {
  const api = harness({ previews: [preview()], markers: [element({ 'data-state': 'uploading' })] });
  assert.equal(await api.waitForAttachment('test', null, new Map()), false);
});
test('failed upload never proceeds', async () => {
  const api = harness({ previews: [preview()], markers: [element({ 'data-state': 'error' })] });
  assert.equal(await api.waitForAttachment('test', null, new Map()), false);
});
test('two images require two completed attachments', async () => {
  const child = element({ 'data-state': 'complete' });
  const parent = element({ 'data-state': 'complete' }, { contains: other => other === child });
  const api = harness({ previews: [preview()], markers: [parent, child] });
  assert.equal(await api.waitForAttachment('test', null, new Map(), new Map(), 2), false);
  const both = harness({ previews: [preview(), preview()] });
  assert.equal(await both.waitForAttachment('test', null, new Map(), new Map(), 2), true);
});
test('old previews and cancelled tasks cannot confirm upload', async () => {
  const old = preview(), api = harness({ previews: [old] });
  assert.equal(await api.waitForAttachment('test', null, new Map(), new Map([[old, api.attachmentPreviewState(old)]])), false);
  api.active.clear();
  assert.equal(await api.waitForAttachment('test', null, new Map()), false);
});
test('task details use saved image assets while new text tasks remain text-only', () => {
  const panel = fs.readFileSync(path.join(__dirname, '../sidepanel.js'), 'utf8');
  const method = panel.slice(panel.indexOf('    syncAIModeUI(){'), panel.indexOf('    aiTaskStatusLabel('));
  const nodes = new Map();
  const context = { $: selector => { if (!nodes.has(selector)) nodes.set(selector, {}); return nodes.get(selector); } };
  const ui = vm.runInNewContext(`({${method}})`, context);
  Object.assign(ui, { aiDialogMode: 'image-edit', aiProvider: 'gpt', aiCurrentTaskId: 'saved', aiTasks: [{ taskId: 'saved', inputAssetIds: ['image'] }] });
  ui.syncAIModeUI();
  assert.equal(nodes.get('#ai-mindmap-submit').textContent, '使用GPT生成图片');
  assert.doesNotMatch(nodes.get('.ai-dialog-hint').textContent, /当前未选择图片/);
  ui.aiCurrentTaskId = null;
  ui.aiImageSelection = { units: [] };
  ui.syncAIModeUI();
  assert.equal(nodes.get('#ai-mindmap-submit').textContent, '使用GPT文生图');
});
