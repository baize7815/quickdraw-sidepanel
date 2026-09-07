'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'doubao-content.js'), 'utf8');
const exportPrefix = "if (typeof module !== 'undefined' && module.exports) module.exports = ";
assert.ok(source.includes(exportPrefix), '豆包 content script 应保留可测试导出入口');
const browserSource = source.replace(exportPrefix, 'globalThis.__doubaoContent = ');
const browserChannel = process.env.QD_BROWSER_CHANNEL || 'chrome';
let browser;

test.before(async () => {
  browser = await chromium.launch({ channel: browserChannel, headless: true });
});

test.after(async () => {
  await browser?.close();
});

async function runFixture(kind) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  try {
    await page.setContent('<main id="conversation"></main>');
    await page.addScriptTag({ content: browserSource });
    return await page.evaluate(async kind => {
      const Content = globalThis.__doubaoContent;
      const prompt = '图片编辑助手。\n任务编号：boundary-task。\n用户需求：请将第一张图按第二张图风格上色。';
      const conversation = document.querySelector('#conversation');
      const attr = (element, values) => Object.entries(values).forEach(([name, value]) => element.setAttribute(name, value));
      const text = (tag, value, values = {}) => {
        const element = document.createElement(tag);
        attr(element, values);
        element.textContent = value;
        return element;
      };
      const user = document.createElement('article');
      attr(user, { 'data-message-role': 'user', 'data-message-id': 'request-1', class: 'message user-message' });
      if (kind === 'nested-user-content') {
        const content = text('div', '', { class: 'message-content', 'data-testid': 'message-content' });
        content.append(text('span', prompt, { class: 'message-text', 'data-testid': 'message-text' }));
        content.append(text('span', prompt, { class: 'message-text duplicate', 'data-testid': 'message-text-copy' }));
        for (const source of ['user-image-a', 'user-image-a']) {
          const image = document.createElement('img');
          attr(image, { 'data-testid': 'message-image', 'data-image-id': source });
          content.append(image);
        }
        user.append(content);
      } else {
        user.append(text('p', prompt));
      }
      conversation.append(user);
      const request = Content.taskRequest('boundary-task', '', prompt);
      const record = {
        taskId: 'boundary-task', requestText: prompt,
        requestFingerprint: request?.stableFingerprint || '', requestMessageId: request?.messageId || '',
        baselineElements: new Set(), baselineTurnFingerprints: new Map()
      };

      const resultImage = document.createElement('img');
      resultImage.width = 128;
      resultImage.height = 128;
      resultImage.src = (() => {
        const canvas = document.createElement('canvas');
        canvas.width = 128; canvas.height = 128;
        const context = canvas.getContext('2d');
        context.fillStyle = '#e74c3c'; context.fillRect(0, 0, 128, 128);
        return canvas.toDataURL('image/png');
      })();
      await new Promise((resolve, reject) => { resultImage.onload = resolve; resultImage.onerror = reject; });

      if (kind === 'assistant-restatement') {
        const restatement = document.createElement('article');
        attr(restatement, { 'data-message-role': 'assistant', 'data-message-id': 'assistant-restatement', class: 'message assistant-message' });
        restatement.append(text('p', prompt));
        conversation.append(restatement);
      }

      const result = document.createElement('article');
      attr(result, { 'data-message-role': 'assistant', 'data-message-id': 'assistant-result', class: 'message assistant-message' });
      result.append(text('p', '图片生成完成'));
      result.append(resultImage);
      conversation.append(result);

      if (kind === 'later-user') {
        const later = document.createElement('article');
        attr(later, { 'data-message-role': 'user', 'data-message-id': 'request-2', class: 'message user-message' });
        later.append(text('p', prompt));
        conversation.append(later);
      }

      const users = Content.userMessages(prompt);
      try {
        const reply = Content.findImageReply(record);
        return {
          ok: true,
          users: users.map(message => ({ id: message.messageId, role: message.element.getAttribute('data-message-role') })),
          imageUrl: reply?.candidate?.imageUrl || '', candidates: reply?.candidates?.length || 0
        };
      } catch (error) {
        return {
          ok: false,
          error: String(error?.message || error),
          users: users.map(message => ({ id: message.messageId, role: message.element.getAttribute('data-message-role') }))
        };
      }
    }, kind);
  } finally {
    await page.close();
  }
}

test('豆包：完整用户提示词的 assistant 角色复述不构成后续 user 请求', async () => {
  const result = await runFixture('assistant-restatement');
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.users, [{ id: 'request-1', role: 'user' }]);
  assert.equal(result.candidates, 1);
  assert.match(result.imageUrl, /^data:image\/png;base64,/);
});

test('豆包：同一 user 气泡内重复嵌套图片和文本节点只计为一条请求', async () => {
  const result = await runFixture('nested-user-content');
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.users, [{ id: 'request-1', role: 'user' }]);
  assert.equal(result.candidates, 1);
});

test('豆包：同文本但不同 message-id 的独立后续 user 请求仍会停止监听', async () => {
  const result = await runFixture('later-user');
  assert.equal(result.ok, false);
  assert.match(result.error, /豆包会话中出现了其他请求/);
  assert.deepEqual(result.users, [{ id: 'request-1', role: 'user' }, { id: 'request-2', role: 'user' }]);
});
