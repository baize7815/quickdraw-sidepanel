'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AI = require('../ai-protocol.js');
require('../ai-task-store.js');
require('../ai-gpt-provider.js');
const Doubao = require('../ai-doubao-provider.js');
const Router = require('../ai-router.js');
const Content = require('../doubao-content.js');

function setup() {
  const data = {};
  const storage = {
    get: async key => ({ [key]: structuredClone(data[key]) }),
    set: async value => Object.assign(data, structuredClone(value)),
    remove: async key => { delete data[key]; }
  };
  global.chrome = { runtime: { id: 'doubao-test', sendMessage: async () => ({}) }, storage: { local: storage, session: storage } };
  return { data, sender: { id: chrome.runtime.id, frameId: 0, url: 'chrome-extension://doubao-test/sidepanel.html' } };
}

function clearTimers(router) { for (const timer of router.timers.values()) clearTimeout(timer); }

test('豆包编辑器出现但文件控件尚未展开时已就绪，并能经加号打开上传控件', async () => {
  const saved={document:global.document,location:global.location,getComputedStyle:global.getComputedStyle,chrome:global.chrome};
  const editor={tagName:'TEXTAREA',type:'',value:'',offsetParent:{},getAttribute:()=>'',getClientRects:()=>[{}]};
  const file={tagName:'INPUT',type:'file',offsetParent:{},getAttribute:()=>'',getClientRects:()=>[{}]};
  let expanded=false;
  const plus={tagName:'BUTTON',textContent:'+',innerText:'+',offsetParent:{},disabled:false,className:'',outerHTML:'<button>+</button>',getAttribute:()=>'',getClientRects:()=>[{}],click:()=>{expanded=true;}};
  global.location={href:'https://www.doubao.com/chat/',origin:'https://www.doubao.com'};global.getComputedStyle=()=>({display:'block',visibility:'visible'});
  global.chrome={runtime:{id:'doubao-test'}};
  global.document={querySelector:selector=>selector==='input[type="file"]'&&expanded?file:null,querySelectorAll:selector=>{
    if(selector==='textarea')return[editor];if(selector==='input')return expanded?[file]:[];if(selector==='input[type="file"]')return expanded?[file]:[];
    if(selector.includes('button'))return[plus];return[];
  }};
  try {
    assert.deepEqual(Content.handle({type:'qd-ai-doubao-command',taskId:'ready-task',action:'readiness'},{id:'doubao-test'}),{ok:true,ready:true,auth:false});
    assert.equal(await Content.openAttachmentInput(editor,1_000),file);
  } finally {Object.assign(global,saved);}
});

test('豆包 provider 使用独立 tab key、入口和 content script', async () => {
  setup();
  const provider = new Doubao();
  assert.equal(provider.getTabKey(), 'quickdraw_ai_doubao_tab_id_v1');
  assert.equal(provider.getRootUrl(), 'https://www.doubao.com/chat/');
  assert.equal(provider.isAllowedUrl('https://www.doubao.com/chat/'), true);
  assert.equal(provider.isAllowedUrl('https://evil.doubao.com/chat/'), false);
  assert.equal(provider.isAllowedAuthUrl('https://www.doubao.com/passport/login'), true);
  assert.equal(provider.getContentScript(), 'doubao-content.js');
  assert.equal(provider.getCommandType(), 'qd-ai-doubao-command');
  assert.deepEqual(provider.getPermissionOrigins({ kind: 'image-edit' }), ['https://www.doubao.com/*', 'https://*.doubao.com/*', 'https://*.byteimg.com/*']);
});

test('豆包首开等待动态编辑器和文件控件连续就绪后才继续原任务', async () => {
  setup(); const provider = new Doubao(); let readiness = 0, injections = 0;
  global.chrome.tabs = {
    get: async () => ({ id: 7, url: 'https://www.doubao.com/chat/', status: 'complete' }),
    sendMessage: async (_id, message) => message.action === 'readiness' ? { ok: true, ready: ++readiness >= 3 } : { ok: true }
  };
  global.chrome.scripting = { executeScript: async () => { injections += 1; } };
  const task = { taskId: 'first-tab-task', tabId: 7, kind: 'image-edit' };
  assert.equal(await provider.waitForPageReady(task), true);
  assert.equal(readiness, 4); assert.equal(injections, 4);
});

test('多图任务规范化为有序 inputAssets，旧单图字段仍可读取', () => {
  setup();
  const task = AI.createTask({ provider: 'doubao', kind: 'image-edit', prompt: '保留两张图主体', boardId: 'board', sourceInstanceId: 'instance', inputAssets: [
    { assetId: 'asset-right', order: 1, sourceElementIds: ['b'] },
    { assetId: 'asset-left', order: 0, sourceElementIds: ['a'] }
  ] });
  assert.deepEqual(task.inputAssetIds, ['asset-right', 'asset-left']);
  assert.equal(task.inputAssetId, 'asset-right');
  assert.deepEqual(task.inputAssets[1].sourceElementIds, ['a']);
  const legacy = AI.createTask({ provider: 'gpt', kind: 'image-edit', prompt: '单图', boardId: 'board', sourceInstanceId: 'instance', inputAssetId: 'legacy' });
  assert.deepEqual(legacy.inputAssetIds, ['legacy']);
  assert.equal(legacy.inputAssets[0].assetId, 'legacy');
});

