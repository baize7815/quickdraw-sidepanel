const test = require('node:test');
const assert = require('node:assert/strict');
require('../ai-protocol.js');
const Router = require('../ai-router.js');
test('GPT image failure retains the page and detaches it from subsequent tasks', async () => {
  const calls = [];
  const router = Object.create(Router.prototype);
  Object.assign(router, {
    providers: { gpt: { detach: async () => calls.push('detach') } },
    stopListener: async () => calls.push('stop'),
    cleanupOwnedTab: async () => calls.push('close'),
    update: async (task, patch) => ({ ...task, ...patch }),
    cleanupInput: async () => {}, release: () => {}
  });
  const task = { provider: 'gpt', kind: 'image-edit' };
  const result = await router.finishActive(task, 'needs-attention', 'upload detection failed');
  assert.equal(result.status, 'needs-attention');
  assert.deepEqual(calls, ['stop', 'detach']);
  calls.length = 0;
  await router.finishActive(task, 'cancelled', 'cancelled');
  assert.deepEqual(calls, ['stop', 'close']);
});
