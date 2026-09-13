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
  const DOLA_ORIGINS = Object.freeze(['https://www.dola.com/*', 'https://dola.com/*']);
  // Result images may be served from a Dola-owned CDN host that is only known
  // at reply time; getOutputPermissionOrigins() still requests the exact reply
  // origin on demand, so this list only covers the known first-party hosts.
  const DOLA_IMAGE_ORIGINS = Object.freeze(['https://www.dola.com/*', 'https://*.dola.com/*']);
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
    dola: Object.freeze({
      id: 'dola',
      label: 'Dola',
      enabled: true,
      capabilities: Object.freeze({ text: false, mermaid: false, image: true }),
      origins: DOLA_ORIGINS,
      authOrigins: Object.freeze([]),
      imageOrigins: DOLA_IMAGE_ORIGINS,
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
  const FINAL_STATUSES = new Set(['sent', 'imported', 'failed', 'needs-attention', 'cancelled']);

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

  const DIAGRAM_TYPES = Object.freeze(['flowchart', 'sequence', 'state', 'gantt', 'class']);

  function normalizeDiagramType(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (['sequence', 'sequencediagram', 'sequence-diagram'].includes(raw)) return 'sequence';
    if (['state', 'statediagram', 'state-diagram', 'statediagram-v2'].includes(raw)) return 'state';
    if (['gantt', 'ganttchart', 'gantt-chart'].includes(raw)) return 'gantt';
    if (['class', 'classdiagram', 'class-diagram'].includes(raw)) return 'class';
    return 'flowchart';
  }

  function mermaidHeaderType(value) {
    const source = String(value || '').replace(/^\uFEFF/, '').trimStart();
    if (/^(?:flowchart|graph)\s+(?:TD|TB|BT|LR|RL)\b/i.test(source)) return 'flowchart';
    if (/^sequenceDiagram\b/i.test(source)) return 'sequence';
    if (/^stateDiagram(?:-v2)?\b/i.test(source)) return 'state';
    if (/^gantt\b/i.test(source)) return 'gantt';
    if (/^classDiagram\b/i.test(source)) return 'class';
    return '';
  }

  function normalizeMermaidResponse(value) {
    const raw = String(value ?? '').replace(/\u200b/g, '').trim();
    if (!raw) throw new Error('AI 没有返回 Mermaid 内容。');
    const fenced = [...raw.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)];
    if (fenced.length) {
      const supported = fenced.map(match => ({
        info: String(match[1] || '').trim().toLowerCase(),
        source: String(match[2] || '').trim()
      })).filter(item => mermaidHeaderType(item.source));
      if (supported.length > 1) throw new Error('AI 返回了多个 Mermaid 图表代码块。');
      if (supported.length === 1) return supported[0].source;
      const mermaidBlocks = fenced.filter(match => String(match[1] || '').trim().toLowerCase() === 'mermaid');
      if (mermaidBlocks.length === 1) return String(mermaidBlocks[0][2] || '').trim();
      throw new Error('没有找到可识别的 Mermaid 代码块。');
    }
    if (raw.includes('```')) throw new Error('Mermaid 代码围栏不完整。');
    const header = raw.match(/(?:^|\n)\s*((?:flowchart|graph)\s+(?:TD|TB|BT|LR|RL)\b|sequenceDiagram\b|stateDiagram(?:-v2)?\b|gantt\b|classDiagram\b)/i);
    if (header && header.index != null) {
      const offset = header.index + header[0].indexOf(header[1]);
      return raw.slice(offset).trim();
    }
    return raw;
  }

  function cleanLabel(value) {
    let text = String(value ?? '').trim();
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1);
    return text.replace(/\\"/g, '"').replace(/<br\s*\/?>/gi, '\n').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }

  function boundedLabel(value, fallback = '') {
    const text = cleanLabel(value || fallback);
    if (!text) return String(fallback || '');
    if (text.length > MAX_LABEL_LENGTH) throw new Error(`标签长度不能超过 ${MAX_LABEL_LENGTH}。`);
    return text;
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
      const text = boundedLabel(found[1], id);
      return { id, text, shape, explicit: true };
    }
    return null;
  }

  function sourceLines(source) {
    return String(source || '').replace(/\r/g, '').split('\n').map(line => line.trim()).filter(Boolean);
  }

  function parseFlowchart(source) {
    const lines = sourceLines(source);
    if (!lines.length) throw new Error('Mermaid 内容为空。');
    const header = lines.shift().match(/^(?:flowchart|graph)\s+(TD|TB|BT|LR|RL)$/i);
    if (!header) throw new Error('流程图必须以 flowchart TD/TB/BT/LR/RL 开头。');
    if (lines.length > MAX_MERMAID_LINES) throw new Error(`Mermaid 行数不能超过 ${MAX_MERMAID_LINES}。`);
    const nodes = new Map();
    const edges = [];
    const remember = token => {
      const parsed = parseNodeToken(token);
      if (!parsed) throw new Error(`发现不支持的流程图节点语法：${String(token || '').slice(0, 80)}`);
      const previous = nodes.get(parsed.id);
      if (previous && parsed.explicit && previous.explicit && (previous.text !== parsed.text || previous.shape !== parsed.shape)) throw new Error(`节点 ${parsed.id} 的定义不一致。`);
      if (!previous || parsed.explicit) nodes.set(parsed.id, parsed);
      if (nodes.size > MAX_MERMAID_NODES) throw new Error(`节点数量不能超过 ${MAX_MERMAID_NODES}。`);
      return parsed;
    };
    for (let line of lines) {
      line = line.replace(/%%.*$/, '').trim();
      if (!line) continue;
      if (/^(?:subgraph\b|end\b|classDef\b|class\b|style\b|linkStyle\b|click\b)/i.test(line)) throw new Error('流程图包含当前不支持的高级 Mermaid 语法。');
      if (/-->[\s\S]*-->/.test(line) || /<-|---|-\.-|===/.test(line)) throw new Error('流程图暂不支持链式边或其他边类型。');
      const edge = line.match(/^([\s\S]*?)\s*-->\s*(?:\|([^|\r\n]*)\|\s*)?([\s\S]*?)\s*;?$/);
      if (edge) {
        const left = remember(edge[1]);
        const right = remember(edge[3]);
        const label = boundedLabel(edge[2] || '');
        edges.push({ from: left.id, to: right.id, label });
        if (edges.length > MAX_MERMAID_EDGES) throw new Error(`连线数量不能超过 ${MAX_MERMAID_EDGES}。`);
      } else {
        remember(line);
      }
    }
    if (!nodes.size) throw new Error('Mermaid 流程图没有节点。');
    return { type: 'flowchart', direction: header[1].toUpperCase(), nodes: [...nodes.values()], edges };
  }

  function parseSequenceDiagram(source) {
    const lines = sourceLines(source);
    if (!/^sequenceDiagram$/i.test(lines.shift() || '')) throw new Error('时序图必须以 sequenceDiagram 开头。');
    const participants = new Map();
    const messages = [];
    let autonumber = false;
    const remember = (id, label = '') => {
      const key = String(id || '').trim();
      if (!/^[A-Za-z_]\w*$/.test(key)) throw new Error(`时序图参与者标识无效：${key}`);
      const previous = participants.get(key);
      if (!previous) participants.set(key, { id: key, text: boundedLabel(label || key, key), shape: 'rounded' });
      else if (label) previous.text = boundedLabel(label, key);
      if (participants.size > 8) throw new Error('时序图参与者不能超过 8 个。');
      return participants.get(key);
    };
    for (let line of lines) {
      line = line.replace(/%%.*$/, '').trim();
      if (!line) continue;
      if (/^autonumber$/i.test(line)) { autonumber = true; continue; }
      let match = line.match(/^(participant|actor)\s+([A-Za-z_]\w*)(?:\s+as\s+(.+))?$/i);
      if (match) { remember(match[2], match[3] || match[2]); continue; }
      match = line.match(/^([A-Za-z_]\w*)\s*(-->>|->>|-->|->)\s*([A-Za-z_]\w*)\s*:\s*(.+)$/);
      if (match) {
        remember(match[1]); remember(match[3]);
        messages.push({ from: match[1], to: match[3], label: boundedLabel(match[4]), dashed: match[2].startsWith('--') });
        if (messages.length > 24) throw new Error('时序图消息不能超过 24 条。');
        continue;
      }
      if (/^(?:activate|deactivate|note|loop|alt|else|opt|par|and|rect|critical|break|end)\b/i.test(line)) throw new Error('当前时序图导入暂不支持 loop/alt/note/activate 等高级语法。');
      throw new Error(`无法识别时序图语法：${line.slice(0, 100)}`);
    }
    if (!participants.size) throw new Error('时序图没有参与者。');
    return { type: 'sequence', direction: 'LR', participants: [...participants.values()], messages, autonumber, nodes: [...participants.values()], edges: messages };
  }

  function parseStateDiagram(source) {
    const lines = sourceLines(source);
    if (!/^stateDiagram(?:-v2)?$/i.test(lines.shift() || '')) throw new Error('状态图必须以 stateDiagram-v2 开头。');
    const nodes = new Map();
    const edges = [];
    let direction = 'TD';
    let pseudoIndex = 0;
    const remember = (id, label = '', shape = 'rounded', role = '') => {
      if (!/^[A-Za-z_][\w-]*$/.test(id)) throw new Error(`状态标识无效：${id}`);
      const previous = nodes.get(id);
      if (!previous) nodes.set(id, { id, text: boundedLabel(label || id, id), shape, role });
      else {
        if (label) previous.text = boundedLabel(label, id);
        if (role) previous.role = role;
      }
      if (nodes.size > MAX_MERMAID_NODES) throw new Error(`状态数量不能超过 ${MAX_MERMAID_NODES}。`);
      return nodes.get(id);
    };
    const endpoint = (token, side) => {
      if (token !== '[*]') return remember(token);
      const id = `__${side}_${++pseudoIndex}`;
      return remember(id, '', 'ellipse', side === 'start' ? 'state-start' : 'state-end');
    };
    for (let line of lines) {
      line = line.replace(/%%.*$/, '').trim();
      if (!line) continue;
      const directionMatch = line.match(/^direction\s+(TD|TB|BT|LR|RL)$/i);
      if (directionMatch) { direction = directionMatch[1].toUpperCase(); continue; }
      let match = line.match(/^state\s+"([^"]+)"\s+as\s+([A-Za-z_][\w-]*)$/i);
      if (match) { remember(match[2], match[1]); continue; }
      match = line.match(/^state\s+([A-Za-z_][\w-]*)\s*:\s*(.+)$/i);
      if (match) { remember(match[1], match[2]); continue; }
      match = line.match(/^state\s+([A-Za-z_][\w-]*)$/i);
      if (match) { remember(match[1]); continue; }
      match = line.match(/^(\[\*\]|[A-Za-z_][\w-]*)\s*-->\s*(\[\*\]|[A-Za-z_][\w-]*)(?:\s*:\s*(.+))?$/);
      if (match) {
        const left = endpoint(match[1], match[1] === '[*]' ? 'start' : 'state');
        const right = endpoint(match[2], match[2] === '[*]' ? 'end' : 'state');
        edges.push({ from: left.id, to: right.id, label: boundedLabel(match[3] || '') });
        if (edges.length > MAX_MERMAID_EDGES) throw new Error(`状态转换不能超过 ${MAX_MERMAID_EDGES} 条。`);
        continue;
      }
      if (/[{}]/.test(line)) throw new Error('当前状态图导入暂不支持复合状态。');
      throw new Error(`无法识别状态图语法：${line.slice(0, 100)}`);
    }
    if (!nodes.size) throw new Error('状态图没有状态。');
    return { type: 'state', direction, nodes: [...nodes.values()], edges };
  }

  function parseClassDiagram(source) {
    const lines = sourceLines(source);
    if (!/^classDiagram$/i.test(lines.shift() || '')) throw new Error('类图必须以 classDiagram 开头。');
    const classes = new Map();
    const edges = [];
    let current = null;
    const remember = (id, label = '') => {
      if (!/^[A-Za-z_][\w-]*$/.test(id)) throw new Error(`类标识无效：${id}`);
      if (!classes.has(id)) classes.set(id, { id, label: boundedLabel(label || id, id), members: [], shape: 'rect' });
      else if (label) classes.get(id).label = boundedLabel(label, id);
      if (classes.size > 24) throw new Error('类图最多支持 24 个类。');
      return classes.get(id);
    };
    for (let line of lines) {
      line = line.replace(/%%.*$/, '').trim();
      if (!line) continue;
      if (current) {
        if (line === '}') { current = null; continue; }
        if (line.length > MAX_LABEL_LENGTH) throw new Error('类成员文本过长。');
        if (current.members.length >= 12) throw new Error(`类 ${current.id} 的成员不能超过 12 项。`);
        current.members.push(cleanLabel(line));
        continue;
      }
      let match = line.match(/^class\s+([A-Za-z_][\w-]*)(?:\s*\[\s*"([^"]+)"\s*\])?\s*\{$/i);
      if (match) { current = remember(match[1], match[2] || match[1]); continue; }
      match = line.match(/^class\s+([A-Za-z_][\w-]*)(?:\s*\[\s*"([^"]+)"\s*\])?$/i);
      if (match) { remember(match[1], match[2] || match[1]); continue; }
      match = line.match(/^([A-Za-z_][\w-]*)\s*(<\|--|--\|>|\*--|--\*|o--|--o|\.\.>|<\.\.|-->|<--|--|\.\.)\s*([A-Za-z_][\w-]*)(?:\s*:\s*(.+))?$/);
      if (match) {
        remember(match[1]); remember(match[3]);
        const relation = match[4] ? `${match[2]} ${boundedLabel(match[4])}` : match[2];
        edges.push({ from: match[1], to: match[3], label: relation });
        if (edges.length > MAX_MERMAID_EDGES) throw new Error(`类关系不能超过 ${MAX_MERMAID_EDGES} 条。`);
        continue;
      }
      if (/^(?:direction|namespace|note)\b/i.test(line)) throw new Error('当前类图导入暂不支持 namespace/note 等高级语法。');
      throw new Error(`无法识别类图语法：${line.slice(0, 100)}`);
    }
    if (current) throw new Error(`类 ${current.id} 缺少结束花括号。`);
    const nodes = [...classes.values()].map(item => ({
      id: item.id,
      text: [item.label, ...item.members].join('\n'),
      shape: 'rect'
    }));
    if (!nodes.length) throw new Error('类图没有类。');
    return { type: 'class', direction: 'LR', nodes, edges };
  }

  function parseDurationDays(value) {
    const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)(d|w|h)$/i);
    if (!match) return null;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const unit = match[2].toLowerCase();
    return unit === 'w' ? amount * 7 : unit === 'h' ? amount / 24 : amount;
  }

  function parseGanttDiagram(source) {
    const lines = sourceLines(source);
    if (!/^gantt$/i.test(lines.shift() || '')) throw new Error('甘特图必须以 gantt 开头。');
    const tasks = [];
    let section = '任务';
    let title = '';
    let dateFormat = 'YYYY-MM-DD';
    for (let line of lines) {
      line = line.replace(/%%.*$/, '').trim();
      if (!line) continue;
      let match = line.match(/^title\s+(.+)$/i);
      if (match) { title = boundedLabel(match[1]); continue; }
      match = line.match(/^dateFormat\s+(.+)$/i);
      if (match) {
        dateFormat = match[1].trim();
        if (dateFormat !== 'YYYY-MM-DD') throw new Error('甘特图当前只支持 dateFormat YYYY-MM-DD。');
        continue;
      }
      if (/^(?:axisFormat|tickInterval|weekday|excludes|todayMarker)\b/i.test(line)) continue;
      match = line.match(/^section\s+(.+)$/i);
      if (match) { section = boundedLabel(match[1]); continue; }
      const colon = line.indexOf(':');
      if (colon <= 0) throw new Error(`无法识别甘特图任务：${line.slice(0, 100)}`);
      const label = boundedLabel(line.slice(0, colon));
      const rawParts = line.slice(colon + 1).split(',').map(part => part.trim()).filter(Boolean);
      const flags = [];
      while (rawParts.length && /^(?:done|active|crit|milestone)$/i.test(rawParts[0])) flags.push(rawParts.shift().toLowerCase());
      let id = '';
      if (rawParts[0] && /^[A-Za-z_][\w-]*$/.test(rawParts[0]) && !/^after\s+/i.test(rawParts[0])) id = rawParts.shift();
      if (!id) id = `task_${tasks.length + 1}`;
      const startRaw = rawParts.shift() || '';
      const durationRaw = rawParts.shift() || '';
      if (!startRaw || !durationRaw) throw new Error(`甘特图任务“${label}”需要开始时间和持续时间。`);
      const afterMatch = startRaw.match(/^after\s+([A-Za-z_][\w-]*)$/i);
      if (!afterMatch && !/^\d{4}-\d{2}-\d{2}$/.test(startRaw)) throw new Error(`甘特图任务“${label}”的开始时间必须是 YYYY-MM-DD 或 after 任务ID。`);
      let durationDays = parseDurationDays(durationRaw);
      if (flags.includes('milestone')) durationDays = Math.min(durationDays || 1, 0.25);
      if (!durationDays) throw new Error(`甘特图任务“${label}”的持续时间应类似 3d、1w 或 12h。`);
      tasks.push({ id, label, section, startRaw, after: afterMatch?.[1] || '', durationRaw, durationDays, flags });
      if (tasks.length > 40) throw new Error('甘特图任务不能超过 40 个。');
    }
    if (!tasks.length) throw new Error('甘特图没有任务。');
    const ids = new Set(tasks.map(task => task.id));
    if (ids.size !== tasks.length) throw new Error('甘特图任务 ID 不能重复。');
    for (const task of tasks) if (task.after && !ids.has(task.after)) throw new Error(`甘特图依赖任务不存在：${task.after}`);
    const nodes = tasks.map(task => ({ id: task.id, text: task.label, shape: 'rect' }));
    const edges = tasks.filter(task => task.after).map(task => ({ from: task.after, to: task.id, label: '' }));
    return { type: 'gantt', direction: 'LR', title, dateFormat, tasks, nodes, edges };
  }

  function parseMermaidDiagram(source) {
    const type = mermaidHeaderType(source);
    if (type === 'flowchart') return parseFlowchart(source);
    if (type === 'sequence') return parseSequenceDiagram(source);
    if (type === 'state') return parseStateDiagram(source);
    if (type === 'gantt') return parseGanttDiagram(source);
    if (type === 'class') return parseClassDiagram(source);
    throw new Error('仅支持 Flowchart、Sequence、State、Gantt 和 Class Diagram。');
  }

  // Backward-compatible alias used by older callers.
  function parseSubset(source) {
    const parsed = parseMermaidDiagram(source);
    if (parsed.type !== 'flowchart') throw new Error('该接口仅用于 Flowchart。');
    return parsed;
  }

  function validateMermaid(value) {
    const raw = String(value ?? '');
    if (raw.length > MAX_REPLY_LENGTH) return { ok: false, source: '', error: 'AI 返回内容过大。' };
    let source;
    try {
      source = normalizeMermaidResponse(raw);
      if (source.length > MAX_REPLY_LENGTH) throw new Error('AI 返回内容过大。');
      const parsed = parseMermaidDiagram(source);
      return {
        ok: true,
        source,
        type: parsed.type,
        parsed,
        stats: { nodes: Number(parsed.nodes?.length || 0), edges: Number(parsed.edges?.length || 0) }
      };
    } catch (error) {
      return { ok: false, source: source || '', error: String(error?.message || 'Mermaid 格式无效。') };
    }
  }

  function buildMermaidPrompt(userPrompt, taskId = '', diagramType = 'flowchart') {
    const request = limitText(userPrompt, MAX_PROMPT_LENGTH).trim();
    const type = normalizeDiagramType(diagramType);
    const common = [
      '你是 Quickdraw 的 Mermaid 图表生成器。',
      '只输出一个 ```mermaid 代码块，代码块外不要有解释、标题、提示或任何其他文字。',
      '所有标识符使用英文字母、数字或下划线；可见标签可以使用中文。',
      '不要使用 style、classDef、click、HTML 或实验性扩展语法。',
      taskId ? `任务编号：${taskId}。不要在输出内容中复述编号。` : ''
    ];
    const rules = {
      flowchart: [
        '生成 Flowchart 流程图。第一行必须是 flowchart TD、TB、BT、LR 或 RL。',
        '每行只能有一个节点定义或一条单独的 --> 连线，禁止链式连线。',
        '节点只使用 A[文本]、A(文本)、A((文本))、A{文本}、A([文本])；边标签使用 -->|标签|。',
        '禁止 subgraph。最多 60 个节点、90 行。'
      ],
      sequence: [
        '生成 Sequence Diagram 时序图。第一行必须是 sequenceDiagram。',
        '只使用 participant/actor 声明，以及 A->>B: 消息 或 A-->>B: 返回消息。',
        '不要使用 loop、alt、opt、par、note、activate、deactivate。最多 8 个参与者、24 条消息。'
      ],
      state: [
        '生成 State Diagram 状态图。第一行必须是 stateDiagram-v2。',
        '只使用 state "显示名称" as StateId、StateA --> StateB: 条件，以及 [*] --> StateId / StateId --> [*]。',
        '不要使用复合状态、并行状态或花括号状态块。'
      ],
      gantt: [
        '生成 Gantt 甘特图。第一行必须是 gantt，第二行使用 dateFormat YYYY-MM-DD。',
        '可以使用 title 和 section。任务只使用：任务名 :taskId, YYYY-MM-DD, 3d，或 任务名 :taskId, after otherId, 3d。',
        '持续时间只使用 d、w 或 h。不要使用 excludes、todayMarker 或复杂日期表达式。最多 40 个任务。'
      ],
      class: [
        '生成 Class Diagram 类图。第一行必须是 classDiagram。',
        '类只使用 class ClassName { ... }；关系只使用 -->、--、<|--、*--、o--、..>，可在末尾用 : 关系名。',
        '不要使用 namespace、note、泛型尖括号或关系多重性。最多 24 个类，每个类最多 12 个成员。'
      ]
    }[type];
    return [...common, ...rules, `用户需求：${request}`].filter(Boolean).join('\n');
  }

  function buildGPTPrompt(userPrompt, taskId = '', diagramType = 'flowchart') {
    return buildMermaidPrompt(userPrompt, taskId, diagramType);
  }

  function buildGPTImagePrompt(userPrompt, taskId = '') {
    return limitText(userPrompt, MAX_PROMPT_LENGTH).trim();
  }

  function buildDoubaoPrompt(userPrompt, taskId = '', diagramType = 'flowchart') {
    return buildMermaidPrompt(userPrompt, taskId, diagramType);
  }

  function buildDoubaoImagePrompt(userPrompt, taskId = '') {
    // Image editing must receive exactly the text entered by the user.  The
    // content script associates the sent bubble with its pre-send baseline,
    // so a visible task marker is both unnecessary and harmful here (it can
    // become part of the image prompt).
    return limitText(userPrompt, MAX_PROMPT_LENGTH).trim();
  }

  function buildGrokImagePrompt(userPrompt, taskId = '') {
    return limitText(userPrompt, MAX_PROMPT_LENGTH).trim();
  }

  function buildDolaImagePrompt(userPrompt, taskId = '') {
    // Same contract as the other image providers: send exactly the user text;
    // the content script matches the sent bubble via its pre-send baseline.
    return limitText(userPrompt, MAX_PROMPT_LENGTH).trim();
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
    const diagramType = kind === 'mindmap' ? normalizeDiagramType(input.diagramType) : '';
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
      diagramType,
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
    DOLA_ORIGINS,
    DOLA_IMAGE_ORIGINS,
    PROVIDERS,
    DIAGRAM_TYPES,
    ACTIVE_STATUSES,
    FINAL_STATUSES,
    provider,
    normalizeDiagramType,
    isAllowedGPTUrl,
    isAllowedGPTAuthUrl,
    createTask,
    normalizeInputAssets,
    buildGPTPrompt,
    buildGPTImagePrompt,
    buildDoubaoPrompt,
    buildDoubaoImagePrompt,
    buildGrokImagePrompt,
    buildDolaImagePrompt,
    validateMermaid,
    normalizeMermaidResponse,
    parseMermaidDiagram,
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