test('豆包任务从首次建页到多图上传、单次发送、结果 ACK 后清理输入和 owned tab', async () => {
  const { data, sender } = setup();
  const assets = {
    records: new Map([['a1', { blob: new Blob(['png-a'], { type: 'image/png' }) }], ['a2', { blob: new Blob(['png-b'], { type: 'image/png' }) }]]),
    deleted: [],
    async getAsset(id) { return this.records.get(id) || null; },
    async putAsset() { this.records.set('output', { blob: new Blob(['png-out'], { type: 'image/png' }) }); return 'output'; },
    async deleteAsset(id) { this.deleted.push(id); this.records.delete(id); }
  };
  const router = new Router({ assetStore: assets }); await router.ready;
  const provider = router.providers.doubao;
  assert.ok(provider);
  let prepared = 0, sent = 0, removed = 0, sentTask = null;
  provider.prepare = async () => { prepared += 1; provider.tabMeta = { tabId: 7, ownedByExtension: true, ownerToken: 'owner', taskId: 'pending', groupId: 3 }; return 7; };
  provider.send = async task => { sent += 1; sentTask = task; };
  provider.accepts = () => true;
  provider.materializeImage = async () => ({ blob: new Blob(['png-out'], { type: 'image/png' }), type: 'image/png', bytes: 7, width: 64, height: 64, imageUrl: 'https://www.doubao.com/assets/out.png' });
  provider.cleanup = async task => { if (task.tabOwned && task.tabOwnerToken === 'owner') removed += 1; return true; };
  const submit = await router.submit({ provider: 'doubao', kind: 'image-edit', prompt: '合并全部图片内容', boardId: 'board', sourceInstanceId: 'instance', sourceBoardEpoch: 1, inputAssets: [{ assetId: 'a1', order: 0 }, { assetId: 'a2', order: 1 }] });
  assert.equal(submit.ok, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prepared, 1); assert.equal(sent, 1); assert.deepEqual(sentTask.inputAssetIds, ['a1', 'a2']);
  let task = await router.store.find(submit.taskId);
  const webSender = { id: chrome.runtime.id, frameId: 0, url: 'https://www.doubao.com/chat/', tab: { id: 7 } };
  await router.handleMessage({ type: 'qd-ai-provider-event', taskId: task.taskId, kind: 'phase', stage: 'uploading', progress: 1 }, webSender);
  task = await router.store.find(task.taskId);
  await router.handleMessage({ type: 'qd-ai-provider-event', taskId: task.taskId, kind: 'send-confirmed', requestFingerprint: 'sent-once', requestMessageId: 'doubao-message-42', baselineHashes: [], eventId: 'sent-once' }, webSender);
  assert.equal((await router.store.find(task.taskId)).requestMessageId, 'doubao-message-42');
  await router.handleMessage({ type: 'qd-ai-provider-event', taskId: task.taskId, kind: 'image-reply', phase: 'complete', imageUrl: 'https://www.doubao.com/assets/out.png', eventId: 'result-once' }, webSender);
  task = await router.store.find(task.taskId);
  assert.equal(task.status, 'image-ready');
  await router.handleMessage({ type: 'qd-ai-claim-import', taskId: task.taskId, ownerId: 'instance' }, sender);
  data['quickdraw_v2_file:board'] = { aiTaskReceipts: { [task.taskId]: { taskId: task.taskId } } };
  await router.handleMessage({ type: 'qd-ai-mark-imported', taskId: task.taskId, ownerId: 'instance', targetBoardId: 'board' }, sender);
  assert.equal(removed, 1);
  assert.deepEqual(assets.deleted.sort(), ['a1', 'a2']);
  clearTimers(router);
});

test('豆包认证事件暂停并保留任务；取消可清理 owned tab，user-owned tab 不会关闭', async () => {
  setup(); const router = new Router(); await router.ready;
  const task = { ...AI.createTask({ provider: 'doubao', prompt: '登录后继续', boardId: 'board', sourceInstanceId: 'instance' }), status: 'connecting', stage: 'hydrating', tabId: 9, tabOwned: true, tabOwnerToken: 'owner' };
  await router.store.upsert(task); router.activeByProvider.set('doubao', task.taskId);
  const provider = router.providers.doubao; provider.stop = async () => {}; provider.accepts = () => true;
  let removed = 0; provider.cleanup = async task => { if (!task?.tabOwned) return false; removed += 1; return true; };
  const webSender = { id: chrome.runtime.id, frameId: 0, url: 'https://www.doubao.com/passport/login', tab: { id: 9 } };
  const paused = await router.handleMessage({ type: 'qd-ai-provider-event', taskId: task.taskId, kind: 'needs-attention', code: 'auth-required', error: '豆包需要登录。' }, webSender);
  assert.equal(paused.ok, true); assert.equal((await router.store.find(task.taskId)).status, 'paused');
  const cancelled = await router.handleMessage({ type: 'qd-ai-cancel', taskId: task.taskId }, { id: chrome.runtime.id, frameId: 0, url: 'chrome-extension://doubao-test/sidepanel.html' });
  assert.equal(cancelled.ok, true); assert.equal(removed, 1);
  assert.equal(await provider.cleanup({ tabId: 10, tabOwned: false, tabOwnerToken: '' }), false);
  clearTimers(router);
});

