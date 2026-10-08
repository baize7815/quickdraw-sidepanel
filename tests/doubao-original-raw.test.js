'use strict';

const assert = require('node:assert/strict');

const saved = {
  AI: globalThis.QuickdrawAI,
  Image: globalThis.QuickdrawAIImage,
  GPT: globalThis.QuickdrawGPTProvider,
  Provider: globalThis.QuickdrawDoubaoProvider,
  chrome: globalThis.chrome,
  window: globalThis.window,
  document: globalThis.document,
  location: globalThis.location,
  Node: globalThis.Node,
  Window: globalThis.Window
};

(async () => {
  const thumb = 'https://p3-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/demo.jpeg~tplv-a9rns2rl98-cthumb_lwm3:test.png';
  const raw = 'https://p26-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/demo.jpeg~tplv-a9rns2rl98-image_raw_hflow:test.png';

  globalThis.QuickdrawAI = {
    DOUBAO_ORIGINS: ['https://www.doubao.com/*'],
    DOUBAO_IMAGE_ORIGINS: ['https://*.doubao.com/*', 'https://*.byteimg.com/*'],
    buildDoubaoPrompt: value => value,
    buildDoubaoImagePrompt: value => value
  };
  globalThis.QuickdrawAIImage = {};
  globalThis.QuickdrawGPTProvider = class {
    constructor(assetStore = null) { this.assetStore = assetStore; }
  };

  const listeners = new Set();
  const page = {};
  globalThis.window = page;
  globalThis.location = { href: 'https://www.doubao.com/chat/123', origin: 'https://www.doubao.com' };
  page.location = globalThis.location;
  page.addEventListener = (type, listener) => { if (type === 'message') listeners.add(listener); };
  page.removeEventListener = (type, listener) => { if (type === 'message') listeners.delete(listener); };
  page.postMessage = data => {
    const event = { source: page, origin: globalThis.location.origin, data };
    for (const listener of [...listeners]) listener(event);
  };

  globalThis.Node = class Node {};
  globalThis.Window = class Window {};
  const body = {};
  const root = { parentElement: body };
  root.__reactFiber$fixture = {
    memoizedProps: {
      media: {
        kind: 'image',
        width: 2048,
        height: 2048,
        imageMeta: {
          thumb: { url: thumb, width: 2048, height: 2048 },
          originalRaw: { url: raw, width: 2048, height: 2048 }
        }
      }
    },
    pendingProps: null,
    return: null
  };
  globalThis.document = {
    body,
    querySelectorAll(selector) {
      return selector.includes('message_image_content') ? [root] : [];
    }
  };
  page.document = globalThis.document;

  let injected = null;
  globalThis.chrome = {
    scripting: {
      async executeScript(options) {
        injected = options.func;
        return [{ result: options.func(...options.args) }];
      }
    }
  };

  require('../quickdraw-sidepanel/ai-doubao-provider.js');
  const Provider = globalThis.QuickdrawDoubaoProvider;
  assert.ok(Provider, 'Doubao provider should load');

  const provider = new Provider();
  const taskId = 'task-original-raw-regression';
  const token = await provider.installRawImageBridge({ taskId, tabId: 1, kind: 'image-edit' });
  assert.ok(injected, 'raw bridge should be injected');
  assert.ok(token, 'raw bridge should return a token');

  let bridgeMessage = null;
  const capture = event => {
    if (event.data?.source === 'quickdraw-doubao-raw-v1') bridgeMessage = event.data;
  };
  page.addEventListener('message', capture);
  page.postMessage({ source: 'quickdraw-doubao-raw-replay-v1', taskId, bridgeToken: token });

  assert.ok(bridgeMessage, 'replay should publish original-image mapping');
  assert.equal(bridgeMessage.taskId, taskId);
  assert.equal(bridgeMessage.pairs.length, 1);
  assert.equal(bridgeMessage.pairs[0].raw, raw);
  assert.ok(bridgeMessage.pairs[0].aliases.includes(thumb), 'thumbnail must map to originalRaw');
  assert.ok(bridgeMessage.pairs[0].aliases.includes(raw), 'raw URL must remain an alias');
  assert.equal(provider.isAllowedOutputImageUrl(raw), true);
  assert.deepEqual(provider.getOutputPermissionOrigins(raw), ['https://*.byteimg.com/*']);

  page.postMessage({ source: 'quickdraw-doubao-raw-cleanup-v1', taskId, bridgeToken: token });
  console.log('doubao originalRaw regression: ok');
})().finally(() => {
  globalThis.QuickdrawAI = saved.AI;
  globalThis.QuickdrawAIImage = saved.Image;
  globalThis.QuickdrawGPTProvider = saved.GPT;
  globalThis.QuickdrawDoubaoProvider = saved.Provider;
  globalThis.chrome = saved.chrome;
  globalThis.window = saved.window;
  globalThis.document = saved.document;
  globalThis.location = saved.location;
  globalThis.Node = saved.Node;
  globalThis.Window = saved.Window;
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});