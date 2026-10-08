'use strict';

const assert = require('node:assert/strict');

const saved = {
  loaded: globalThis.__quickdrawDoubaoContentLoaded,
  location: globalThis.location,
  addEventListener: globalThis.addEventListener,
  postMessage: globalThis.postMessage,
  getComputedStyle: globalThis.getComputedStyle,
  chrome: globalThis.chrome,
  document: globalThis.document
};

class FakeElement {
  constructor(tagName, text = '', attrs = {}) {
    this.tagName = String(tagName || 'DIV').toUpperCase();
    this.innerText = text;
    this.textContent = text;
    this.className = attrs.className || '';
    this.id = attrs.id || '';
    this.type = attrs.type || '';
    this.hidden = false;
    this.disabled = false;
    this.isConnected = true;
    this.isContentEditable = attrs.contenteditable === 'true';
    this.parentElement = null;
    this.children = [];
    this._attrs = new Map(Object.entries(attrs));
    this.offsetParent = {};
  }
  append(child) { child.parentElement = this; this.children.push(child); return child; }
  getAttribute(name) { return this._attrs.get(name) ?? null; }
  hasAttribute(name) { return this._attrs.has(name); }
  getClientRects() { return [{ width: 20, height: 20 }]; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  closest(selector) {
    if (/form|composer|chat-input|input-area|footer/i.test(String(selector)) && /composer/i.test(this.className)) return this;
    return this.parentElement?.closest?.(selector) || null;
  }
}

try {
  delete globalThis.__quickdrawDoubaoContentLoaded;
  globalThis.location = { href: 'https://www.doubao.com/chat/fixture', origin: 'https://www.doubao.com' };
  globalThis.addEventListener = () => {};
  globalThis.postMessage = () => {};
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  globalThis.chrome = { runtime: { id: 'fixture', onMessage: { addListener() {} } } };

  const body = new FakeElement('body');
  const composer = body.append(new FakeElement('div', '', { className: 'composer-root' }));
  const input = composer.append(new FakeElement('div', '', { contenteditable: 'true', role: 'textbox' }));
  const prompt = '生成一只水彩猫1:1';
  const oldBubble = body.append(new FakeElement('div', prompt));

  const allNodes = () => {
    const out = [];
    const walk = node => { for (const child of node.children) { out.push(child); walk(child); } };
    walk(body);
    return out;
  };
  globalThis.document = {
    body,
    querySelectorAll(selector) {
      const s = String(selector);
      if (s === 'body *') return allNodes();
      if (/contenteditable|role="textbox"|textarea|input/.test(s)) return [input];
      return [];
    }
  };
  const api = require('../quickdraw-sidepanel/doubao-content.js');
  const baseline = api.userMessages(prompt);
  assert.equal(baseline.length, 1, 'baseline should discover an existing hashed-class user bubble');
  assert.equal(baseline[0].element, oldBubble);

  const newBubble = body.append(new FakeElement('div', prompt));
  const request = api.taskRequest('task-send-confirmation', '', prompt, {
    baselineUserElements: new Set(baseline.map(item => item.element)),
    baselineUserKeys: new Set(),
    allowLegacyMarker: false
  });
  assert.ok(request, 'new hashed-class user bubble should confirm the sent request');
  assert.equal(request.element, newBubble);
  assert.equal(request.text, prompt);

  const inputEcho = composer.append(new FakeElement('div', prompt));
  const later = api.userMessages(prompt);
  assert.ok(later.every(item => item.element !== inputEcho), 'composer echoes must not be treated as sent requests');

  // Doubao can prepend a generation-mode label to an otherwise identical prompt.
  const prefixedBubble = body.append(new FakeElement('div', `生成图片：${prompt.replace('猫1', '猫 1')}`));
  assert.equal(api.promptMatches('生成一只水彩猫 1:1', prompt), false, 'editor readback must remain strict');
  assert.equal(api.bubbleMatchesPrompt('生成一只水彩猫 1:1', prompt), true, 'site-added Han/digit space should match sent bubble');
  assert.equal(api.bubbleMatchesPrompt('red cat', 'redcat'), false, 'unrelated word spacing must not be ignored');
  const nextRequest = api.taskRequest('task-prefixed-send', '', prompt, {
    baselineUserElements: new Set([oldBubble, newBubble]),
    baselineUserKeys: new Set(),
    allowLegacyMarker: false
  });
  assert.equal(nextRequest?.element, prefixedBubble, 'prefixed bubble should confirm the next request');
  const noFresh = api.taskRequest('task-no-duplicate', '', prompt, {
    baselineUserElements: new Set([oldBubble, newBubble, prefixedBubble]),
    baselineUserKeys: new Set(),
    allowLegacyMarker: false
  });
  assert.equal(noFresh, null, 'an old prompt must never confirm an unsent request');
  // A user message containing only an attachment is still a valid request.
  const imageOnly = body.append(new FakeElement('div', '', { 'data-message-author-role': 'user' }));
  imageOnly.querySelector = selector => /img|data-asset-id|attachment/i.test(selector) ? {} : null;
  const queryBeforeImage = globalThis.document.querySelectorAll;
  globalThis.document.querySelectorAll = selector => {
    if (String(selector).includes('data-message-author-role="user"')) return [imageOnly];
    return queryBeforeImage(selector);
  };
  assert.ok(api.userMessages('').some(item => item.element === imageOnly), 'attachment-only user bubble must remain discoverable');

  console.log('doubao hashed and prefixed send confirmation: ok');
} finally {
  if (saved.loaded === undefined) delete globalThis.__quickdrawDoubaoContentLoaded;
  else globalThis.__quickdrawDoubaoContentLoaded = saved.loaded;
  globalThis.location = saved.location;
  globalThis.addEventListener = saved.addEventListener;
  globalThis.postMessage = saved.postMessage;
  globalThis.getComputedStyle = saved.getComputedStyle;
  globalThis.chrome = saved.chrome;
  globalThis.document = saved.document;
}