test('豆包多图预览无显式 ready 标记时，全部新图稳定后填入 prompt 并只发送一次', async () => {
  const saved = { document: global.document, location: global.location, chrome: global.chrome, MutationObserver: global.MutationObserver, DataTransfer: global.DataTransfer, File: global.File, HTMLTextAreaElement: global.HTMLTextAreaElement, HTMLInputElement: global.HTMLInputElement, InputEvent: global.InputEvent, getComputedStyle: global.getComputedStyle };
  let previewVisible = false, sendCount = 0; const events = [], users = [];
  class Textarea { constructor() { this._value = ''; this.tagName = 'TEXTAREA'; this.offsetParent = {}; } get value() { return this._value; } set value(v) { this._value = String(v); } focus() {} dispatchEvent() {} getAttribute() { return ''; } getClientRects() { return [{}]; } }
  const promptInput = new Textarea();
  const form = { querySelectorAll: selector => selector === 'img' && previewVisible ? previews : selector.includes('button') ? [send] : [] };
  const uploadInput = { files: [], offsetParent: {}, parentElement: form, closest: () => form, dispatchEvent: event => { if (event.type === 'change') previewVisible = true; }, getAttribute: () => '', getClientRects: () => [{}] };
  const image = src => ({ complete: true, naturalWidth: 256, naturalHeight: 256, currentSrc: src, src, alt: '', className: '', offsetParent: {}, getAttribute: () => '', getClientRects: () => [{}] });
  const previews = [image('blob:https://www.doubao.com/new-a'), image('blob:https://www.doubao.com/new-b')];
  const send = { disabled: false, hidden: false, offsetParent: {}, className: 'send-arrow', textContent: '', getAttribute: () => '', getClientRects: () => [{}], querySelector: selector => selector === 'svg' ? {} : null, click: () => { sendCount += 1; users.push({ innerText: promptInput.value, textContent: promptInput.value, offsetParent: {}, getAttribute: () => '', getClientRects: () => [{}] }); } };
  global.HTMLTextAreaElement = Textarea; global.HTMLInputElement = class {};
  global.InputEvent = class { constructor(type) { this.type = type; } };
  global.DataTransfer = class { constructor() { this.files = []; this.items = { add: value => this.files.push(value) }; } };
  global.File = undefined; global.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  global.location = { origin: 'https://www.doubao.com', href: 'https://www.doubao.com/chat/' };
  global.MutationObserver = class { observe() {} disconnect() {} };
  global.document = {
    body: {},
    querySelector: selector => selector.includes('chat-input') || selector.includes('prompt') || selector.includes('editor') ? null : selector === 'input[type="file"]' ? uploadInput : null,
    querySelectorAll: selector => {
      if (selector === 'textarea') return [promptInput];
      if (selector === 'input[type="file"]') return [uploadInput];
      if (selector === 'img') return previewVisible ? previews : [];
      if (selector.includes('send-button') || selector.includes('submit')) return [];
      const lower = selector.toLowerCase();
      if (lower.includes('stop') || selector.includes('停止') || lower.includes('loading') || lower.includes('challenge') || lower.includes('captcha')) return [];
      if (selector.includes('button') || selector.includes('[role="button"]')) return [send];
      if (selector.includes('data-message-author-role') || selector.includes('conversation-turn')) return users;
      return [];
    }
  };
  global.chrome = { runtime: { id: 'doubao-content-test', sendMessage: async message => { events.push(message); } } };
  try {
    await Content.start('doubao-preview-task', '图1按图2风格上色\n任务编号：doubao-preview-task', 'image-edit', '', ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB']);
    assert.match(promptInput.value, /图1按图2风格上色/); assert.equal(sendCount, 1);
    assert.equal(events.filter(event => event.kind === 'send-confirmed').length, 1);
    assert.equal(events.some(event => event.kind === 'needs-attention'), false);
  } finally {
    const record = Content.active.get('doubao-preview-task'); if (record?.pollTimer) clearTimeout(record.pollTimer); record?.observer?.disconnect?.(); Content.active.delete('doubao-preview-task');
    Object.assign(global, saved);
  }
});

test('豆包 textarea 与富文本编辑器按完整提示词语义回读，换行差异不误报', () => {
  const saved = { document: global.document, InputEvent: global.InputEvent, Event: global.Event, getComputedStyle: global.getComputedStyle };
  global.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  global.InputEvent = class { constructor(type) { this.type = type; } };
  global.Event = class { constructor(type) { this.type = type; } };
  const prompt = '图片编辑助手。\n任务编号：task-rich。\n用户需求：图1按图2风格上色';
  const textarea = { tagName: 'TEXTAREA', value: '', offsetParent: {}, focus() {}, dispatchEvent() {}, getAttribute: () => '', getClientRects: () => [{}] };
  assert.equal(Content.setInputValue(textarea, prompt), true);
  assert.equal(Content.promptMatches(Content.inputText(textarea), prompt), true);
  const textNode = value => ({ nodeType: 3, nodeValue: value, textContent: value });
  const block = (...children) => ({ tagName: 'P', childNodes: children, getAttribute: () => '', hidden: false });
  const rich = { tagName: 'DIV', childNodes: [block(textNode('图片编辑助手。')), block(textNode('任务编号：task-rich。')), block(textNode('用户需求：图1按图2风格上色'))], getAttribute: () => '', hidden: false, offsetParent: {}, getClientRects: () => [{}], focus() {}, dispatchEvent() {} };
  global.document = {};
  assert.equal(Content.editableText(rich), prompt);
  assert.equal(Content.promptMatches(Content.editableText(rich), prompt), true);
  assert.equal(Content.promptMatches('图片编辑助手。\n任务编号：old。\n用户需求：图1按图2风格上色', prompt), false);
  Object.assign(global, saved);
});

test('豆包图片需求为空时编辑器回读为空仍可继续发送流程', async () => {
  const saved = { document: global.document, InputEvent: global.InputEvent, Event: global.Event, getComputedStyle: global.getComputedStyle };
  let value = '旧内容';
  const editor = { tagName: 'TEXTAREA', offsetParent: {}, get value() { return value; }, set value(next) { value = String(next); }, focus() {}, dispatchEvent() {}, getAttribute: () => '', getClientRects: () => [{}] };
  global.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  global.InputEvent = class { constructor(type) { this.type = type; } }; global.Event = class { constructor(type) { this.type = type; } };
  global.document = { querySelectorAll: selector => selector === 'textarea' ? [editor] : [], querySelector: () => null };
  Content.active.set('doubao-empty-prompt-task', {});
  try {
    const result = await Content.fillPrompt('doubao-empty-prompt-task', '');
    assert.equal(result.ok, true);
    assert.equal(value, '');
  } finally { Content.active.delete('doubao-empty-prompt-task'); Object.assign(global, saved); }
});

test('豆包上传后编辑器被替换时重新定位新节点；仍只填词并发送一次', async () => {
  const saved = { document: global.document, location: global.location, chrome: global.chrome, MutationObserver: global.MutationObserver, DataTransfer: global.DataTransfer, File: global.File, HTMLTextAreaElement: global.HTMLTextAreaElement, HTMLInputElement: global.HTMLInputElement, InputEvent: global.InputEvent, Event: global.Event, getComputedStyle: global.getComputedStyle };
  let previewVisible = false, sendCount = 0, currentInput;
  const events = [], users = [];
  const form = { querySelectorAll: selector => selector === 'img' && previewVisible ? previews : selector.includes('button') ? [send] : [] };
  class Textarea {
    constructor(value = '') { this._value = value; this.tagName = 'TEXTAREA'; this.offsetParent = {}; this.parentElement = form; }
    get value() { return this._value; } set value(v) { this._value = String(v); }
    focus() {} dispatchEvent() {} getAttribute() { return ''; } getClientRects() { return [{}]; }
    closest() { return form; }
  }
  const oldInput = new Textarea();
  const newInput = new Textarea();
  currentInput = oldInput;
  const uploadInput = { files: [], type: 'file', offsetParent: {}, parentElement: form, closest: () => form, dispatchEvent: event => { if (event.type === 'change') { previewVisible = true; currentInput = newInput; } }, getAttribute: () => '', getClientRects: () => [{}] };
  const image = src => ({ complete: true, naturalWidth: 256, naturalHeight: 256, currentSrc: src, src, alt: '', className: '', offsetParent: {}, getAttribute: () => '', getClientRects: () => [{}] });
  const previews = [image('blob:https://www.doubao.com/new-a'), image('blob:https://www.doubao.com/new-b')];
  const send = { disabled: false, hidden: false, offsetParent: {}, className: 'send-arrow', textContent: '', getAttribute: () => '', getClientRects: () => [{}], querySelector: selector => selector === 'svg' ? {} : null, click: () => { sendCount += 1; users.push({ innerText: newInput.value, textContent: newInput.value, offsetParent: {}, getAttribute: () => '', getClientRects: () => [{}] }); } };
  global.HTMLTextAreaElement = Textarea; global.HTMLInputElement = class {};
  global.InputEvent = class { constructor(type) { this.type = type; } }; global.Event = class { constructor(type) { this.type = type; } };
  global.DataTransfer = class { constructor() { this.files = []; this.items = { add: value => this.files.push(value) }; } };
  global.File = undefined; global.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  global.location = { origin: 'https://www.doubao.com', href: 'https://www.doubao.com/chat/' };
  global.MutationObserver = class { observe() {} disconnect() {} };
  global.document = {
    body: {},
    querySelector: selector => selector === 'input[type="file"]' ? uploadInput : null,
    querySelectorAll: selector => {
      if (selector === 'textarea') return [currentInput];
      if (selector === 'input') return [uploadInput];
      if (selector === 'input[type="file"]') return [uploadInput];
      if (selector === 'img') return previewVisible ? previews : [];
      if (selector.includes('send-button') || selector.includes('submit')) return [];
      const lower = selector.toLowerCase();
      if (lower.includes('stop') || selector.includes('停止') || lower.includes('loading') || lower.includes('challenge') || lower.includes('captcha')) return [];
      if (selector.includes('button') || selector.includes('[role="button"]')) return [send];
      if (selector.includes('data-message-author-role') || selector.includes('conversation-turn')) return users;
      return [];
    }
  };
  global.chrome = { runtime: { id: 'doubao-editor-replacement-test', sendMessage: async message => { events.push(message); } } };
  try {
    const prompt = '图片编辑助手。\n任务编号：doubao-editor-replacement。\n用户需求：图1按图2风格上色';
    await Content.start('doubao-editor-replacement', prompt, 'image-edit', '', ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB']);
    assert.equal(oldInput.value, '');
    assert.equal(newInput.value, prompt);
    assert.equal(sendCount, 1);
    assert.equal(events.filter(event => event.kind === 'send-confirmed').length, 1);
    assert.equal(events.some(event => event.kind === 'needs-attention'), false);
  } finally {
    const record = Content.active.get('doubao-editor-replacement'); if (record?.pollTimer) clearTimeout(record.pollTimer); record?.observer?.disconnect?.(); Content.active.delete('doubao-editor-replacement');
    Object.assign(global, saved);
  }
});

test('豆包 file picker 覆盖批量文件时立即识别缺图，绝不填词或发送残缺请求', async () => {
  const saved = { document: global.document, location: global.location, DataTransfer: global.DataTransfer, File: global.File, getComputedStyle: global.getComputedStyle };
  const uploadInput = { files: [], type: 'file', offsetParent: {}, getAttribute: () => '', getClientRects: () => [{}], dispatchEvent() {} };
  Object.defineProperty(uploadInput, 'files', { get() { return this._files || []; }, set(value) { this._files = [value?.[value.length - 1]]; } });
  global.DataTransfer = class { constructor() { this.files = []; this.items = { add: value => this.files.push(value) }; } };
  global.File = undefined; global.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  global.location = { origin: 'https://www.doubao.com', href: 'https://www.doubao.com/chat/' };
  global.document = { querySelector: selector => selector === 'input[type="file"]' ? uploadInput : null, querySelectorAll: selector => selector === 'input[type="file"]' ? [uploadInput] : [] };
  global.chrome = { runtime: { id: 'doubao-overwrite-test', sendMessage: async () => {} } };
  Content.active.set('doubao-overwrite-task', {});
  try {
    const result = await Content.attachImagesDetailed([new Blob(['a'], { type: 'image/png' }), new Blob(['b'], { type: 'image/png' })], 'doubao-overwrite-task');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'file-picker-overwrite');
    assert.equal(result.expectedCount, 2);
    assert.equal(result.inputFileCount, 1);
  } finally { Content.active.delete('doubao-overwrite-task'); Object.assign(global, saved); }
});

test('豆包批量 file input 虽保留两文件但最终只显示一张预览时，不视为 ready', async () => {
  const saved = { document: global.document, location: global.location, getComputedStyle: global.getComputedStyle, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout, Date: global.Date };
  let now = 0;
  const image = { complete: true, naturalWidth: 256, naturalHeight: 256, currentSrc: 'blob:https://www.doubao.com/only-last', src: 'blob:https://www.doubao.com/only-last', alt: '', className: '', offsetParent: {}, getAttribute: () => '', getClientRects: () => [{}] };
  const send = { disabled: false, hidden: false, offsetParent: {}, className: 'send-arrow', textContent: '', getAttribute: () => '', getClientRects: () => [{}], querySelector: selector => selector === 'svg' ? {} : null };
  const form = { querySelectorAll: selector => selector === 'img' ? [image] : selector.includes('button') ? [send] : [] };
  const input = { files: [{}, {}], type: 'file', parentElement: form, closest: () => form, offsetParent: {}, getAttribute: () => '', getClientRects: () => [{}] };
  global.location = { origin: 'https://www.doubao.com', href: 'https://www.doubao.com/chat/' };
  global.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  global.Date = { now: () => now };
  global.setTimeout = (callback, delay) => { now += Number(delay) || 0; callback(); return 1; };
  global.clearTimeout = () => {};
  global.document = { querySelector: selector => selector === 'input[type="file"]' ? input : null, querySelectorAll: selector => selector === 'input[type="file"]' ? [input] : selector === 'img' ? [image] : selector.includes('button') ? [send] : [] };
  global.chrome = { runtime: { id: 'doubao-incomplete-preview-test', sendMessage: async () => {} } };
  Content.active.set('doubao-incomplete-preview-task', {});
  try {
    const result = await Content.waitForAttachment('doubao-incomplete-preview-task', input, new Map(), new Map(), 2, { details: true });
    assert.equal(result.ok, false); assert.equal(result.code, 'incomplete'); assert.equal(result.expectedCount, 2); assert.equal(result.readyCount, 1);
  } finally { Content.active.delete('doubao-incomplete-preview-task'); Object.assign(global, saved); }
});

test('豆包编辑器只回读到旧/部分提示词时失败，不进入发送阶段', async () => {
  const saved = { document: global.document, location: global.location, chrome: global.chrome, InputEvent: global.InputEvent, Event: global.Event, getComputedStyle: global.getComputedStyle };
  let value = '旧任务提示';
  const editor = { tagName: 'TEXTAREA', offsetParent: {}, get value() { return value; }, set value(next) { value = '部分提示词'; }, focus() {}, dispatchEvent() {}, getAttribute: () => '', getClientRects: () => [{}] };
  global.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  global.InputEvent = class { constructor(type) { this.type = type; } }; global.Event = class { constructor(type) { this.type = type; } };
  global.location = { origin: 'https://www.doubao.com', href: 'https://www.doubao.com/chat/' };
  global.document = { querySelectorAll: selector => selector === 'textarea' ? [editor] : [], querySelector: () => null };
  global.chrome = { runtime: { id: 'doubao-prompt-fail-test', sendMessage: async () => {} } };
  Content.active.set('doubao-prompt-fail-task', {});
  try {
    const result = await Content.fillPrompt('doubao-prompt-fail-task', '图片编辑助手。\n任务编号：new-task。\n用户需求：完整要求');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'readback-mismatch');
    assert.equal(Content.promptMatches(value, '图片编辑助手。\n任务编号：new-task。\n用户需求：完整要求'), false);
  } finally { Content.active.delete('doubao-prompt-fail-task'); Object.assign(global, saved); }
});

