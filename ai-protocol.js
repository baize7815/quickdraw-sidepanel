(() => {
  'use strict';

  const MAX_PROMPT_LENGTH = 4_000;
  const MAX_REPLY_LENGTH = 60_000;
  const MAX_MERMAID_LINES = 100;
  const MAX_MERMAID_NODES = 80;
  const MAX_MERMAID_EDGES = 120;
  const MAX_LABEL_LENGTH = 280;
  const MAX_TASKS = 24;
  const MAX_INPUT_IMAGES = 4;

  const GPT_ORIGINS = Object.freeze([
    'https://chatgpt.com/*',
    'https://chat.openai.com/*'
  ]);
  const GPT_IMAGE_ORIGINS = Object.freeze([
    'https://*.oaiusercontent.com/*',
    'https://oaidalleapiprodscus.blob.core.windows.net/*'
  ]);
  const GPT_AUTH_ORIGINS = Object.freeze(['https://auth.openai.com/*']);
  const DOUBAO_ORIGINS = Object.freeze(['https://www.doubao.com/*']);
  const DOUBAO_IMAGE_ORIGINS = Object.freeze(['https://*.doubao.com/*', 'https://*.byteimg.com/*']);
  const GROK_ORIGINS = Object.freeze(['https://grok.com/*']);
  const GROK_AUTH_ORIGINS = Object.freeze(['https://accounts.x.ai/*']);
  const STAGES = Object.freeze({
    queued: Object.freeze({ timeout: 30_000, order: 0 }),
    'page-loading': Object.freeze({ timeout: 120_000, order: 1 }),
    hydrating: Object.freeze({ timeout: 120_000, order: 2 }),
    uploading: Object.freeze({ timeout: 180_000, order: 3 }),
    sending: Object.freeze({ timeout: 60_000, order: 4 }),
    generating: Object.freeze({ timeout: 1_200_000, order: 5 }),
    returning: Object.freeze({ timeout: 60_000, order: 6 })
  });

  const PROVIDERS = Object.freeze({
    gpt: Object.freeze({
      id: 'gpt',
      label: 'GPT',
      enabled: true,
      capabilities: Object.freeze({ text: true, mermaid: true, image: true }),
      origins: GPT_ORIGINS,
      authOrigins: GPT_AUTH_ORIGINS,
      imageOrigins: GPT_IMAGE_ORIGINS,
      maxInputImages: MAX_INPUT_IMAGES
    }),
    doubao: Object.freeze({
      id: 'doubao',
      label: '豆包',
      enabled: true,
      capabilities: Object.freeze({ text: true, mermaid: true, image: true }),
      origins: DOUBAO_ORIGINS,
      authOrigins: Object.freeze([]),
      imageOrigins: DOUBAO_IMAGE_ORIGINS,
      maxInputImages: MAX_INPUT_IMAGES
    }),
    grok: Object.freeze({
      id: 'grok',
      label: 'Grok',
      enabled: true,
      capabilities: Object.freeze({ text: false, mermaid: false, image: true }),
      origins: GROK_ORIGINS,
      authOrigins: GROK_AUTH_ORIGINS,
      imageOrigins: Object.freeze([]),
      maxInputImages: MAX_INPUT_IMAGES
    }),
    deepseek: Object.freeze({
      id: 'deepseek',
      label: 'DeepSeek',
      enabled: false,
      capabilities: Object.freeze({ text: false, mermaid: false, image: false }),
      origins: Object.freeze([])
    })
  });

  const ACTIVE_STATUSES = new Set(['queued', 'connecting', 'sending', 'waiting', 'validating', 'importing', 'paused']);
  const FINAL_STATUSES = new Set(['imported', 'failed', 'needs-attention', 'cancelled']);

  function randomId(prefix = 'ai') {
    try {
      if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID()}`;
    } catch {}
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function limitText(value, max) {
    return String(value ?? '').slice(0, max);
  }

  function provider(id) {
    return PROVIDERS[String(id || '').toLowerCase()] || null;
  }

  function isAllowedGPTUrl(url) {
    try {
      const parsed = new URL(String(url || ''));
      return parsed.protocol === 'https:' && !parsed.port && !parsed.username && !parsed.password &&
        (parsed.hostname === 'chatgpt.com' || parsed.hostname === 'chat.openai.com');
    } catch {
      return false;
    }
  }

  function isAllowedGPTAuthUrl(url) {
    try {
      const parsed = new URL(String(url || ''));
      return parsed.protocol === 'https:' && !parsed.port && !parsed.username && !parsed.password && parsed.hostname === 'auth.openai.com';
    } catch { return false; }
  }

  function normalizeMermaidResponse(value) {
    const raw = String(value ?? '').trim();
    if (!raw) throw new Error('GPT 没有返回 Mermaid 内容。');
    const matches = [...raw.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)];
    if (matches.length) {
      if (matches.length !== 1) throw new Error('GPT 返回了多个代码块。');
      const match = matches[0];
      const before = raw.slice(0, match.index).trim();
      const after = raw.slice(match.index + match[0].length).trim();
      const info = String(match[1] || '').trim().toLowerCase();
      if (before || after || (info && info !== 'mermaid')) throw new Error('Mermaid 代码块外存在无法确认的文字。');
      return match[2].trim();
    }
    if (raw.includes('```')) throw new Error('Mermaid 代码围栏不完整。');
    return raw;
  }

  function cleanLabel(value) {
    let text = String(value ?? '').trim();
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1);
    return text.replace(/\\"/g, '"').replace(/<br\s*\/?>/gi, '\n').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }

  function parseNodeToken(token) {
    const raw = String(token || '').trim().replace(/;\s*$/, '');
    const match = raw.match(/^([A-Za-z_][\w-]*)([\s\S]*)$/);
    if (!match) return null;
    const id = match[1];
    const tail = match[2].trim();
    if (!tail) return { id, text: id, shape: 'rect', explicit: false };
    const patterns = [
      [/^\(\[([\s\S]*)\]\)$/, 'pill'],
      [/^\{([\s\S]*)\}$/, 'diamond'],
      [/^\(\(([\s\S]*)\)\)$/, 'ellipse'],
      [/^\[([\s\S]*)\]$/, 'rect'],
      [/^\(([\s\S]*)\)$/, 'rounded']
    ];
    for (const [pattern, shape] of patterns) {
      const found = tail.match(pattern);
      if (!found) continue;
      const text = cleanLabel(found[1]);
      if (!text || text.length > MAX_LABEL_LENGTH || /[\r\n;\[\]{}()|]/.test(text) || /%%|-->|[<>]/.test(text)) return null;
      return { id, text, shape, explicit: true };
    }
    return null;
  }

  function parseSubset(source) {
    const lines = source.replace(/\r/g, '').split('\n').map(line => line.trim()).filter(Boolean);
    if (!lines.length) throw new Error('Mermaid 内容为空。');
    const header = lines.shift().match(/^flowchart\s+(TD|TB|BT|LR|RL)$/i);
    if (!header) throw new Error('只支持 flowchart TD/TB/BT/LR/RL。');
    if (lines.length > MAX_MERMAID_LINES) throw new Error(`Mermaid 行数不能超过 ${MAX_MERMAID_LINES}。`);
    const nodes = new Map();
    const edges = [];
    const remember = token => {
      const parsed = parseNodeToken(token);
      if (!parsed) throw new Error('发现不支持的节点语法。');
      const previous = nodes.get(parsed.id);
      if (previous && parsed.explicit && previous.explicit && (previous.text !== parsed.text || previous.shape !== parsed.shape)) throw new Error(`节点 ${parsed.id} 的定义不一致。`);
      if (!previous || parsed.explicit) nodes.set(parsed.id, parsed);
      if (nodes.size > MAX_MERMAID_NODES) throw new Error(`节点数量不能超过 ${MAX_MERMAID_NODES}。`);
      return parsed;
    };
    for (const line of lines) {
      if (/^(?:%%|subgraph\b|end\b|classDef\b|class\b|style\b|linkStyle\b|click\b|sequenceDiagram\b|mindmap\b)/i.test(line)) throw new Error('返回包含未支持的 Mermaid 语法。');
      if (/-->[\s\S]*-->|<-|---|-\.-|===/.test(line)) throw new Error('不支持链式边或其他边类型。');
      const edge = line.match(/^([\s\S]*?)\s*-->\s*(?:\|([^|\r\n]*)\|\s*)?([\s\S]*?)\s*;?$/);
      if (edge) {
        const left = remember(edge[1]);
        const right = remember(edge[3]);
        const label = cleanLabel(edge[2] || '');
        if (label.length > MAX_LABEL_LENGTH || /[\r\n<>]|%%/.test(label)) throw new Error('边标签过长或包含未支持内容。');
        edges.push({ from: left.id, to: right.id, label });
        if (edges.length > MAX_MERMAID_EDGES) throw new Error(`连线数量不能超过 ${MAX_MERMAID_EDGES}。`);
      } else {
        remember(line);
      }
    }
    if (!nodes.size) throw new Error('Mermaid 流程图没有节点。');
    return { direction: header[1].toUpperCase(), nodes: [...nodes.values()], edges };
  }

  function validateMermaid(value) {
    const raw = String(value ?? '');
    if (raw.length > MAX_REPLY_LENGTH) return { ok: false, source: '', error: 'GPT 返回内容过大。' };
    let source;
    try {
      source = normalizeMermaidResponse(raw);
      if (source.length > MAX_REPLY_LENGTH) throw new Error('GPT 返回内容过大。');
      const parsed = parseSubset(source);
      return { ok: true, source, parsed, stats: { nodes: parsed.nodes.length, edges: parsed.edges.length } };
    } catch (error) {
      return { ok: false, source: source || '', error: String(error?.message || 'Mermaid 格式无效。') };
    }
  }

  function buildGPTPrompt(userPrompt, taskId = '') {
    const request = limitText(userPrompt, MAX_PROMPT_LENGTH).trim();
    return [
      '你是 Quickdraw 的 Mermaid 脑图生成器。',
      '请严格只输出一份可解析的 Mermaid flowchart 源码，不要输出解释、标题或代码块外文字。',
      '只允许 flowchart TD、TB、BT、LR 或 RL；每行只能有一个节点定义或一条单独的 --> 连线。',
      '节点只使用 A[文本]、A(文本)、A((文本))、A{文本}、A([文本])；边标签使用 -->|标签|，禁止链式边。',
      '禁止 subgraph、style、classDef、class、linkStyle、click、sequenceDiagram、mindmap 及其他语法。',
      '最多 60 个节点、90 行；标签不要换行，不要包含括号、方括号、花括号、分号、竖线或 HTML。节点标识使用英文字母和数字。',
      taskId ? `任务编号：${taskId}。不要在回答中复述编号。` : '',
      `用户需求：${request}`
    ].join('\n');
  }

  function buildGPTImagePrompt(userPrompt, taskId = '') {
    const request = limitText(userPrompt, MAX_PROMPT_LENGTH).trim();
    return [
      taskId ? `任务编号：${taskId}。不要在回答中复述编号。` : '',
      request
    ].filter(Boolean).join('\n');
  }

  function buildDoubaoPrompt(userPrompt, taskId = '') {
    const request = limitText(userPrompt, MAX_PROMPT_LENGTH).trim();
    return [
      '你是 Quickdraw 的流程图生成助手。',
      '请严格只输出一份可解析的 Mermaid flowchart 源码，不要输出解释、标题或代码块外文字。',
      '只允许 flowchart TD、TB、BT、LR 或 RL；每行只能有一个节点定义或一条单独的 --> 连线。',
      '节点只使用 A[文本]、A(文本)、A((文本))、A{文本}、A([文本])；边标签使用 -->|标签|，禁止链式边。',
      '禁止 subgraph、style、classDef、class、linkStyle、click、sequenceDiagram、mindmap 及其他语法。',
      taskId ? `任务编号：${taskId}。不要在回答中复述编号。` : '',
      `用户需求：${request}`
    ].join('\n');
  }

  function buildDoubaoImagePrompt(userPrompt, taskId = '') {
    // Image editing must receive exactly the text entered by the user.  The
    // content script associates the sent bubble with its pre-send baseline,
    // so a visible task marker is both unnecessary and harmful here (it can
    // become part of the image prompt).
    return limitText(userPrompt, MAX_PROMPT_LENGTH).trim();
  }

  function buildGrokImagePrompt(userPrompt, taskId = '') {
    const request = limitText(userPrompt, MAX_PROMPT_LENGTH).trim();
    return [
      'Edit or generate one final image using all attached images as input references.',
      'Return only the final generated image. Do not explain and do not return code or an image link.',
      taskId ? `任务编号：${taskId}。Do not repeat this ID in the response.` : '',
      request ? `User request: ${request}` : ''
    ].join('\n');
  }

  function normalizeInputAssets(input = {}, kind = 'mindmap') {
    if (kind !== 'image-edit') return [];
    const candidates = Array.isArray(input.inputAssets) ? input.inputAssets : [];
    if (candidates.length) return candidates.map((item, order) => ({
      assetId: String(item?.assetId || item?.id || ''),
      order: Number.isFinite(item?.order) ? Number(item.order) : order,
      sourceElementIds: Array.isArray(item?.sourceElementIds) ? item.sourceElementIds.slice(0, 80).map(String) : []
    })).filter(item => item.assetId);
    const ids = Array.isArray(input.inputAssetIds) ? input.inputAssetIds : [];
    if (ids.length) return ids.map((assetId, order) => ({ assetId: String(assetId || ''), order, sourceElementIds: [] })).filter(item => item.assetId);
    if (input.inputAssetId) return [{ assetId: String(input.inputAssetId), order: 0, sourceElementIds: Array.isArray(input.sourceElementIds) ? input.sourceElementIds.slice(0, 80).map(String) : [] }];
    return [];
  }

  function createTask(input = {}) {
    const current = Date.now();
    const p = provider(input.provider || 'gpt');
    const prompt = limitText(input.prompt, MAX_PROMPT_LENGTH).trim();
    const kind = input.kind === 'image-edit' ? 'image-edit' : 'mindmap';
    if (!p || !p.enabled || !p.capabilities[kind === 'image-edit' ? 'image' : 'mermaid']) throw new Error(kind === 'image-edit' ? '当前 AI平台未接入图片编辑。' : '当前 AI平台未接入脑图。');
    if (kind !== 'image-edit' && !prompt) throw new Error('请输入 AI 脑图需求。');
    if (!input.boardId || !input.sourceInstanceId) throw new Error('缺少画板任务归属信息。');
    const inputAssets = normalizeInputAssets(input, kind);
    if (kind === 'image-edit' && !inputAssets.length && !prompt) throw new Error('请输入 AI 图片生成需求。');
    if (kind === 'image-edit' && inputAssets.length > MAX_INPUT_IMAGES) throw new Error(`一次最多处理 ${MAX_INPUT_IMAGES} 张图片。`);
    return {
      taskId: String(input.taskId || randomId('task')),
      provider: p.id,
      kind,
      boardId: String(input.boardId),
      sourceWindowId: Number.isInteger(input.sourceWindowId) ? input.sourceWindowId : null,
      sourceInstanceId: String(input.sourceInstanceId),
      sourceBoardEpoch: Number.isFinite(input.sourceBoardEpoch) ? input.sourceBoardEpoch : 0,
      tabId: Number.isInteger(input.tabId) ? input.tabId : null,
      sourceRevision: Number(input.sourceRevision) || 0,
      prompt,
      inputAssetId: kind === 'image-edit' ? String(inputAssets[0]?.assetId || '') : '',
      inputAssetIds: kind === 'image-edit' ? inputAssets.map(item => item.assetId) : [],
      inputAssets: kind === 'image-edit' ? inputAssets : [],
      sourceElementIds: Array.isArray(input.sourceElementIds) ? input.sourceElementIds.slice(0, 80).map(String) : [],
      sourceInputUnits: Array.isArray(input.sourceInputUnits) ? input.sourceInputUnits.slice(0, MAX_INPUT_IMAGES).map(unit => Array.isArray(unit) ? unit.slice(0, 80).map(String) : []).filter(unit => unit.length) : [],
      sourceBounds: input.sourceBounds && Number.isFinite(input.sourceBounds.x) ? {
        x: Number(input.sourceBounds.x) || 0, y: Number(input.sourceBounds.y) || 0,
        w: Math.max(1, Number(input.sourceBounds.w) || 1), h: Math.max(1, Number(input.sourceBounds.h) || 1)
      } : null,
      status: 'queued',
      createdAt: current,
      updatedAt: current,
      stage: 'queued',
      stageStartedAt: current,
      stageDeadlineAt: current + STAGES.queued.timeout,
      stageLastProgressAt: current,
      stageToken: randomId('stage'),
      deadlineAt: current + STAGES.queued.timeout,
      rawReply: '',
      validatedMermaid: '',
      requestFingerprint: '',
      requestMessageId: '',
      error: '',
      seenEventKeys: [],
      importedAt: null,
      importedIntoBoardId: null
    };
  }

  function eventKey(event = {}) {
    if (event.eventId) return String(event.eventId);
    const body = `${event.stage || ''}:${event.progress ?? ''}:${event.text || event.error || event.imageUrl || event.fingerprint || ''}`;
    return `${event.taskId || ''}:${event.kind || ''}:${body.slice(0, 160)}`;
  }

  function isActiveTask(task) {
    return !!task && ACTIVE_STATUSES.has(task.status);
  }

  function canAutoImport(task, context = {}) {
    return !!task && (task.status === 'ready' || task.status === 'pending' || task.status === 'image-ready') && !task.importedAt &&
      task.sourceInstanceId === context.instanceId && task.boardId === context.boardId &&
      task.sourceBoardEpoch === context.boardEpoch && !context.loading;
  }

  function shouldResumeWithoutResend(task, now = Date.now()) {
    const deadlines = [Number(task?.stageDeadlineAt || 0), Number(task?.deadlineAt || 0)].filter(value => value > 0);
    const deadline = deadlines.length ? Math.min(...deadlines) : 0;
    const resumable = task?.status === 'waiting' || (task?.status === 'sending' && ['sending', 'generating', 'returning'].includes(String(task?.stage || '')));
    return !!task && resumable && deadline > now;
  }

  function shouldWaitForInPageContinuation(task, now = Date.now()) {
    const deadlines = [Number(task?.stageDeadlineAt || 0), Number(task?.deadlineAt || 0)].filter(value => value > 0);
    const deadline = deadlines.length ? Math.min(...deadlines) : 0;
    return !!task && ['hydrating', 'uploading'].includes(String(task.stage || '')) &&
      ['connecting', 'sending'].includes(task.status) && deadline > now;
  }

  function stageForStatus(status) {
    const value = String(status || '');
    if (value === 'queued') return 'queued';
    if (value === 'connecting') return 'hydrating';
    if (value === 'sending') return 'sending';
    if (value === 'waiting') return 'generating';
    if (value === 'validating') return 'returning';
    return '';
  }

  const api = {
    MAX_PROMPT_LENGTH,
    MAX_REPLY_LENGTH,
    MAX_TASKS,
    MAX_INPUT_IMAGES,
    STAGES,
    GPT_ORIGINS,
    GPT_IMAGE_ORIGINS,
    GPT_AUTH_ORIGINS,
    DOUBAO_ORIGINS,
    DOUBAO_IMAGE_ORIGINS,
    GROK_ORIGINS,
    GROK_AUTH_ORIGINS,
    PROVIDERS,
    ACTIVE_STATUSES,
    FINAL_STATUSES,
    provider,
    isAllowedGPTUrl,
    isAllowedGPTAuthUrl,
    createTask,
    normalizeInputAssets,
    buildGPTPrompt,
    buildGPTImagePrompt,
    buildDoubaoPrompt,
    buildDoubaoImagePrompt,
    buildGrokImagePrompt,
    validateMermaid,
    normalizeMermaidResponse,
    parseSubset,
    eventKey,
    isActiveTask,
    canAutoImport,
    shouldResumeWithoutResend,
    shouldWaitForInPageContinuation,
    stageForStatus,
    stageOrder: stage => Number(STAGES[String(stage || '')]?.order ?? -1),
    stageTimeout: stage => Number(STAGES[String(stage || '')]?.timeout || 120_000),
    limitText
  };

  globalThis.QuickdrawAI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
