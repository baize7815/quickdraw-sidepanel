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

try {
  delete globalThis.__quickdrawDoubaoContentLoaded;
  globalThis.location = { href: 'https://www.doubao.com/chat/fixture', origin: 'https://www.doubao.com' };
  globalThis.addEventListener = () => {};
  globalThis.postMessage = () => {};
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  globalThis.chrome = { runtime: { id: 'fixture', onMessage: { addListener() {} } } };
  globalThis.document = { querySelectorAll() { return []; } };

  const api = require('../quickdraw-sidepanel/doubao-content.js');

  const source = '/tos-cn-i-a9rns2rl98/rc_gen_image/0f4d2a1234567890abcdef1234567890.jpeg';
  const thumb = `https://p3-flow-imagex-sign.byteimg.com${source}~tplv-a9rns2rl98-cthumb_lwm3:0:0.jpeg`;
  const preview = `https://p9-flow-imagex-sign.byteimg.com${source}~tplv-a9rns2rl98-cpreview:0:0.jpeg`;
  const raw = `https://p26-flow-imagex-sign.byteimg.com${source}~tplv-a9rns2rl98-image_raw_hflow:0:0.jpeg`;

  const record = { taskId: 'task-original-only', rawBridgeToken: 'bridge-token' };
  const accepted = api.acceptRawBridgeMessage(record, {
    taskId: record.taskId,
    bridgeToken: record.rawBridgeToken,
    pairs: [{ raw, aliases: [thumb, raw], identifiers: [] }]
  });
  assert.equal(accepted, true);

  const card = {
    tagName: 'DIV',
    querySelectorAll(selector) { return selector === 'img' ? [thumbImage, previewImage] : []; }
  };
  const makeImage = (url, size) => ({
    tagName: 'IMG',
    currentSrc: url,
    src: url,
    alt: 'generated result',
    className: 'generated-image',
    complete: true,
    naturalWidth: size,
    naturalHeight: size,
    width: size,
    height: size,
    parentElement: card,
    getBoundingClientRect() { return { width: size, height: size }; },
    getAttribute(name) {
      if (name === 'src') return url;
      if (name === 'srcset' || name === 'data-src' || name === 'aria-label') return '';
      return '';
    },
    closest() { return null; }
  });
  const thumbImage = makeImage(thumb, 384);
  const previewImage = makeImage(preview, 1024);

  const candidates = api.imageCandidates({ element: card }, record);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].imageUrl, raw);
  assert.equal(candidates[0].rawImageUrl, raw);
  assert.equal(candidates[1].imageUrl, raw, 'preview variant should resolve to the same original raw URL');
  assert.equal(candidates[1].rawImageUrl, raw);

  const deduped = api.dedupeImageCandidates(candidates);
  assert.equal(deduped.length, 1, 'thumbnail/preview variants must collapse to one output');
  assert.equal(deduped[0].imageUrl, raw);
  assert.notEqual(deduped[0].imageUrl, thumb);
  assert.notEqual(deduped[0].imageUrl, preview);

  console.log('doubao original-only mapping: ok');
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