test('豆包真实结果卡无 GPT role/testid 时仍能按任务锚点探测并读取已完成图片', () => {
  const saved = { document: global.document, location: global.location, getComputedStyle: global.getComputedStyle };
  const taskId = 'task-real-dom';
  let order = 0;
  const make = ({ tagName = 'DIV', className = '', text = '', attrs = {}, children = [] } = {}) => {
    const element = {
      tagName, className, textContent: text, innerText: text, hidden: false, disabled: false, offsetParent: {}, parentElement: null,
      childNodes: children, order: order++,
      getAttribute(name) { return attrs[name] || ''; },
      hasAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name); },
      getClientRects() { return [{}]; },
      contains(node) { return node === this || children.some(child => child === node || child.contains?.(node)); },
      compareDocumentPosition(node) { return this.order < node.order ? 4 : (this.order > node.order ? 2 : 0); },
      querySelectorAll(selector) {
        if (selector === 'img') return children.filter(child => child.tagName === 'IMG');
        if (selector === 'button' || selector === '[role="button"]' || selector.includes('button[')) return children.filter(child => child.tagName === 'BUTTON');
        return [];
      },
      closest() { return this; }
    };
    for (const child of children) child.parentElement = element;
    return element;
  };
  const action = make({ tagName: 'BUTTON', text: '点赞' });
  const image = make({ tagName: 'IMG' });
  Object.assign(image, { currentSrc: 'https://www.doubao.com/assets/real-result.png', src: 'https://www.doubao.com/assets/real-result.png', naturalWidth: 512, naturalHeight: 512, complete: true });
  const oldImage = make({ tagName: 'IMG' });
  Object.assign(oldImage, { currentSrc: 'https://www.doubao.com/assets/old-result.png', src: 'https://www.doubao.com/assets/old-result.png', naturalWidth: 512, naturalHeight: 512, complete: true });
  const oldUser = make({ attrs: { 'data-message-id': 'old-user' }, className: 'bubble user-bubble', text: '旧需求。\n任务编号：task-old。' });
  const oldAssistant = make({ attrs: { 'data-message-id': 'old-assistant' }, className: 'bubble assistant-card', text: '已完成图片生成', children: [oldImage, action] });
  const user = make({ attrs: { 'data-message-id': 'user-1' }, className: 'bubble user-bubble', text: `请按图生成。\n任务编号： ${taskId}。` });
  const assistant = make({ attrs: { 'data-message-id': 'assistant-1' }, className: 'bubble assistant-card', text: '已完成图片生成', children: [image, action] });
  global.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  global.location = { origin: 'https://www.doubao.com', href: 'https://www.doubao.com/chat/' };
  global.document = {
    querySelectorAll(selector) {
      if (selector === 'img') return [image];
      if (selector.includes('data-message-id')) return [oldUser, oldAssistant, user, assistant];
      if (selector.includes('data-message-author-role') || selector.includes('conversation-turn') || selector.includes('assistant') || selector.includes('user-message')) return [];
      return [];
    }
  };
  try {
    const state = Content.probeTask(taskId, 'image-edit', 0, [], '');
    assert.equal(state.requestFound, true);
    assert.equal(state.hasReply, true);
    assert.equal(state.imageUrl, 'https://www.doubao.com/assets/real-result.png');
    const reply = Content.findImageReply({ taskId, requestFingerprint: state.requestFingerprint, baselineElements: new Set(), baselineTurnFingerprints: new Map() });
    assert.equal(reply.candidate.imageUrl, state.imageUrl);
  } finally { Object.assign(global, saved); }
});

