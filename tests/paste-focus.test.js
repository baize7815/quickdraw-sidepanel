const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

let browser;
let context;
let page;
let server;
let origin;

const clipboardPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function startServer(root) {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      const file = path.resolve(root, `.${decodeURIComponent(pathname)}`);
      if (!file.startsWith(root + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      const types = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.png': 'image/png',
        '.wasm': 'application/wasm'
      };
      fs.readFile(file, (error, data) => {
        if (error) {
          res.writeHead(404).end();
          return;
        }
        res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
        if (path.extname(file) === '.html') {
          const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
          const csp = manifest.content_security_policy;
          res.setHeader(
            'Content-Security-Policy',
            path.basename(file) === 'opencv-sandbox.html' ? csp.sandbox : csp.extension_pages
          );
        }
        res.end(data);
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function resetBoard() {
  await page.evaluate(() => {
    const board = window.quickdraw;
    board.closeAIMindmapDialog?.();
    board.elements = [];
    board.currentElement = null;
    board.clearSelection();
    board.setTool('select');
    board.scale = 1;
    board.offsetX = 0;
    board.offsetY = 0;
    board.snapToGrid = false;
    board.resetHistory();
    board.renderNow();
  });
}

async function addTestImage() {
  await page.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'image/png' });
    await quickdraw.insertImage(blob, 300, 300);
  }, clipboardPngBase64);
  await page.waitForFunction(() => !document.querySelector('#btn-ai-edit').disabled);
}

async function dispatchClipboard(selector, { text, image = false } = {}) {
  return page.evaluate(({ selector, text, image, png }) => {
    const target = document.querySelector(selector);
    if (!target) throw new Error(`Clipboard target not found: ${selector}`);
    const transfer = new DataTransfer();
    if (text != null) transfer.setData('text/plain', text);
    if (image) {
      const bytes = Uint8Array.from(atob(png), char => char.charCodeAt(0));
      transfer.items.add(new File([bytes], 'clipboard.png', { type: 'image/png' }));
    }
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer
    });
    const dispatched = target.dispatchEvent(event);
    return {
      dispatched,
      defaultPrevented: event.defaultPrevented,
      types: [...transfer.items].map(item => item.type),
      target: document.activeElement?.id || document.activeElement?.tagName || ''
    };
  }, { selector, text, image, png: clipboardPngBase64 });
}

before(async () => {
  const root = path.resolve(__dirname, '..');
  const port = await startServer(root);
  origin = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({ channel: process.env.QD_BROWSER_CHANNEL || 'chrome', headless: true });
  context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  // This test writes only a known fixture value and never reads pre-existing
  // clipboard contents.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  page = await context.newPage();
  await page.goto(`${origin}/sidepanel.html`);
  await page.waitForFunction(() => window.quickdraw?.fileIndex);
});

after(async () => {
  await context?.close();
  await browser?.close();
  await new Promise(resolve => (server ? server.close(resolve) : resolve()));
});

test('AI 脑图和图片编辑输入框点击后可键入并接收隔离剪贴板纯文本', async () => {
  await resetBoard();
  await page.locator('#btn-ai-mindmap').click();
  await page.waitForFunction(() => document.activeElement?.id === 'ai-mindmap-input');
  await page.keyboard.type('脑图输入');
  assert.equal(await page.locator('#ai-mindmap-input').inputValue(), '脑图输入');
  await page.evaluate(async () => navigator.clipboard.writeText('纯文本粘贴'));
  await page.keyboard.press('Control+V');
  await page.waitForFunction(() => document.querySelector('#ai-mindmap-input').value === '脑图输入纯文本粘贴');
  assert.equal(await page.locator('#ai-mindmap-input').inputValue(), '脑图输入纯文本粘贴');
  await page.locator('#ai-mindmap-cancel').click();

  await resetBoard();
  await addTestImage();
  await page.locator('#btn-ai-edit').click();
  await page.waitForFunction(() => document.activeElement?.id === 'ai-mindmap-input');
  await page.keyboard.type('图片编辑输入');
  assert.equal(await page.locator('#ai-mindmap-input').inputValue(), '图片编辑输入');
  await page.locator('#ai-mindmap-cancel').click();
});

test('文本控件中的混合 text+image 粘贴不拦截也不导入画板', async () => {
  await resetBoard();
  await page.locator('#btn-ai-mindmap').click();
  await page.waitForFunction(() => document.activeElement?.id === 'ai-mindmap-input');
  const result = await dispatchClipboard('#ai-mindmap-input', { text: '混合粘贴文本', image: true });
  await page.waitForTimeout(150);
  const state = await page.evaluate(() => ({
    elements: quickdraw.elements.length,
    images: quickdraw.elements.filter(element => element.type === 'image').length,
    value: document.querySelector('#ai-mindmap-input').value
  }));
  assert.equal(result.defaultPrevented, false);
  assert.deepEqual(result.types.sort(), ['image/png', 'text/plain']);
  assert.equal(state.images, 0);
  assert.equal(state.value, '');
  await page.locator('#ai-mindmap-cancel').click();
});

