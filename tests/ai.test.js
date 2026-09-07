'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AI = require('../ai-protocol.js');
const Router = require('../ai-router.js');
require('../core-utils.js');
require('../vector-utils.js');
require('../editing-tools.js');
require('../sidepanel.js');

test('AI Mermaid 校验接受唯一原始或代码围栏 flowchart，并统计节点连线', () => {
  const raw = 'flowchart TD\nA([开始]) -->|通过| B{检查}\nB --> C[完成]';
  const fenced = `\`\`\`mermaid\n${raw}\n\`\`\``;
  for (const value of [raw, fenced]) {
    const result = AI.validateMermaid(value);
    assert.equal(result.ok, true);
    assert.deepEqual(result.stats, { nodes: 3, edges: 2 });
    assert.equal(result.parsed.direction, 'TD');
  }
});

test('AI Mermaid 校验拒绝额外文字、链式边和未支持语法', () => {
  const invalid = [
    'flowchart TD',
    'flowchart TD\nA[x]; B[y]',
    'flowchart TD\nA --> B trailing',
    '说明文字\nflowchart TD\nA --> B',
    'flowchart TD\nA --> B --> C',
    'flowchart TD\nsubgraph X\nA --> B\nend',
    '```mermaid\nflowchart TD\nA --> B\n```\n补充说明'
  ];
  for (const value of invalid) assert.equal(AI.validateMermaid(value).ok, false);
  assert.equal(AI.validateMermaid('x'.repeat(AI.MAX_REPLY_LENGTH + 1)).ok, false);
});

test('GPT 提示词强制受限 flowchart 输出并保留用户需求', () => {
  const prompt = AI.buildGPTPrompt('做一个外卖系统的开发架构交互流程图');
  assert.match(prompt, /只输出一份可解析的 Mermaid flowchart/);
  assert.match(prompt, /禁止 subgraph/);
  assert.match(prompt, /外卖系统/);
});

test('图片编辑需求可为空，GPT 保留任务锚点、豆包保持空文本且脑图需求继续必填', () => {
  const gptPrompt = AI.buildGPTImagePrompt('', 'task-image-empty');
  const doubaoPrompt = AI.buildDoubaoImagePrompt('   ', 'task-doubao-empty');
  assert.match(gptPrompt, /任务编号：task-image-empty/);
  assert.equal(doubaoPrompt, '');
  assert.doesNotMatch(gptPrompt, /用户需求：/);
  assert.doesNotMatch(doubaoPrompt, /用户需求：/);
  const task = AI.createTask({ provider: 'gpt', kind: 'image-edit', prompt: '', boardId: 'board-a', sourceInstanceId: 'instance-a', inputAssetId: 'input' });
  assert.equal(task.prompt, '');
  assert.throws(() => AI.createTask({ provider: 'gpt', prompt: '', boardId: 'board-a', sourceInstanceId: 'instance-a' }), /请输入 AI 脑图需求/);
});

test('AI 任务固定 GPT Provider 并限制自动导入归属', () => {
  const task = AI.createTask({ provider: 'gpt', prompt: '做一个外卖系统流程图', boardId: 'board-a', sourceInstanceId: 'instance-a', sourceBoardEpoch: 3, sourceRevision: 2 });
  assert.equal(task.provider, 'gpt');
  assert.equal(AI.canAutoImport(task, { instanceId: 'instance-a', boardId: 'board-a', boardEpoch: 3, loading: false }), false);
  const ready = { ...task, status: 'ready' };
  assert.equal(AI.canAutoImport(ready, { instanceId: 'instance-a', boardId: 'board-a', boardEpoch: 3, loading: false }), true);
  assert.equal(AI.canAutoImport(ready, { instanceId: 'instance-a', boardId: 'board-b', boardEpoch: 3, loading: false }), false);
  assert.equal(AI.canAutoImport(ready, { instanceId: 'instance-a', boardId: 'board-a', boardEpoch: 4, loading: false }), false);
});

test('AI 事件指纹可去重，恢复只监听不重发', () => {
  const event = { taskId: 'task-1', kind: 'reply', text: 'flowchart TD\nA --> B' };
  assert.equal(AI.eventKey(event), AI.eventKey({ ...event }));
  const task = { status: 'waiting', deadlineAt: Date.now() + 30_000 };
  assert.equal(AI.shouldResumeWithoutResend(task), true);
  assert.equal(AI.shouldResumeWithoutResend({ ...task, deadlineAt: Date.now() - 1 }), false);
});

test('GPT 消息只允许绑定域名，避免把任意网页当作 Provider', () => {
  assert.equal(AI.isAllowedGPTUrl('https://chatgpt.com/'), true);
  assert.equal(AI.isAllowedGPTUrl('https://chat.openai.com/c/abc'), true);
  assert.equal(AI.isAllowedGPTUrl('https://evilchatgpt.com/'), false);
  assert.equal(AI.isAllowedGPTUrl('https://example.com/'), false);
});

test('路由器串行门禁可阻止 Promise.all 并发状态操作', async () => {
  const router = Object.create(Router.prototype);
  router.operationQueue = Promise.resolve();
  let active = 0;
  let maximum = 0;
  const operation = async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
  };
  await Promise.all([router.serialize(operation), router.serialize(operation), router.serialize(operation)]);
  assert.equal(maximum, 1);
});