test('本任务用户两图与生成中占位图不会被通用按钮误判为最终结果', () => {
  const saved = { document: global.document, getComputedStyle: global.getComputedStyle };
  const button = { tagName: 'BUTTON', className: 'icon-button', textContent: '', innerText: '', offsetParent: {}, disabled: false, getAttribute: () => '', getClientRects: () => [{}] };
  const placeholder = { tagName: 'IMG', currentSrc: 'https://p3-flow-imagex-sign.byteimg.com/preview.png', src: 'https://p3-flow-imagex-sign.byteimg.com/preview.png', naturalWidth: 512, naturalHeight: 512, complete: true, className: '', alt: '', offsetParent: {}, getAttribute: () => '', getClientRects: () => [{}], closest: () => null };
  const generating = {
    tagName: 'DIV', className: 'assistant-card', textContent: '正在生成图片', innerText: '正在生成图片', offsetParent: {}, getAttribute: () => '', getClientRects: () => [{}],
    querySelectorAll(selector) { if (selector === 'img') return [placeholder]; if (selector === 'button' || selector === '[role="button"]') return [button]; return []; }
  };
  const stop = { ...button, getAttribute: name => name === 'aria-label' ? '停止生成' : '' };
  global.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  global.document = { querySelectorAll(selector) { if (selector.includes('Stop') || selector.includes('停止')) return [stop]; return []; } };
  try {
    const candidate = Content.imageCandidate({ element: generating });
    assert.ok(candidate);
    assert.equal(Content.hasCompletionEvidence({ element: generating }, candidate), false);
    assert.equal(Content.generationBusy(), true);
  } finally { Object.assign(global, saved); }
});