test('对话框可见且焦点位于按钮时图片粘贴不导入画板', async () => {
  await resetBoard();
  await page.locator('#btn-ai-mindmap').click();
  await page.locator('#ai-mindmap-cancel').focus();
  const result = await dispatchClipboard('#ai-mindmap-cancel', { image: true });
  await page.waitForTimeout(150);
  const images = await page.evaluate(() => quickdraw.elements.filter(element => element.type === 'image').length);
  assert.equal(result.defaultPrevented, false);
  assert.equal(images, 0);
  await page.locator('#ai-mindmap-cancel').click();
});

test('画布目标的图片粘贴仍导入一个图片对象', async () => {
  await resetBoard();
  const result = await dispatchClipboard('#canvas-container', { image: true });
  await page.waitForFunction(() => quickdraw.elements.filter(element => element.type === 'image').length === 1);
  const state = await page.evaluate(() => ({
    images: quickdraw.elements.filter(element => element.type === 'image').length,
    selected: quickdraw.selectedElements.map(element => element.type)
  }));
  assert.equal(result.defaultPrevented, true);
  assert.equal(state.images, 1);
  assert.deepEqual(state.selected, ['image']);
});

test('AI 对话框打开后立即关闭不会在延迟回调中聚焦隐藏输入框', async () => {
  await resetBoard();
  await page.evaluate(() => {
    const dialog = document.querySelector('#ai-mindmap-dialog');
    const input = document.querySelector('#ai-mindmap-input');
    input.__pasteFocusCalls = [];
    input.__pasteFocusOriginal = input.focus;
    input.focus = function (...args) {
      this.__pasteFocusCalls.push({ hidden: dialog.hidden });
      return this.__pasteFocusOriginal.apply(this, args);
    };
    quickdraw.openAIMindmapDialog();
    quickdraw.closeAIMindmapDialog();
  });
  await page.waitForTimeout(30);
  let result = await page.evaluate(() => ({
    hidden: document.querySelector('#ai-mindmap-dialog').hidden,
    active: document.activeElement?.id || '',
    focusedWhileHidden: document.querySelector('#ai-mindmap-input').__pasteFocusCalls.some(call => call.hidden)
  }));
  assert.equal(result.hidden, true);
  assert.notEqual(result.active, 'ai-mindmap-input');
  assert.equal(result.focusedWhileHidden, false);
  await page.evaluate(() => {
    const input = document.querySelector('#ai-mindmap-input');
    input.focus = input.__pasteFocusOriginal;
    delete input.__pasteFocusOriginal;
    delete input.__pasteFocusCalls;
  });

  await addTestImage();
  await page.evaluate(() => {
    const dialog = document.querySelector('#ai-mindmap-dialog');
    const input = document.querySelector('#ai-mindmap-input');
    input.__pasteFocusCalls = [];
    input.__pasteFocusOriginal = input.focus;
    input.focus = function (...args) {
      this.__pasteFocusCalls.push({ hidden: dialog.hidden });
      return this.__pasteFocusOriginal.apply(this, args);
    };
    quickdraw.openAIImageDialog();
    quickdraw.closeAIMindmapDialog();
  });
  await page.waitForTimeout(30);
  result = await page.evaluate(() => ({
    hidden: document.querySelector('#ai-mindmap-dialog').hidden,
    active: document.activeElement?.id || '',
    focusedWhileHidden: document.querySelector('#ai-mindmap-input').__pasteFocusCalls.some(call => call.hidden)
  }));
  assert.equal(result.hidden, true);
  assert.notEqual(result.active, 'ai-mindmap-input');
  assert.equal(result.focusedWhileHidden, false);
  await page.evaluate(() => {
    const input = document.querySelector('#ai-mindmap-input');
    input.focus = input.__pasteFocusOriginal;
    delete input.__pasteFocusOriginal;
    delete input.__pasteFocusCalls;
  });
});

test('contenteditable 编辑器获得焦点时全局工具快捷键不切换画布工具', async () => {
  await resetBoard();
  await page.evaluate(() => {
    const editor = document.createElement('div');
    editor.id = 'paste-focus-contenteditable';
    editor.contentEditable = 'true';
    editor.textContent = '';
    editor.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:40px;background:white;';
    document.body.append(editor);
    quickdraw.setTool('select');
    editor.focus();
  });
  await page.keyboard.press('t');
  const result = await page.evaluate(() => ({
    tool: quickdraw.currentTool,
    text: document.querySelector('#paste-focus-contenteditable').textContent
  }));
  assert.equal(result.tool, 'select');
  assert.equal(result.text, 't');
  await page.evaluate(() => document.querySelector('#paste-focus-contenteditable')?.remove());
});