test('豆包恢复截止时间已过但页面已有本任务结果时只恢复监听并完成导入，不重新发送', async () => {
  setup();
  const assets = {
    deleted: [],
    async getAsset() { return { blob: new Blob(['input'], { type: 'image/png' }) }; },
    async putAsset() { return 'output-existing'; },
    async deleteAsset(id) { this.deleted.push(id); }
  };
  const router = new Router({ assetStore: assets });
  await router.ready;
  const provider = router.providers.doubao;
  let probes = 0, resumed = 0, sends = 0;
  provider.accepts = () => true;
  provider.stop = async () => {};
  provider.cleanup = async () => false;
  provider.send = async () => { sends += 1; };
  provider.probe = async () => {
    probes += 1;
    return { active: false, requestFound: true, requestFingerprint: 'existing-request', hasReply: true, imageUrl: 'https://www.doubao.com/assets/existing.png', imageFingerprint: 'existing-image' };
  };
  provider.materializeImage = async () => ({ blob: new Blob(['output'], { type: 'image/png' }), type: 'image/png', bytes: 6, width: 64, height: 64, imageUrl: 'https://www.doubao.com/assets/existing.png' });
  const task = AI.createTask({ provider: 'doubao', kind: 'image-edit', prompt: '读取页面已有结果', boardId: 'board', sourceInstanceId: 'instance', inputAssetId: 'input-existing' });
  task.status = 'waiting'; task.stage = 'generating'; task.tabId = 17; task.requestFingerprint = 'old-request'; task.stageDeadlineAt = Date.now() - 1; task.deadlineAt = task.stageDeadlineAt;
  await router.store.upsert(task);
  provider.resume = async current => {
    resumed += 1;
    await router.handleMessage({ type: 'qd-ai-provider-event', taskId: current.taskId, kind: 'image-reply', phase: 'complete', imageUrl: 'https://www.doubao.com/assets/existing.png', eventId: 'existing-result-once' }, { id: chrome.runtime.id, frameId: 0, url: 'https://www.doubao.com/chat/', tab: { id: 17 } });
  };
  await router.restore();
  const recovered = await router.store.find(task.taskId);
  assert.equal(probes, 1);
  assert.equal(resumed, 1);
  assert.equal(sends, 0);
  assert.equal(recovered.status, 'image-ready');
  clearTimers(router);
  await router.stopListener(recovered);
});

test('豆包无 role/testid 的真实气泡发送后能识别完成卡，并只回传一次结果', async () => {
  const saved = { document: global.document, location: global.location, chrome: global.chrome, MutationObserver: global.MutationObserver, InputEvent: global.InputEvent, getComputedStyle: global.getComputedStyle };
  const taskId = 'task-send-result'; let order = 0, sendCount = 0; const events = [], users = [], assistants = [];
  class Textarea {
    constructor() { this._value = ''; this.tagName = 'TEXTAREA'; this.offsetParent = {}; }
    get value() { return this._value; } set value(value) { this._value = String(value); }
    focus() {} dispatchEvent() {} getAttribute() { return ''; } getClientRects() { return [{}]; }
    closest() { return form; }
  }
  const make = (className, text) => ({ tagName: 'DIV', className, textContent: text, innerText: text, offsetParent: {}, hidden: false, order: order++, getAttribute: () => '', getClientRects: () => [{}], contains: node => node === this, compareDocumentPosition(node) { return this.order < node.order ? 4 : 2; }, querySelectorAll: () => [], cloneNode() { return { querySelectorAll: () => [], textContent: text }; } });
  const input = new Textarea();
  const send = { tagName: 'BUTTON', className: 'send-arrow', textContent: '', innerText: '', offsetParent: {}, hidden: false, disabled: false, getAttribute: () => '', getClientRects: () => [{}], querySelector: selector => selector === 'svg' ? {} : null, click() {
    sendCount += 1;
    const user = make('bubble user-bubble', `${input.value}`); user.getAttribute = name => name === 'data-message-id' ? `user-${sendCount}` : '';
    users.push(user);
    const assistant = make('bubble assistant-card', '已完成图片生成'); assistant.getAttribute = name => name === 'data-message-id' ? `assistant-${sendCount}` : '';
    assistants.push(assistant);
  } };
  const form = { querySelectorAll: selector => selector.includes('button') || selector.includes('[role="button"]') ? [send] : [] };
  global.InputEvent = class { constructor(type) { this.type = type; } };
  global.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  global.location = { origin: 'https://www.doubao.com', href: 'https://www.doubao.com/chat/' };
  global.MutationObserver = class { observe() {} disconnect() {} };
  global.document = {
    body: {},
    querySelectorAll(selector) {
      if (selector === 'textarea') return [input];
      if (selector.includes('data-message-id')) return [...users, ...assistants];
      const lower = selector.toLowerCase();
      if (lower.includes('stop') || lower.includes('停止') || lower.includes('loading') || lower.includes('challenge') || lower.includes('captcha')) return [];
      if (selector.includes('button') || selector.includes('[role="button"]')) return [send];
      return [];
    },
    querySelector() { return null; }
  };
  global.chrome = { runtime: { id: 'doubao-send-result-test', sendMessage: async event => { events.push(event); } } };
  try {
    await Content.start(taskId, `图片编辑助手。\n任务编号：${taskId}\n用户需求：完成图片`, 'mindmap');
    assert.equal(sendCount, 1);
    assert.equal(events.filter(event => event.kind === 'send-confirmed').length, 1);
    await new Promise(resolve => setTimeout(resolve, 2_200));
    assert.equal(events.filter(event => event.kind === 'reply').length, 1);
    assert.equal(events.some(event => event.kind === 'needs-attention'), false);
  } finally {
    const record = Content.active.get(taskId); if (record?.pollTimer) clearTimeout(record.pollTimer); record?.observer?.disconnect?.(); Content.active.delete(taskId);
    Object.assign(global, saved);
  }
});

test('豆包 MAIN bridge 保留 JSON.parse 语义并只旁路捕获嵌套 creations 原图映射', async () => {
  setup(); const provider = new Doubao(); let injected;
  global.chrome.scripting = { executeScript: async value => { injected = value; if(value.world==='MAIN')return[{result:{installed:true,token:value.args[1],version:2}}]; } };
  await provider.installRawImageBridge({ taskId: 'raw-task', tabId: 7, kind: 'image-edit' });
  const saved = { window: global.window, location: global.location, postMessage: global.postMessage, addEventListener: global.addEventListener, removeEventListener: global.removeEventListener, Response:global.Response };
  const originalParse = JSON.parse, messages = [], listeners = new Map();
  global.window = global; global.location = { href: 'https://www.doubao.com/chat/', origin: 'https://www.doubao.com' };
  global.postMessage = data => messages.push(data); global.addEventListener = (type, fn) => listeners.set(type, fn); global.removeEventListener = (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); };
  try {
    await injected.func(...injected.args);
    const parsed = JSON.parse('{"nested":{"creations":[{"image":{"image_ori":{"url":"https://p3.byteimg.com/preview.png?q=1"},"image_ori_raw":{"url":"https://p9.byteimg.com/raw.png?q=2"}}}]},"n":1}', (key,value)=>key==='n'?2:value);
    assert.equal(parsed.n,2); assert.equal(messages.length,1); assert.deepEqual(messages[0].pairs,[{aliases:['https://p3.byteimg.com/preview.png?q=1','https://p9.byteimg.com/raw.png?q=2'],raw:'https://p9.byteimg.com/raw.png?q=2',identifiers:[]}]);
    const response = new Response(JSON.stringify({creations:[{id:'creation-12345678',image:{image_ori:{url:'https://p3.byteimg.com/different-preview.png'},image_ori_raw:{url:'https://p9.byteimg.com/different-raw.png'}}}]}),{headers:{'content-type':'application/json'}});
    const responseValue=await response.json();assert.equal(responseValue.creations[0].id,'creation-12345678');assert.equal(messages.length,2);assert.equal(messages[1].pairs[0].raw,'https://p9.byteimg.com/different-raw.png');
    assert.throws(()=>JSON.parse('{broken'),SyntaxError);
    const token=injected.args[1];listeners.get('message')?.({source:global,origin:global.location.origin,data:{source:'quickdraw-doubao-raw-cleanup-v1',taskId:'raw-task',bridgeToken:token}});
    assert.equal(JSON.parse,originalParse);
  } finally { JSON.parse=originalParse; Object.assign(global,saved); delete global.__quickdrawDoubaoRawBridgeV1; }
});

test('豆包原图桥接必须在发送命令前得到 MAIN world 安装确认', async()=>{
  setup();const provider=new Doubao();const order=[];
  global.chrome.tabs={get:async()=>({id:7,url:'https://www.doubao.com/chat/'}),sendMessage:async()=>{order.push('command');return{ok:true};}};
  global.chrome.scripting={executeScript:async value=>{if(value.world==='MAIN'){order.push('bridge');return[{result:{installed:true,token:value.args[1],version:2}}];}order.push('content');return[];}};
  await provider.command({taskId:'before-send',tabId:7,kind:'image-edit'},{action:'start'});
  assert.deepEqual(order,['bridge','content','command']);
  global.chrome.scripting.executeScript=async value=>value.world==='MAIN'?[{result:{installed:false,token:value.args[1],version:2}}]:[];
  await assert.rejects(()=>provider.command({taskId:'unconfirmed',tabId:7,kind:'image-edit'},{action:'start'}),/未确认安装/);
});

test('豆包原图映射严格绑定 task、token 与对应预览，旧任务和伪造映射不能串图', () => {
  const saved={location:global.location};global.location={href:'https://www.doubao.com/chat/',origin:'https://www.doubao.com'};
  const record={taskId:'current-task',rawBridgeToken:'secret'};Content.active.set(record.taskId,record);
  const image={tagName:'IMG',currentSrc:'https://p3.byteimg.com/preview.png?display=1',src:'',naturalWidth:512,naturalHeight:512,complete:true,className:'',alt:'',getAttribute:()=>'',getClientRects:()=>[{}],closest:()=>null};
  const turn={element:{querySelectorAll:selector=>selector==='img'?[image]:[]}};
  try {
    assert.equal(Content.acceptRawBridgeMessage(record,{taskId:'old-task',bridgeToken:'secret',pairs:[{preview:image.currentSrc,raw:'https://evil.example/x.png'}]}),false);
    assert.equal(Content.acceptRawBridgeMessage(record,{taskId:record.taskId,bridgeToken:'wrong',pairs:[{preview:image.currentSrc,raw:'https://evil.example/x.png'}]}),false);
    assert.equal(Content.acceptRawBridgeMessage(record,{taskId:record.taskId,bridgeToken:'secret',pairs:[{preview:'https://p3.byteimg.com/other.png',raw:'https://p9.byteimg.com/wrong.png'},{preview:'https://p3.byteimg.com/preview.png?api=1',raw:'https://p9.byteimg.com/raw.png?sig=2'}]}),true);
    const candidate=Content.imageCandidate(turn,record);assert.equal(candidate.previewImageUrl,image.currentSrc);assert.equal(candidate.rawImageUrl,'https://p9.byteimg.com/raw.png?sig=2');assert.equal(candidate.imageUrl,candidate.rawImageUrl);
  } finally { Content.active.delete(record.taskId);Object.assign(global,saved); }
});

test('豆包同一 creation 的预览和原图路径不同时可由明确 identifier 绑定，旧任务不能串图',()=>{
  const saved={location:global.location};global.location={href:'https://www.doubao.com/chat/',origin:'https://www.doubao.com'};
  const record={taskId:'task-current',rawBridgeToken:'token'};Content.active.set(record.taskId,record);
  const image={tagName:'IMG',currentSrc:'https://p3.byteimg.com/render/watermark.webp?image_id=image-12345678',src:'',naturalWidth:512,naturalHeight:512,complete:true,className:'',alt:'',getAttribute:()=>'',getClientRects:()=>[{}],closest:()=>null};
  const turn={element:{querySelectorAll:selector=>selector==='img'?[image]:[]}};
  try{
    assert.equal(Content.acceptRawBridgeMessage(record,{taskId:record.taskId,bridgeToken:'token',pairs:[{aliases:['https://p3.byteimg.com/preview/other.webp'],raw:'https://p9.byteimg.com/raw/original.png',identifiers:['image-12345678']}]}),true);
    assert.equal(Content.imageCandidate(turn,record).rawImageUrl,'https://p9.byteimg.com/raw/original.png');
    assert.equal(Content.imageCandidate(turn,{taskId:'old-task'}).rawImageUrl,'');
  }finally{Content.active.delete(record.taskId);Object.assign(global,saved);}
});

test('豆包已生成页面晚装桥接时只从同一完成卡的明确原图链接恢复',()=>{
  const saved={location:global.location};global.location={href:'https://www.doubao.com/chat/',origin:'https://www.doubao.com'};
  const record={taskId:'late-task',rawBridgeToken:'late-token'};
  const image={tagName:'IMG',currentSrc:'https://p3.byteimg.com/watermarked.webp',src:'',naturalWidth:512,naturalHeight:512,complete:true,className:'',alt:'',getAttribute:()=>'',getClientRects:()=>[{}],closest:()=>null,parentElement:null};
  const rawLink={href:'https://p9.byteimg.com/original.png?sig=1',innerText:'下载原图',textContent:'下载原图',getAttribute:name=>name==='aria-label'?'下载原图':''};
  const unrelated={href:'https://p9.byteimg.com/unrelated.png',innerText:'查看',textContent:'查看',getAttribute:()=>''};
  const card={tagName:'DIV',parentElement:null,querySelectorAll:selector=>selector==='img'?[image]:selector==='a[href]'?[unrelated,rawLink]:[]};image.parentElement=card;
  const turn={element:card};
  try{const candidate=Content.imageCandidate(turn,record);assert.equal(candidate.previewImageUrl,image.currentSrc);assert.equal(candidate.rawImageUrl,rawLink.href);}finally{Object.assign(global,saved);}
});
