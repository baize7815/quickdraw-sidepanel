(() => {
  'use strict';

  if (globalThis.__quickdrawDolaContentLoaded) return;
  globalThis.__quickdrawDolaContentLoaded = true;

  const active = new Map();
  const HYDRATE_TIMEOUT = 120_000;
  const UPLOAD_INACTIVITY_TIMEOUT = 180_000;
  const SEND_TIMEOUT = 60_000;
  const REPLY_TIMEOUT = 1_200_000;
  const STABLE_WINDOW = 800;
  const PROMPT_FILL_ATTEMPTS = 4;
  const PROMPT_READBACK_TIMEOUT = 1_000;
  const INCOMPLETE_ATTACHMENT_TIMEOUT = 8_000;
  const RAW_MISSING_GRACE = 10_000;
  // 多张结果图同时 base64 内联会让页面渲染进程出现内存尖峰（UTF-16 字符串 +
  // IPC 结构化克隆），大图偶发时可能直接崩掉标签页/浏览器。超过该体积的 HTTPS
  // 图片只回传签名地址，由 service worker 凭主机权限抓取；blob:/data: 地址
  // 无法在页面外恢复，仍必须内联。
  const INLINE_IMAGE_BYTES = 4 * 1024 * 1024;
  const yieldToEventLoop = () => new Promise(resolve => setTimeout(resolve, 0));

  // ---------------------------------------------------------------------------
  // Unwatermarked-original bridge (isolated side).
  // The Dola provider installs a MAIN-world observer that forwards
  // { raw: image_ori_raw.url, aliases: [every rendered variant URL] } pairs.
  // Keys combine an exact origin+path match with Dola's own media identifiers
  // (rc_gen_image segment, 32-hex hash, last path segment) so the visible
  // <img src> resolves to the raw original even when query/size params differ.
  // ---------------------------------------------------------------------------
  const rawImageUrls = new Map();
  const rawImageIdentifiers = new Map();
  const dolaUrlKeys = value => {
    const keys = [];
    try {
      const text = String(value || '');
      const url = new URL(text, globalThis.location?.href);
      const base = `${url.origin}${url.pathname}`;
      keys.push(`${base}${url.search}`);
      if (url.search) keys.push(base);
      const rc = text.match(/rc_gen_image\/([^?~]+)/i);
      if (rc?.[1]) keys.push(decodeURIComponent(rc[1]));
      const hex = text.match(/([0-9a-f]{32})/i);
      if (hex) keys.push(hex[1].toLowerCase());
      const segments = url.pathname.split('/').filter(Boolean);
      if (segments.length) {
        const last = segments[segments.length - 1].split('~')[0];
        if (last.length > 8) keys.push(last);
        const noExt = last.replace(/\.(?:png|jpe?g|webp|avif|mp4|mov|m4v|m3u8)$/i, '');
        if (noExt.length > 8 && noExt !== last) keys.push(noExt);
      }
    } catch {}
    return [...new Set(keys)];
  };
  const dolaUrlIdentifiers = value => {
    const result = [];
    try {
      const url = new URL(String(value || ''), globalThis.location?.href);
      for (const key of ['image_id', 'imageId', 'creation_id', 'creationId', 'id']) {
        const id = String(url.searchParams.get(key) || '').trim();
        if (id.length >= 8 && !result.includes(id)) result.push(id);
      }
      for (const part of url.pathname.split('/')) {
        const id = decodeURIComponent(part).trim();
        if (id.length >= 16 && /^[\w.-]+$/.test(id) && !result.includes(id)) result.push(id);
      }
    } catch {}
    return result;
  };
  function rememberRaw(map, key, raw) {
    if (!key || !raw) return;
    const values = map.get(key) || new Set();
    values.add(raw);
    map.set(key, values);
  }
  function uniqueRaw(map, key) {
    const values = map.get(key);
    if (!values) return '';
    const entries = values instanceof Set ? [...values] : [values];
    return entries.length === 1 ? String(entries[0] || '') : '';
  }
  function rawForAlias(taskId, alias) {
    for (const key of dolaUrlKeys(alias)) {
      const raw = uniqueRaw(rawImageUrls, `${taskId}|${key}`);
      if (raw) return raw;
    }
    for (const id of dolaUrlIdentifiers(alias)) {
      const raw = uniqueRaw(rawImageIdentifiers, `${taskId}|${id}`);
      if (raw) return raw;
    }
    return '';
  }
  function acceptRawBridgeMessage(record, data) {
    if (!record || !record.rawBridgeToken || data?.bridgeToken !== record.rawBridgeToken || String(data?.taskId || '') !== record.taskId || !Array.isArray(data.pairs)) return false;
    let accepted = false;
    for (const pair of data.pairs.slice(0, 80)) {
      const raw = String(pair?.raw || '');
      const aliases = Array.isArray(pair?.aliases) ? pair.aliases : [pair?.preview];
      if (raw.length > 2_000 || !/^https:\/\//i.test(raw)) continue;
      const allAliases = [...aliases, raw];
      for (const value of allAliases.slice(0, 16)) {
        const alias = String(value || '');
        if (alias.length > 2_000 || !/^https:\/\//i.test(alias)) continue;
        for (const key of dolaUrlKeys(alias)) { rememberRaw(rawImageUrls, `${record.taskId}|${key}`, raw); accepted = true; }
        for (const id of dolaUrlIdentifiers(alias)) rememberRaw(rawImageIdentifiers, `${record.taskId}|${id}`, raw);
      }
      for (const value of (Array.isArray(pair?.identifiers) ? pair.identifiers : []).slice(0, 12)) {
        const id = String(value || '').trim();
        if (id.length >= 8 && id.length <= 200) { rememberRaw(rawImageIdentifiers, `${record.taskId}|${id}`, raw); accepted = true; }
      }
    }
    return accepted;
  }
  globalThis.addEventListener?.('message', event => {
    const data = event?.data;
    if (event.source !== globalThis || event.origin !== globalThis.location?.origin || data?.source !== 'quickdraw-dola-raw-v1') return;
    const record = active.get(String(data.taskId || ''));
    acceptRawBridgeMessage(record, data);
  });
  function requestRawBridgeReplay(taskId, bridgeToken) {
    if (!bridgeToken) return;
    try { globalThis.postMessage?.({ source: 'quickdraw-dola-raw-replay-v1', taskId: String(taskId || ''), bridgeToken: String(bridgeToken) }, globalThis.location?.origin || '*'); } catch {}
  }
  function clearRawBridge(taskId) {
    for (const key of rawImageUrls.keys()) if (key.startsWith(`${taskId}|`)) rawImageUrls.delete(key);
    for (const key of rawImageIdentifiers.keys()) if (key.startsWith(`${taskId}|`)) rawImageIdentifiers.delete(key);
  }

  const visible = element => {
    if (!element || element.isConnected === false || element.hidden || element.disabled || element.getAttribute?.('aria-disabled') === 'true') return false;
    const style = globalThis.getComputedStyle?.(element);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    return !!(element.offsetParent || element.getClientRects?.().length);
  };

  const textOf = element => String(element?.innerText ?? element?.textContent ?? '').replace(/[\u200b-\u200d\ufeff]/g, '').trim();

  const isEditableElement = element => {
    const tag = String(element?.tagName || '').toLowerCase();
    const type = String(element?.type || '').toLowerCase();
    return tag === 'textarea' || (tag === 'input' && !/^(?:file|button|submit|image|checkbox|radio|password)$/i.test(type)) || element?.isContentEditable === true || element?.getAttribute?.('contenteditable') === 'true' || element?.getAttribute?.('role') === 'textbox';
  };

  function composerRoot(input = null) {
    if (!input) return document;
    try {
      // Dola/Samantha composer: guidance-input-content wraps both the editor
      // wrapper and the actions toolbar (the editor wrapper itself is only a
      // sibling of the toolbar, so match the shared parent, not the wrapper).
      const nearest = input.closest?.('form,[class*="composer" i],[class*="chat-input" i],[class*="input-area" i],[class*="guidance-input-content" i],[class*="guidance-input-surface" i],[class*="footer" i]');
      if (nearest) return nearest;
    } catch {}
    let current = input;
    for (let depth = 0; current && depth < 8; depth++, current = current.parentElement) {
      if (current.querySelector?.('button,[role="button"],img')) return current;
    }
    return input.parentElement || document;
  }

  function extractAssistantText(element) {
    const copy = element.cloneNode?.(true);
    if (!copy) return '';
    for (const selector of ['button', 'svg', 'nav', 'details', '[aria-hidden="true"]', '[aria-label*="copy" i]', '[aria-label*="复制"]', '[data-testid*="copy" i]', '[class*="thinking" i]', '[class*="reasoning" i]']) {
      copy.querySelectorAll?.(selector).forEach(node => node.remove());
    }
    for (const br of copy.querySelectorAll('br')) br.replaceWith(document.createTextNode('\n'));
    for (const block of copy.querySelectorAll('p,div,li,tr,h1,h2,h3,h4,blockquote')) block.appendChild(document.createTextNode('\n'));
    return String(copy.textContent || '').replace(/\u200b/g, '').trim();
  }

  function hash(value) {
    const text = String(value || '');
    let result = 2166136261;
    for (let i = 0; i < text.length; i++) {
      result ^= text.charCodeAt(i);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(16);
  }

  function emit(taskId, kind, data = {}) {
    const message = {
      type: 'qd-ai-provider-event',
      taskId: String(taskId),
      kind,
      eventId: `${taskId}:${kind}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
      origin: location.origin,
      url: location.href,
      ...data
    };
    try { globalThis.chrome?.runtime?.sendMessage(message).catch?.(() => {}); } catch {}
  }

  function emitPhase(taskId, stage, data = {}) { emit(taskId, 'phase', { stage: String(stage || ''), ...data }); }

  function findInput() {
    const candidates = [];
    const seen = new Set();
    const add = element => { if (element && !seen.has(element)) { seen.add(element); candidates.push(element); } };
    const direct = element => {
      const tag = String(element?.tagName || '').toLowerCase();
      return tag === 'textarea' || (tag === 'input' && !/^(?:file|button|submit|image|checkbox|radio|password)$/i.test(String(element?.type || '')))
        || element?.isContentEditable === true || element?.getAttribute?.('contenteditable') === 'true';
    };
    const query = selectors => selectors.flatMap(selector => [...(document.querySelectorAll(selector) || [])]);
    const addRoot = root => {
      if (direct(root)) add(root);
      const nested = query(['textarea', 'input', '[contenteditable="true"]', '[role="textbox"]']).filter(element => root === element || !root?.contains || root.contains(element));
      [...nested].reverse().forEach(element => { if (direct(element) || (isEditableElement(element) && !element.querySelector?.('textarea,input,[contenteditable="true"]'))) add(element); });
    };
    for (const root of query(['[data-testid*="chat-input" i]', '[data-testid*="prompt" i]', '[class*="chat-input" i]', '[class*="editor" i]', '[class*="composer" i]', '[contenteditable="true"]']).reverse()) addRoot(root);
    for (const element of query(['textarea', 'input', '[contenteditable="true"]', '[role="textbox"]']).reverse()) addRoot(element);
    return candidates.filter(element => visible(element) && isEditableElement(element)).at(-1) || null;
  }

  function authRequiredPage() {
    let pathname = '';
    try { pathname = new URL(String(globalThis.location?.href || '')).pathname.toLowerCase(); } catch {}
    if (/\/(?:auth|login|log-in|signup|sign-up|registration|passport|account|verify|verification)(?:\/|$)/.test(pathname)) return true;
    const password = [...document.querySelectorAll('input[type="password"]')].find(visible);
    const challenge = [...document.querySelectorAll('iframe[src*="challenges.cloudflare.com"],iframe[src*="captcha" i],[data-testid*="challenge" i],[data-testid*="captcha" i]')].find(visible);
    if (challenge) return true;
    if (!password) {
      const labels = [...document.querySelectorAll('button,a,[role="button"]')].filter(visible).map(element => `${element.getAttribute?.('aria-label') || ''} ${element.getAttribute?.('title') || ''} ${textOf(element)}`).join(' ').toLowerCase();
      return /登录|注册|log\s*in|sign\s*up|验证码|验证|verify/.test(labels) && !findInput();
    }
    const controls = [...document.querySelectorAll('button,a,[role="button"]')].filter(visible);
    const labels = controls.map(element => `${element.getAttribute?.('aria-label') || ''} ${element.getAttribute?.('title') || ''} ${textOf(element)}`).join(' ').toLowerCase();
    return /log\s*in|sign\s*up|continue|登录|注册|继续|验证|verify/.test(labels);
  }

  function inputText(element) {
    if (!element) return '';
    const tag = String(element?.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') return String(element.value || '');
    return editableText(element);
  }

  function editableText(element) {
    if (!element) return '';
    const tag = String(element?.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') return String(element.value || '');
    const blockTags = new Set(['address', 'article', 'blockquote', 'div', 'dl', 'dt', 'dd', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul']);
    let output = '';
    const append = value => { output += String(value || ''); };
    const walk = node => {
      if (!node) return;
      if (node.nodeType === 3 || String(node.tagName || '').toLowerCase() === '#text') { append(node.nodeValue ?? node.textContent ?? ''); return; }
      if (node !== element && (node.hidden || node.getAttribute?.('aria-hidden') === 'true')) return;
      const marker = `${node.getAttribute?.('data-placeholder') || ''} ${node.getAttribute?.('class') || ''}`.toLowerCase();
      if (node !== element && /placeholder/.test(marker)) return;
      const childNodes = node.childNodes ? [...node.childNodes] : (node.children ? [...node.children] : []);
      const childTag = String(node.tagName || '').toLowerCase();
      if (childTag === 'br') { append('\n'); return; }
      const before = output.length;
      childNodes.forEach(walk);
      if (blockTags.has(childTag) && output.length > before && !output.endsWith('\n')) append('\n');
    };
    walk(element);
    const structural = output.replace(/[\u200b-\u200d\ufeff]/g, '');
    return (structural || String(element.innerText || element.textContent || '').replace(/[\u200b-\u200d\ufeff]/g, '')).trim();
  }

  function normalizePromptText(value) {
    return String(value ?? '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n+/g, '\n').trim();
  }
  function promptSemanticText(value) { return normalizePromptText(value).replace(/\s+/g, ' ').trim(); }
  function promptMatches(actual, expected) { return promptSemanticText(actual) === promptSemanticText(expected); }

  function inputEvent(type, value) {
    try { return new InputEvent(type, { bubbles: true, cancelable: type === 'beforeinput', inputType: 'insertText', data: value }); }
    catch { return new Event(type, { bubbles: true, cancelable: type === 'beforeinput' }); }
  }

  function setInputValue(element, value) {
    if (!element || element.isConnected === false || !visible(element)) return false;
    element.focus();
    const tag = String(element?.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') {
      try { element.dispatchEvent(inputEvent('beforeinput', value)); } catch {}
      let proto = Object.getPrototypeOf(element), descriptor = null;
      while (proto && !descriptor) { descriptor = Object.getOwnPropertyDescriptor(proto, 'value'); proto = Object.getPrototypeOf(proto); }
      descriptor?.set?.call(element, value);
      if (!descriptor?.set) element.value = value;
      element.dispatchEvent(inputEvent('input', value));
      try { element.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
      return true;
    }
    try { element.dispatchEvent(inputEvent('beforeinput', value)); } catch {}
    let inserted = false;
    try {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = globalThis.getSelection?.();
      selection?.removeAllRanges?.();
      selection?.addRange?.(range);
      inserted = !!document.execCommand?.('insertText', false, value);
    } catch {}
    if (!inserted || !promptMatches(inputText(element), value)) {
      element.textContent = value;
      if (element.innerHTML != null && /\n/.test(String(value))) {
        try {
          const lines = String(value).split('\n');
          element.textContent = '';
          lines.forEach((line, index) => { if (index) element.appendChild(document.createElement?.('br') || document.createTextNode('\n')); element.appendChild(document.createTextNode(line)); });
        } catch {}
      }
    }
    element.dispatchEvent(inputEvent('input', value));
    return true;
  }

  function findSendButton() {
    const selectors = [
      '#flow-end-msg-send',
      '[data-testid="send-button"]',
      'button[data-testid*="send" i]',
      '[data-testid*="submit" i]',
      'button[class*="send" i]',
      'button[class*="submit" i]',
      'button[type="submit"]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="发送"]',
      'button[title*="Send" i]',
      'button[title*="发送"]'
    ];
    for (const selector of selectors) {
      const button = [...document.querySelectorAll(selector)].reverse().find(element => visible(element) && !element.disabled && element.getAttribute?.('aria-disabled') !== 'true');
      if (button) return button;
    }
    const input = findInput();
    const hasContent = !!inputText(input).trim() || Number(findAttachmentInput(input)?.files?.length || 0) > 0;
    if (!hasContent) return null;
    const root = composerRoot(input);
    const fallback = [...(root?.querySelectorAll?.('button,[role="button"]') || [])].filter(button => {
      if (!visible(button) || button.disabled || button.getAttribute?.('aria-disabled') === 'true') return false;
      const label = `${button.getAttribute?.('aria-label') || ''} ${button.getAttribute?.('title') || ''} ${button.getAttribute?.('data-icon') || ''} ${button.getAttribute?.('name') || ''} ${textOf(button)} ${button.className || ''} ${button.innerHTML || ''}`.toLowerCase();
      if (/解释图片|解释图像|explain\s*(image|picture)|attach|upload|image|photo|file|附件|上传|图片|文件|voice|microphone|语音|录音|麦克风|视频|音乐/.test(label)) return false;
      return /send|submit|发送|提交|arrow[-_ ]?up|paper[-_ ]?plane|enter/.test(label) || (!textOf(button) && !!button.querySelector?.('svg') && !/plus|add|more|翻译|音乐|视频/.test(label));
    }).at(-1);
    if (fallback) return fallback;
    const semantic = [...(root?.querySelectorAll?.('button,[role="button"]') || [])].filter(button => {
      if (!visible(button) || button.disabled || button.getAttribute?.('aria-disabled') === 'true') return false;
      const markup = `${button.outerHTML || ''} ${button.innerHTML || ''}`.toLowerCase();
      return /arrow[-_ ]?up|paper[-_ ]?plane|send|submit|发送|提交/.test(markup) && !/voice|microphone|语音|录音|attach|upload|附件|上传/.test(markup);
    }).at(-1);
    return semantic || null;
  }

  const DOLA_MESSAGE_SELECTORS = [
    '[data-message-id]', '[data-testid*="message" i]', '[data-testid*="conversation" i]', '[data-testid*="turn" i]',
    '[class*="message" i]', '[class*="conversation" i]', '[class*="turn" i]', '[class*="chat-item" i]', '[class*="bubble" i]'
  ];
  const DOLA_ASSISTANT_SELECTORS = [
    '[data-message-author-role="assistant"]', '[data-message-role="assistant"]', '[data-role="assistant"]',
    '[data-testid*="assistant" i]', '[class*="assistant" i]', '[class*="bot-message" i]', '[class*="ai-message" i]', '[class*="answer" i]', '[class*="reply" i]'
  ];
  const DOLA_USER_SELECTORS = [
    '[data-message-author-role="user"]', '[data-message-role="user"]', '[data-role="user"]',
    '[data-testid*="user-message" i]', '[class*="user-message" i]', '[class*="human-message" i]', '[class*="question" i]'
  ];
  // Doubao/Dola have shipped several completion phrasings: "图片已生成",
  // "已生成 4 张…", "已为你生成 …". Match the "已…生成/为你生成" family without
  // matching the in-progress "正在生成" indicator.
  const COMPLETION_TEXT = /已完成图片生成|图片生成完成|图片已生成|生成了图片|已(?:为你|帮你|给你|经)?\s*生成|为你生成|generated\s+(?:\d+\s+)?(?:an?|the|your)?\s*(?:images?|pictures?|artworks?)|(?:images?|pictures?)\s+(?:are|is|have been|has been)\s+(?:generated|ready)/i;

  function taskMarkerPattern(taskId) {
    const escaped = String(taskId || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return escaped ? new RegExp(`任务编号\\s*[:：]\\s*${escaped}(?:\\b|[。．.,，、\\s]|$)`) : /任务编号\s*[:：]/;
  }

  function queryAll(selectors, root = document) {
    const result = [];
    const seen = new Set();
    for (const selector of selectors || []) {
      try {
        for (const element of root?.querySelectorAll?.(selector) || []) {
          if (!seen.has(element)) { seen.add(element); result.push(element); }
        }
      } catch {}
    }
    return result;
  }

  function roleOf(element) {
    const attrs = ['data-message-author-role', 'data-message-role', 'data-role', 'data-author', 'data-sender', 'aria-label', 'aria-roledescription'];
    const value = attrs.map(name => element?.getAttribute?.(name) || '').join(' ').toLowerCase();
    const classes = String(element?.className || '').toLowerCase();
    if (/(?:^|[\s_-])(user|human|用户|question)(?:$|[\s_-])/.test(`${value} ${classes}`)) return 'user';
    if (/(?:^|[\s_-])(assistant|bot|ai|dola|助手|answer|reply)(?:$|[\s_-])/.test(`${value} ${classes}`)) return 'assistant';
    return '';
  }

  function isComposerElement(element) {
    if (!element) return false;
    const marker = `${element.getAttribute?.('data-testid') || ''} ${element.getAttribute?.('aria-label') || ''} ${element.className || ''}`.toLowerCase();
    return /composer|chat[-_ ]?input|prompt|editor|input[-_ ]?area|footer/.test(marker) || !!element.querySelector?.('textarea,input[contenteditable="true"],[role="textbox"]');
  }

  function allTaskTextElements(taskId) {
    const marker = String(taskId || '') ? taskMarkerPattern(taskId) : null;
    const candidates = queryAll([...DOLA_USER_SELECTORS, ...DOLA_MESSAGE_SELECTORS]);
    const matching = candidates.filter(element => visible(element) && !isComposerElement(element) && (marker ? marker.test(textOf(element)) : /任务编号\s*[:：]/.test(textOf(element))));
    if (matching.length) return matching;
    try {
      return [...(document.querySelectorAll?.('body *') || [])].filter(element => visible(element) && !isComposerElement(element) && (marker ? marker.test(textOf(element)) : /任务编号\s*[:：]/.test(textOf(element))));
    } catch { return []; }
  }

  function chooseTaskAnchor(elements) {
    const values = [...new Set(elements || [])].filter(Boolean);
    if (!values.length) return null;
    values.sort((a, b) => {
      const roleScore = element => roleOf(element) === 'user' ? 0 : (element.hasAttribute?.('data-message-id') ? 1 : 2);
      const score = roleScore(a) - roleScore(b);
      if (score) return score;
      return textOf(a).length - textOf(b).length;
    });
    return values[0] || null;
  }

  function taskRequest(taskId, requestFingerprint = '') {
    const marker = `任务编号：${String(taskId || '')}`;
    const users = userMessages();
    const byFingerprint = String(requestFingerprint || '') && users.findLast(message => message.fingerprint === String(requestFingerprint));
    if (byFingerprint) return byFingerprint;
    if (requestFingerprint) {
      const element = chooseTaskAnchor(queryAll(['body *']).filter(element => visible(element) && !isComposerElement(element) && roleOf(element) !== 'assistant' && hash(textOf(element) || element.innerHTML || '') === requestFingerprint));
      if (element) return { element, text: textOf(element), fingerprint: requestFingerprint };
    }
    const anchor = chooseTaskAnchor(allTaskTextElements(taskId));
    if (!anchor) return null;
    return { element: anchor, text: textOf(anchor), fingerprint: hash(textOf(anchor)) };
  }

  function taskIdFromText(text) {
    const match = String(text || '').match(/任务编号\s*[:：]\s*([A-Za-z0-9_-]+)/);
    return match ? match[1] : '';
  }

  function isAfter(first, second) {
    try { return !!(first?.compareDocumentPosition && (first.compareDocumentPosition(second) & 4)); } catch { return false; }
  }

  function actionCount(element) {
    return queryAll(['button', '[role="button"]'], element).filter(control => {
      if (!visible(control)) return false;
      const label = `${control.getAttribute?.('aria-label') || ''} ${control.getAttribute?.('title') || ''} ${textOf(control)} ${control.className || ''}`.toLowerCase();
      return !/send|submit|发送|提交|attach|upload|上传|voice|microphone|语音/.test(label);
    }).length;
  }

  function hasCompletionEvidence(turn, candidate = null) {
    const text = textOf(turn?.element || turn);
    if (COMPLETION_TEXT.test(text)) return true;
    if (!candidate) return false;
    return queryAll(['button', '[role="button"]', 'a[href]'], turn?.element || turn).some(control => {
      const label = `${control.getAttribute?.('aria-label') || ''} ${control.getAttribute?.('title') || ''} ${control.getAttribute?.('download') || ''} ${textOf(control)} ${control.className || ''}`.toLowerCase();
      return /download|下载|保存图片|复制图片|重新生成|regenerate|save|original|原图/.test(label);
    });
  }

  // Completed replies mount an icon-only action toolbar next to the message
  // row (the current design labels none of its icons). Treat a populated,
  // non-user toolbar beside the result as a completion signal.
  function resultActionBarPresent(element) {
    let scope = element?.element || element;
    for (let depth = 0; scope && depth < 6; depth += 1, scope = scope.parentElement) {
      const bars = scope.querySelectorAll?.('[class*="action-bar" i],[class*="actionbar" i],[class*="toolbar" i],[class*="message-tools" i]');
      for (const bar of bars || []) {
        if (!visible(bar) || /justify-end|text-right/.test(String(bar.className || ''))) continue;
        const count = [...bar.querySelectorAll('button,[role="button"]')].filter(visible).length;
        if (count >= 4) return true;
      }
    }
    return false;
  }

  function imageCardFor(image) {
    if (!image) return null;
    if (String(image.tagName || '').toLowerCase() !== 'img') return image;
    let current = image.parentElement || null;
    for (let depth = 0; current && depth < 10; depth++, current = current.parentElement) {
      const text = textOf(current);
      if (COMPLETION_TEXT.test(text) || actionCount(current) > 0) return current;
    }
    return image.parentElement || image;
  }

  function assistantMessages() {
    const result = [];
    const seen = new Set();
    for (const element of queryAll([...DOLA_ASSISTANT_SELECTORS, ...DOLA_MESSAGE_SELECTORS])) {
      if (!visible(element) || seen.has(element) || isComposerElement(element)) continue;
      const role = roleOf(element);
      const raw = textOf(element);
      if (role === 'user' || /任务编号\s*[:：]/.test(raw)) continue;
      const text = extractAssistantText(element);
      if (!text) continue;
      seen.add(element);
      result.push({ element, text, fingerprint: hash(text) });
    }
    return result;
  }

  function assistantTurns() {
    const result = [];
    const seen = new Set();
    for (const element of queryAll([...DOLA_ASSISTANT_SELECTORS, ...DOLA_MESSAGE_SELECTORS])) {
      if (!visible(element) || seen.has(element) || isComposerElement(element)) continue;
      const role = roleOf(element);
      const raw = textOf(element);
      if (role === 'user' || /任务编号\s*[:：]/.test(raw)) continue;
      const hasImage = !!element.querySelector?.('img');
      const text = extractAssistantText(element);
      if (!text && !hasImage) continue;
      seen.add(element); result.push({ element, text, fingerprint: hash(element.innerHTML || raw) });
    }
    for (const image of queryAll(['img'])) {
      if (!visible(image)) continue;
      const card = imageCardFor(image);
      if (!card || seen.has(card) || isComposerElement(card) || roleOf(card) === 'user') continue;
      const text = textOf(card);
      if (/任务编号\s*[:：]/.test(text) || !hasCompletionEvidence({ element: card }, imageCandidates({ element: card })[0])) continue;
      seen.add(card);
      result.push({ element: card, text: extractAssistantText(card), fingerprint: hash(card.innerHTML || text) });
    }
    return result;
  }

  // Resolve every result <img> inside a turn to its unwatermarked raw URL via
  // the bridge; keep the rendered URL as previewImageUrl for diagnostics.
  // The same generated image renders twice (a small cthumb and a larger
  // cpreview); collapse both to one stable source id so it is imported once.
  function imageSourceKey(value) {
    const url = String(value || '');
    const genId = url.match(/\/(?:rc_gen_image|creations?|gen_image)\/([a-z0-9]{12,})/i);
    if (genId) return genId[1].toLowerCase();
    try {
      const parsed = new URL(url, globalThis.location?.href);
      // ImageX encodes the transform template after '~'; the source file path
      // before it is shared by every rendered variant of one image.
      const path = parsed.pathname.split('~')[0];
      return `${parsed.origin}${path}`;
    } catch { return url.split('~')[0]; }
  }
  function dedupeImageCandidates(list) {
    const groups = new Map();
    for (const candidate of list || []) {
      const key = candidate?.rawImageUrl ? imageSourceKey(candidate.rawImageUrl) : imageSourceKey(candidate?.previewImageUrl);
      const existing = groups.get(key);
      if (!existing) { groups.set(key, candidate); continue; }
      const candidateScore = Number(candidate.width || 0) + (candidate.rawImageUrl ? 1 : 0);
      const existingScore = Number(existing.width || 0) + (existing.rawImageUrl ? 1 : 0);
      if (candidateScore > existingScore) groups.set(key, candidate);
    }
    return [...groups.values()];
  }
  function imageCandidates(turn, record = null) {
    const element = turn?.element || turn;
    const images = String(element?.tagName || '').toLowerCase() === 'img' ? [element] : [...(element?.querySelectorAll?.('img') || [])];
    const result = [];
    const seen = new Set();
    for (const image of images) {
      if (!image || seen.has(image)) continue;
      seen.add(image);
      const url = String(image.currentSrc || image.src || '').trim();
      if (!url || /^data:image\/svg|^about:blank/i.test(url)) continue;
      const marker = `${image.alt || ''} ${image.getAttribute?.('aria-label') || ''} ${image.className || ''} ${image.closest?.('button')?.getAttribute?.('aria-label') || ''}`.toLowerCase();
      if (/avatar|profile|logo|icon|favicon|placeholder|thumbnail|thumb|copy|download|user|emoji|sticker/.test(marker)) continue;
      if (/processing|loading|generating|error|failed|失败|处理中|加载中/.test(marker)) continue;
      const rect = image.getBoundingClientRect?.() || {};
      const width = Number(image.naturalWidth || image.width || rect.width || 0);
      const height = Number(image.naturalHeight || image.height || rect.height || 0);
      if (image.complete === false || (image.naturalWidth != null && image.naturalWidth <= 0)) continue;
      if ((width && width < 64) || (height && height < 64)) continue;
      const aliases = [url, String(image.src || ''), String(image.getAttribute?.('src') || ''), String(image.getAttribute?.('data-src') || '')];
      const srcset = String(image.getAttribute?.('srcset') || '');
      for (const entry of srcset.split(',')) aliases.push(entry.trim().split(/\s+/)[0] || '');
      let raw = '';
      if (record?.taskId) for (const alias of aliases) { raw = rawForAlias(record.taskId, alias); if (raw) break; }
      result.push({ image, imageUrl: raw || url, previewImageUrl: url, rawImageUrl: raw, width, height, fingerprint: hash(`${raw || url}|${width}|${height}`) });
    }
    return result;
  }
  function imageCandidate(turn, record = null) { return imageCandidates(turn, record)[0] || null; }

  function findImageReply(record) {
    const users = userMessages();
    const request = taskRequest(record.taskId, record.requestFingerprint) || users.findLast(message => message.fingerprint === record.requestFingerprint || message.text.includes(`任务编号：${record.taskId}`));
    if (!request) return null;
    const laterTask = users.findLast(message => {
      const candidateTask = taskIdFromText(message.text);
      return candidateTask && candidateTask !== String(record.taskId) && isAfter(request.element, message.element);
    });
    if (laterTask) throw new Error('Dola会话中出现了其他请求，已停止监听，避免取错回复。');
    const turns = assistantTurns().filter(message => {
      if (record.baselineElements?.has(message.element) && record.baselineTurnFingerprints?.get?.(message.element) === message.fingerprint) return false;
      if (!request.element?.compareDocumentPosition) return true;
      return !!(request.element.compareDocumentPosition(message.element) & 4);
    });
    const candidates = [];
    const seenImages = new Set();
    const seenResults = new Set();
    let representative = null;
    for (const turn of turns) {
      const current = imageCandidates(turn, record);
      if (current.length) representative = turn;
      for (const candidate of current) {
        if (candidate.image && seenImages.has(candidate.image)) continue;
        const resultKey = `${candidate.previewImageUrl}|${candidate.rawImageUrl || ''}|${candidate.width}|${candidate.height}`;
        if (seenResults.has(resultKey)) continue;
        if (candidate.image) seenImages.add(candidate.image);
        seenResults.add(resultKey);
        candidates.push(candidate);
      }
    }
    if (!candidates.length || !representative) return null;
    const deduped = dedupeImageCandidates(candidates);
    candidates.length = 0;
    candidates.push(...deduped);
    const fingerprint = hash(candidates.map(item => item.fingerprint).join('|'));
    return { ...representative, candidate: candidates[0], candidates, fingerprint };
  }

  // Page-side decode is best-effort. Cross-origin HTTPS originals that cannot be
  // read in-page fall back to the worker, which fetches them with host rights.
  async function fetchCandidateBlob(candidate) {
    const url = String(candidate?.imageUrl || '');
    if (!url || /^https?:/i.test(url) || /^blob:|^data:/i.test(url)) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(url, { credentials: 'include', signal: controller.signal });
        if (response.ok) return await response.blob();
      } catch {} finally { clearTimeout(timeout); }
    }
    return null;
  }

  async function blobToDataUrl(blob) {
    if (!blob || blob.size <= 0 || blob.size > 25 * 1024 * 1024) return '';
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let type = '';
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) type = 'image/png';
    else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) type = 'image/jpeg';
    else if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) type = 'image/webp';
    else if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) type = 'image/gif';
    if (!type) return '';
    let binary = '';
    try {
      for (let offset = 0; offset < bytes.length; offset += 32 * 1024) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024));
      return `data:${type};base64,${btoa(binary)}`;
    } catch { return ''; }
    finally { binary = ''; }
  }

  async function dataUrlToBlob(value) {
    const match = String(value || '').match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/i);
    if (!match) return null;
    const binary = atob(match[2]);
    if (!binary.length || binary.length > 12 * 1024 * 1024) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: match[1].toLowerCase() });
  }

  function userMessages(expectedText = null) {
    const result = [];
    const seen = new Set();
    for (const element of queryAll([...DOLA_USER_SELECTORS, ...DOLA_MESSAGE_SELECTORS])) {
      if (!visible(element) || seen.has(element) || isComposerElement(element)) continue;
      const role = roleOf(element);
      const text = textOf(element);
      if ((!text && !element.querySelector?.('img')) || (role !== 'user' && !/任务编号\s*[:：]/.test(text) && !(expectedText && promptMatches(text, expectedText)))) continue;
      if (result.some(item => item.element !== element && (item.element.contains?.(element) || element.contains?.(item.element)))) continue;
      seen.add(element); result.push({ element, text, fingerprint: hash(text || element.innerHTML || '') });
    }
    for (const element of allTaskTextElements('')) {
      if (!visible(element) || seen.has(element)) continue;
      const text = textOf(element);
      if (!text || !/任务编号\s*[:：]/.test(text)) continue;
      if (result.some(item => item.element !== element && (item.element.contains?.(element) || element.contains?.(item.element)))) continue;
      seen.add(element); result.push({ element, text, fingerprint: hash(text) });
    }
    if (expectedText) {
      for (const element of queryAll(['body *'])) {
        if (!visible(element) || seen.has(element) || isComposerElement(element) || roleOf(element) === 'assistant' || !promptMatches(textOf(element), expectedText)) continue;
        if (result.some(item => item.element.contains?.(element) || element.contains?.(item.element))) continue;
        seen.add(element); result.push({ element, text: textOf(element), fingerprint: hash(textOf(element)) });
      }
    }
    return result;
  }

  // The Samantha/Dola composer has no stop button or [data-state=loading]
  // while an image is produced; the only in-progress signal is a short
  // streaming status such as "正在生成图片" / "Generating image".
  function streamingBusyText(root = document) {
    try {
      const leaves = root.querySelectorAll?.('div,span,p');
      for (const element of leaves || []) {
        if (element.children?.length || !(element.offsetParent || element.getClientRects?.().length)) continue;
        if (isComposerElement(element)) continue;
        const text = textOf(element);
        if (text.length > 48) continue;
        if (/正在生成|生成中|正在绘制|正在创作|排队中|generating|creating\s+(?:your\s+|an?\s+|the\s+)?(?:image|picture|artwork|art)/i.test(text)) return element;
      }
    } catch {}
    return null;
  }

  function generationBusy() {
    const selectors = ['[data-testid*="stop"]', 'button[aria-label*="Stop" i]', 'button[aria-label*="停止"]', '[data-state="loading"]', '[class*="loading" i][class*="generate" i]'];
    if (selectors.some(selector => [...document.querySelectorAll(selector)].some(visible))) return true;
    return !!streamingBusyText();
  }

  function waitUntil(predicate, timeout, onTick = null) {
    return new Promise(resolve => {
      const start = Date.now();
      const tick = () => {
        let value = false;
        try { value = predicate(); } catch {}
        if (value || Date.now() - start >= timeout) return resolve(value);
        try { onTick?.(value, Date.now() - start); } catch {}
        setTimeout(tick, 250);
      };
      tick();
    });
  }

  function dispose(taskId) {
    const record = active.get(taskId);
    if (!record) return;
    if (record.observer) record.observer.disconnect();
    clearTimeout(record.timeout);
    clearTimeout(record.stabilityTimer);
    clearTimeout(record.pollTimer);
    active.delete(taskId);
    try { if (record.rawBridgeToken) globalThis.postMessage?.({ source: 'quickdraw-dola-raw-cleanup-v1', taskId: String(taskId), bridgeToken: record.rawBridgeToken }, globalThis.location?.origin || '*'); } catch {}
    clearRawBridge(taskId);
  }

  function watchReply(record) {
    const taskId = record.taskId;
    record.stage = 'generating';
    if (record.phaseEvents) emitPhase(taskId, 'generating', { progress: 0 });
    const startedAt = Date.now();
    let scheduled = false;
    const schedule = delay => {
      if (scheduled || !active.has(taskId)) return;
      scheduled = true;
      record.pollTimer = setTimeout(() => { scheduled = false; record.pollTimer = null; checkImage(); }, delay);
    };

    async function checkImage() {
      if (!active.has(taskId) || record.returning) return;
      let message;
      try { message = findImageReply(record); }
      catch (error) { dispose(taskId); emit(taskId, 'needs-attention', { code: error.code || '', error: error.message }); return; }
      const candidates = Array.isArray(message?.candidates) ? message.candidates : (message?.candidate ? [message.candidate] : []);
      const busy = generationBusy();
      if (busy) record.sawBusy = true;
      const key = message?.fingerprint || (candidates.length ? hash(candidates.map(item => item.fingerprint).join('|')) : '');
      if (key && key !== record.lastImageKey) { record.lastImageKey = key; record.lastImageChangedAt = Date.now(); }
      const stableFor = record.lastImageChangedAt ? Date.now() - record.lastImageChangedAt : 0;
      const turn = message?.element.closest?.('article,[data-message-id],[class*="message" i],[class*="conversation" i]') || message?.element;
      const ended = hasCompletionEvidence({ element: turn }, candidates[0]) || candidates.some(item => hasCompletionEvidence({ element: imageCardFor(item.image) }, item)) || resultActionBarPresent(turn) || (record.sawBusy && !busy && candidates.length > 0);
      // Guarantee the unwatermarked original: if generation finished but the
      // bridge has not resolved a raw URL yet, wait briefly instead of
      // importing a watermarked preview.
      const missingRaw = !!record.rawBridgeToken && candidates.some(item => !item.rawImageUrl);
      if (candidates.length && ended && !busy && missingRaw) {
        if (!record.rawMissingSince) record.rawMissingSince = Date.now();
        if (Date.now() - record.rawMissingSince >= RAW_MISSING_GRACE) {
          dispose(taskId);
          emit(taskId, 'needs-attention', { code: 'raw-image-unavailable', error: 'Dola 已完成图片生成，但没有拿到可核验的无水印原图地址。结果标签页已保留，可打开后继续读取。' });
          return;
        }
      } else if (candidates.length && !missingRaw) record.rawMissingSince = 0;
      if (candidates.length && !missingRaw && stableFor >= STABLE_WINDOW && !busy && ended) {
        record.returning = true;
        if (record.phaseEvents) emitPhase(taskId, 'returning', { progress: 0 });
        const images = [];
        try {
          for (const item of candidates) {
            if (!active.has(taskId)) return;
            let imageDataUrl = '';
            let imageBlob = null;
            try {
              imageBlob = await fetchCandidateBlob(item);
              // blob:/data: 地址无法在扩展后台恢复，必须内联；HTTPS 大图改为只
              // 回传地址，避免多张 base64 同时驻留导致渲染进程内存尖峰崩溃。
              const mustInline = !/^https:\/\//i.test(item.imageUrl);
              if (imageBlob && (mustInline || imageBlob.size <= INLINE_IMAGE_BYTES)) {
                imageDataUrl = await blobToDataUrl(imageBlob);
              }
            } catch (error) {
              if (!/^https:\/\//i.test(item.imageUrl)) throw error;
            } finally { imageBlob = null; }
            images.push({ imageUrl: item.imageUrl, imageDataUrl, width: item.width, height: item.height, fingerprint: item.fingerprint });
            // 让出事件循环，使上一张的临时缓冲尽快被回收。
            await yieldToEventLoop();
          }
        } catch (error) {
          if (!active.has(taskId)) return;
          dispose(taskId);
          emit(taskId, 'needs-attention', { code: 'image-read-failed', error: String(error?.message || 'Dola 图片读取失败，请打开结果页后继续。') });
          return;
        }
        if (!active.has(taskId)) return;
        dispose(taskId);
        const first = images[0] || {};
        emit(taskId, 'image-reply', { phase: 'complete', images, imageUrl: first.imageUrl || '', imageDataUrl: first.imageDataUrl || '', fingerprint: key, imageWidth: first.width || 0, imageHeight: first.height || 0 });
        return;
      }
      if (Date.now() - startedAt >= REPLY_TIMEOUT || (record.deadlineAt && Date.now() >= record.deadlineAt)) {
        dispose(taskId); emit(taskId, 'needs-attention', { code: 'reply-timeout', error: 'Dola 回复超时，未自动重发。' }); return;
      }
      schedule(generationBusy() ? 450 : 700);
    }

    schedule(350);
    record.observer = new MutationObserver(() => schedule(180));
    if (document.body) record.observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  }

  function findAttachmentInput(anchor = null) {
    const root = anchor ? composerRoot(anchor) : null;
    const scoped = [...(root?.querySelectorAll?.('input[type="file"]') || [])];
    const all = [...(document.querySelectorAll?.('input[type="file"]') || [])];
    const candidates = scoped.length ? scoped : all;
    return candidates.reverse().find(element => element && element.isConnected !== false && !element.disabled) || null;
  }

  // Radix controls ignore a synthetic element.click(): the menu popper opens
  // empty and never renders its items. Dispatch the full pointer sequence a
  // real user click produces, falling back to .click() for plain buttons.
  function realActivate(element) {
    if (!element) return false;
    try {
      element.scrollIntoView?.({ block: 'center', inline: 'center' });
      const rect = element.getBoundingClientRect?.() || {};
      const base = {
        bubbles: true, cancelable: true, composed: true, view: globalThis, button: 0,
        clientX: rect.x != null ? rect.x + (Number(rect.width) || 0) / 2 : 0,
        clientY: rect.y != null ? rect.y + (Number(rect.height) || 0) / 2 : 0
      };
      const fire = (Type, name, extra = {}) => {
        try { element.dispatchEvent(new Type(name, { ...base, ...extra })); }
        catch { try { element.dispatchEvent(new Event(name, { bubbles: true, cancelable: true })); } catch {} }
      };
      fire(PointerEvent, 'pointerover', { pointerId: 1 });
      fire(PointerEvent, 'pointerenter', { pointerId: 1 });
      fire(PointerEvent, 'pointerdown', { pointerId: 1 });
      fire(MouseEvent, 'mousedown');
      try { element.focus?.(); } catch {}
      fire(PointerEvent, 'pointerup', { pointerId: 1 });
      fire(MouseEvent, 'mouseup');
      fire(MouseEvent, 'click');
      return true;
    } catch {
      try { element.click(); return true; } catch { return false; }
    }
  }

  // Dola/Samantha mounts its hidden <input type="file"> only after the user
  // clicks the composer "+" button, which carries no text, aria-label, title
  // or data-icon. Identify it structurally: an icon-only button (no text),
  // never the send control, whose glyph is drawn with perpendicular H/V bars
  // (the plus), falling back to the sole icon-only non-send control.
  function isSendControl(element) {
    if (!element) return false;
    if (element.id === 'flow-end-msg-send') return true;
    const marker = `${element.className || ''} ${element.outerHTML || ''}`.toLowerCase();
    return /send-msg-btn|send-button|paper-plane|arrow[-_ ]?up/.test(marker);
  }
  function plusGlyphButton(element) {
    if (!element || element.tagName !== 'BUTTON' || textOf(element)) return false;
    if (isSendControl(element)) return false;
    const paths = [...(element.querySelectorAll?.('svg path') || [])];
    if (!paths.length || !element.querySelector?.('svg')) return false;
    return paths.some(path => {
      const d = String(path.getAttribute?.('d') || '');
      return /H/.test(d) && /V/.test(d);
    });
  }
  function iconOnlyNonSend(element) {
    if (!element || textOf(element)) return false;
    if (isSendControl(element)) return false;
    return !!element.querySelector?.('svg');
  }

  function findAttachmentButton(anchor = null, clicked = new Set()) {
    const root = anchor ? composerRoot(anchor) : document;
    const scoped = [...(root?.querySelectorAll?.('button,[role="button"]') || [])];
    const candidates = scoped.length ? scoped : [...(document.querySelectorAll?.('button,[role="button"]') || [])];
    const usable = candidates.filter(element => visible(element) && !element.disabled && !clicked.has(element));
    const description = element => `${element.getAttribute?.('aria-label') || ''} ${element.getAttribute?.('title') || ''} ${textOf(element)} ${element.className || ''} ${element.outerHTML || ''}`.toLowerCase();
    return usable.find(element => /attach|upload|add (?:file|photo|image)|image upload|paperclip|附件|上传|添加图片|选择图片|本地图片|文件/.test(description(element)))
      || usable.find(element => /^\s*\+\s*$/.test(textOf(element)) || /aria-label=["'][^"']*(?:add|plus|more|更多)[^"']*["']|data-icon=["']plus["']|icon-plus|lucide-plus/.test(description(element)))
      || usable.find(plusGlyphButton)
      || (() => { const iconOnly = usable.filter(iconOnlyNonSend); return iconOnly.length === 1 ? iconOnly[0] : null; })()
      || null;
  }

  // Logged-in Dola (Samantha) hides local upload behind two layers: the "+"
  // control opens a radix menu whose "上传文件或图片" item only then mounts the
  // hidden <input type="file">. Some builds mount the input directly, so both
  // paths are supported.
  const UPLOAD_MENU_ITEM_TEXT = /上传(?:文件或图片|文件|图片|本地)|选择(?:本地)?(?:文件|图片)|从本地上传|upload\s*(?:file|image)?|attach/i;
  const NON_UPLOAD_MENU_ITEM = /云盘|网盘|云端|drive|cloud|技能|skill|拍照|拍摄|camera/i;
  function findOpenUploadMenuItem() {
    let fallback = null;
    for (const menu of document.querySelectorAll?.('[role="menu"][data-state="open"],[role="dialog"][data-state="open"]') || []) {
      if (!visible(menu)) continue;
      for (const item of menu.querySelectorAll?.('[role="menuitem"],[role="menuitemcheckbox"],button,a,li') || []) {
        if (!visible(item)) continue;
        const label = `${item.getAttribute?.('aria-label') || ''} ${textOf(item)} ${item.className || ''}`;
        if (NON_UPLOAD_MENU_ITEM.test(label)) continue;
        if (UPLOAD_MENU_ITEM_TEXT.test(label)) return item;
        if (!fallback && /上传|upload|文件|图片|file|image/i.test(label)) fallback = item;
      }
    }
    return fallback;
  }

  async function openAttachmentInput(anchor, timeout = 10_000) {
    const clicked = new Set();
    const menuTried = new Set();
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      const existing = findAttachmentInput(anchor);
      if (existing) return existing;
      // An open upload menu takes priority: choose its local-upload item.
      const menuItem = findOpenUploadMenuItem();
      if (menuItem && !menuTried.has(menuItem)) { menuTried.add(menuItem); realActivate(menuItem); await new Promise(resolve => setTimeout(resolve, 350)); continue; }
      // Otherwise reveal the picker by clicking the "+"/attach control.
      const button = findAttachmentButton(anchor, clicked);
      if (button) { clicked.add(button); realActivate(button); }
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    return findAttachmentInput(anchor);
  }

  function attachmentMarkers(input = null) {
    const selectors = '[data-testid*="attachment" i],[aria-label*="attachment" i],[class*="attachment" i],[data-testid*="upload" i],[class*="upload" i],[data-testid*="file" i],[class*="file" i]';
    const root = composerRoot(input);
    const nodes = root?.querySelectorAll?.(selectors) || document.querySelectorAll(selectors) || [];
    return [...nodes].filter(visible);
  }

  function attachmentPreviewImages(input) {
    const root = composerRoot(input);
    const candidates = [...(root?.querySelectorAll?.('img') || [])];
    if (!candidates.length && root === document) candidates.push(...(document.querySelectorAll?.('img') || []));
    return [...new Set(candidates)].filter(image => {
      const marker = `${image.alt || ''} ${image.getAttribute?.('aria-label') || ''} ${image.className || ''}`.toLowerCase();
      return visible(image) && !/avatar|profile|logo|icon|emoji/.test(marker);
    });
  }

  function attachmentPreviewState(image) {
    return `${image?.currentSrc || image?.src || image?.getAttribute?.('src') || ''}|${Number(image?.naturalWidth || 0)}x${Number(image?.naturalHeight || 0)}|${image?.complete === false ? 'loading' : 'complete'}`;
  }
  function isLoadedAttachmentPreview(image) {
    return !!image && image.complete !== false && Number(image.naturalWidth || 0) > 0 && Number(image.naturalHeight || 0) > 0 && !/^data:image\/svg|^about:blank/i.test(String(image.currentSrc || image.src || ''));
  }
  function attachmentProgress(element) {
    const ariaNow = Number(element?.getAttribute?.('aria-valuenow'));
    if (Number.isFinite(ariaNow) && (element?.getAttribute?.('role') === 'progressbar' || element?.getAttribute?.('aria-valuemax'))) return Math.max(0, Math.min(100, ariaNow));
    const source = [element?.getAttribute?.('aria-valuenow'), element?.getAttribute?.('data-progress'), element?.getAttribute?.('value'), textOf(element)].filter(Boolean).join(' ');
    const match = source.match(/(?:^|\s|[(:])([0-9]{1,3})(?:\s*%|\s*\/\s*100\b)/);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
  }
  function attachmentIsBusy(element) {
    const progress = attachmentProgress(element);
    if (progress != null && progress < 100) return true;
    const state = `${element?.getAttribute?.('data-state') || ''} ${element?.getAttribute?.('aria-busy') || ''} ${textOf(element)}`.toLowerCase();
    return element?.getAttribute?.('aria-busy') === 'true' || /uploading|processing|loading|上传中|处理中|加载中/.test(state);
  }
  function attachmentIsError(element) {
    const state = `${element?.getAttribute?.('data-state') || ''} ${element?.getAttribute?.('aria-label') || ''} ${textOf(element)}`.toLowerCase();
    return /upload[- ]?failed|upload[- ]?error|failed|error|上传失败|上传错误|处理失败/.test(state);
  }
  function attachmentIsComplete(element) {
    if (!element) return false;
    if (attachmentIsError(element)) return false;
    const progress = attachmentProgress(element);
    if (progress != null && progress < 100) return false;
    if (attachmentIsBusy(element) && progress !== 100) return false;
    const state = `${element.getAttribute?.('data-state') || ''} ${element.getAttribute?.('aria-label') || ''} ${textOf(element)}`.toLowerCase();
    return progress === 100 || /uploaded|complete|completed|ready|已上传|完成|就绪/.test(state);
  }
  function attachmentMarkerState(element) {
    const attrs = ['data-state', 'aria-busy', 'aria-valuenow', 'aria-valuemax', 'role', 'title', 'aria-label'];
    return `${attrs.map(name => `${name}:${element?.getAttribute?.(name) || ''}`).join('|')}|class:${element?.className || ''}|text:${textOf(element).slice(0, 300)}`;
  }
  function attachmentReadyEvidence(marker, preview, sendReady) {
    if (!sendReady || (marker && (attachmentIsBusy(marker) || attachmentIsError(marker)))) return false;
    return !!((marker && attachmentIsComplete(marker)) || isLoadedAttachmentPreview(preview));
  }

  async function waitForAttachment(taskId, input, baselineMarkers, baselinePreviews = new Map(), expectedCount = 1, options = {}) {
    let lastActivityAt = Date.now();
    let targetMarker = null;
    let lastProgress = -1;
    let emittedProgress = -1;
    let lastBusy = false;
    let readySince = 0;
    let incompleteSince = 0;
    let lastState = { expectedCount, readyCount: 0, previewCount: 0, markerCount: 0, inputFileCount: 0, busy: false, error: false };
    while (active.has(taskId)) {
      const currentInput = findAttachmentInput(input) || input;
      const markers = attachmentMarkers(currentInput);
      const previousTarget = targetMarker;
      if (!targetMarker || !markers.includes(targetMarker)) targetMarker = markers.find(element => !baselineMarkers.has(element) || baselineMarkers.get(element) !== attachmentMarkerState(element)) || null;
      const progress = targetMarker ? (attachmentProgress(targetMarker) ?? -1) : -1;
      const progressAdvanced = progress > lastProgress;
      const busy = !!targetMarker && attachmentIsBusy(targetMarker);
      if ((!previousTarget && targetMarker) || progressAdvanced || busy !== lastBusy) lastActivityAt = Date.now();
      lastBusy = busy;
      if (progressAdvanced) lastProgress = progress;
      if (progress >= 0 && progress !== emittedProgress) { emittedProgress = progress; emitPhase(taskId, 'uploading', { progress: progress / 100 }); }
      if (targetMarker && attachmentIsError(targetMarker)) return options.details ? { ok: false, code: 'marker-error', ...lastState } : false;
      const previews = attachmentPreviewImages(currentInput);
      const freshPreviews = previews.filter(image => !baselinePreviews.has(image) || baselinePreviews.get(image) !== attachmentPreviewState(image));
      const freshMarkers = markers.filter(element => !baselineMarkers.has(element) || baselineMarkers.get(element) !== attachmentMarkerState(element));
      const sendReady = !!findSendButton();
      const completePreviews = freshPreviews.filter(isLoadedAttachmentPreview).length;
      const completeMarkers = freshMarkers.filter(attachmentIsComplete).filter(marker => !freshMarkers.some(other => other !== marker && attachmentIsComplete(other) && marker.contains?.(other))).length;
      const busyMarkers = freshMarkers.filter(attachmentIsBusy);
      const errorMarkers = freshMarkers.filter(attachmentIsError);
      const readyCount = Math.max(completePreviews, completeMarkers, expectedCount === 1 && attachmentReadyEvidence(targetMarker, freshPreviews[0], sendReady) ? 1 : 0);
      const inputFileCount = Number(currentInput?.files?.length || 0);
      lastState = { expectedCount, readyCount, previewCount: freshPreviews.length, markerCount: freshMarkers.length, inputFileCount, busy: busyMarkers.length > 0, error: errorMarkers.length > 0 };
      if (readyCount >= expectedCount && !busyMarkers.length && !errorMarkers.length) {
        if (!readySince) readySince = Date.now();
        if (Date.now() - readySince >= 800) return options.details ? { ok: true, ...lastState } : true;
        incompleteSince = 0;
      } else {
        readySince = 0;
        if (expectedCount > 1 && sendReady && readyCount > 0 && !busyMarkers.length && !errorMarkers.length) {
          if (!incompleteSince) incompleteSince = Date.now();
          if (Date.now() - incompleteSince >= INCOMPLETE_ATTACHMENT_TIMEOUT) return options.details ? { ok: false, code: 'incomplete', ...lastState } : false;
        } else incompleteSince = 0;
      }
      if (Date.now() - lastActivityAt >= UPLOAD_INACTIVITY_TIMEOUT) return options.details ? { ok: false, code: 'stalled', ...lastState } : false;
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    return options.details ? { ok: false, code: 'cancelled', ...lastState } : false;
  }

  async function attachImagesDetailed(blobs, taskId = '') {
    const values = (blobs || []).filter(Boolean);
    if (!values.length) return { ok: true, expectedCount: 0, readyCount: 0, previewCount: 0, markerCount: 0, inputFileCount: 0 };
    emitPhase(taskId, 'uploading', { progress: 0 });
    const initialInput = findAttachmentInput();
    const baselineMarkers = new Map(attachmentMarkers(initialInput).map(element => [element, attachmentMarkerState(element)]));
    const baselinePreviews = new Map(attachmentPreviewImages(initialInput).map(image => [image, attachmentPreviewState(image)]));
    let input = initialInput;
    if (!input) input = await openAttachmentInput(findInput(), 10_000);
    if (!input || typeof DataTransfer === 'undefined') return { ok: false, code: 'input-unavailable', expectedCount: values.length, readyCount: 0, previewCount: 0, markerCount: 0, inputFileCount: 0 };
    try {
      const transfer = new DataTransfer();
      values.forEach((blob, index) => {
        const file = typeof File !== 'undefined' ? new File([blob], `quickdraw-source-${String(index + 1).padStart(2, '0')}.png`, { type: blob.type || 'image/png' }) : blob;
        transfer.items.add(file);
      });
      input.files = transfer.files;
      if (Number(input.files?.length || 0) !== values.length) return { ok: false, code: 'file-picker-overwrite', expectedCount: values.length, readyCount: 0, previewCount: 0, markerCount: 0, inputFileCount: Number(input.files?.length || 0) };
      input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
      return await waitForAttachment(taskId, input, baselineMarkers, baselinePreviews, values.length, { details: true });
    } catch { return { ok: false, code: 'dispatch-failed', expectedCount: values.length, readyCount: 0, previewCount: 0, markerCount: 0, inputFileCount: Number(input.files?.length || 0) }; }
  }

  async function fillPrompt(taskId, prompt) {
    let attempted = false;
    let observed = '';
    for (let attempt = 0; attempt < PROMPT_FILL_ATTEMPTS; attempt++) {
      if (!active.has(taskId)) return { ok: false, code: 'cancelled', attempted, observed };
      const input = await waitUntil(() => findInput(), attempt ? 1_000 : 2_000);
      if (!input) continue;
      attempted = true;
      if (!setInputValue(input, prompt)) continue;
      const verified = await waitUntil(() => {
        const current = findInput();
        observed = inputText(current);
        return current && promptMatches(observed, prompt) ? current : false;
      }, PROMPT_READBACK_TIMEOUT);
      if (verified) return { ok: true, input: verified, observed };
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    return { ok: false, code: attempted ? 'readback-mismatch' : 'input-unavailable', attempted, observed };
  }

  async function start(taskId, prompt, mode = 'image-edit', imageDataUrl = '', imageDataUrls = [], rawBridgeToken = '') {
    if (active.size) {
      emit(taskId, 'needs-attention', { code: 'busy', error: 'Dola 专用标签页正在处理其他任务。' });
      return;
    }
    const reservation = { taskId, mode, stage: 'hydrating', deadlineAt: 0, rawBridgeToken: String(rawBridgeToken || '') };
    active.set(taskId, reservation);
    emitPhase(taskId, 'hydrating', { progress: 0 });
    const hydrated = await waitUntil(() => {
      if (authRequiredPage()) return { auth: true };
      const input = findInput();
      return input ? { input } : false;
    }, HYDRATE_TIMEOUT);
    if (active.get(taskId) !== reservation) return;
    if (hydrated?.auth) {
      dispose(taskId);
      emit(taskId, 'needs-attention', { code: 'auth-required', error: 'Dola 页面需要登录或完成验证，任务已暂停。请完成后点击“继续任务”。' });
      return;
    }
    const input = hydrated?.input || null;
    if (!input) {
      dispose(taskId);
      emit(taskId, 'needs-attention', { code: 'not-ready', error: '未找到 Dola 输入框，请先等待页面加载完成。' });
      return;
    }
    if (generationBusy()) { dispose(taskId); emit(taskId, 'needs-attention', { error: 'Dola 正在生成其他结果，未发送新需求。' }); return; }
    const imageValues = mode === 'image-edit' ? (Array.isArray(imageDataUrls) && imageDataUrls.length ? imageDataUrls : (imageDataUrl ? [imageDataUrl] : [])) : [];
    reservation.stage = mode === 'image-edit' && imageValues.length ? 'uploading' : 'sending';
    const imageBlobs = mode === 'image-edit' ? (await Promise.all(imageValues.map(value => dataUrlToBlob(value)))).filter(Boolean) : [];
    if (mode === 'image-edit' && imageValues.length) {
      const upload = imageBlobs.length === imageValues.length && imageBlobs.length ? await attachImagesDetailed(imageBlobs, taskId) : { ok: false, code: 'invalid-image-data', expectedCount: imageValues.length, readyCount: 0, previewCount: 0, markerCount: 0, inputFileCount: 0 };
      if (!upload.ok) {
        dispose(taskId);
        const count = Number(upload.readyCount || 0), expected = Number(upload.expectedCount || imageValues.length || 0);
        const detail = upload.code === 'incomplete' && expected > 1 ? `Dola 只确认了 ${count}/${expected} 张图片同时就绪，未发送需求。` : '图片上传失败或长时间没有可验证进展，未发送需求。';
        emit(taskId, 'needs-attention', { code: 'image-upload-failed', stage: 'uploading', expectedImageCount: expected, readyImageCount: count, error: detail });
        return;
      }
    }
    const baseline = assistantTurns();
    const baselineHashes = baseline.map(message => message.fingerprint);
    const baselineElements = new Set(baseline.map(message => message.element));
    const baselineUsers = userMessages(prompt);
    const baselineUserElements = new Set(baselineUsers.map(message => message.element));
    const baselineTurnFingerprints = new Map(baseline.map(message => [message.element, message.fingerprint]));
    const record = { taskId, mode, stage: 'sending', phaseEvents: true, rawBridgeToken: String(rawBridgeToken || ''), baselineHashes, baselineElements, baselineTurnFingerprints, baselineUserElements, observer: null, timeout: null, pollTimer: null, stabilityTimer: null, sawBusy: false, lastImageKey: '', lastImageChangedAt: 0, rawMissingSince: 0, returning: false };
    active.set(taskId, record);
    requestRawBridgeReplay(taskId, record.rawBridgeToken);
    emit(taskId, 'ready');
    emitPhase(taskId, 'sending', { progress: 0 });
    const filled = await fillPrompt(taskId, prompt);
    if (active.get(taskId) !== record) return;
    if (!filled.ok) {
      dispose(taskId);
      const error = filled.code === 'input-unavailable' ? '未找到可用的 Dola 编辑器，未写入或发送内容。' : 'Dola 编辑器写入后完整需求回读校验未通过，未发送内容。';
      emit(taskId, 'needs-attention', { code: filled.code === 'input-unavailable' ? 'prompt-input-unavailable' : 'prompt-readback-failed', stage: 'sending', error });
      return;
    }
    const send = await waitUntil(() => findSendButton(), 3_000).then(found => found ? findSendButton() : null);
    if (active.get(taskId) !== record) return;
    if (!send) {
      dispose(taskId);
      emit(taskId, 'needs-attention', { code: 'send-control-not-found', error: '未找到 Dola 发送控件，未发送内容。' });
      return;
    }
    realActivate(send);
    const confirmedMessage = await waitUntil(() => {
      if (generationBusy()) record.sawBusy = true;
      return userMessages(prompt).find(message => !record.baselineUserElements.has(message.element) && (prompt.trim() ? promptMatches(message.text, prompt) : !!message.element.querySelector?.('img'))) || null;
    }, SEND_TIMEOUT);
    if (active.get(taskId) !== record) return;
    if (!confirmedMessage) {
      dispose(taskId);
      emit(taskId, 'needs-attention', { code: 'send-uncertain', error: '无法确认 Dola 是否已发送，未自动重试。' });
      return;
    }
    record.requestFingerprint = confirmedMessage?.fingerprint || '';
    record.stage = 'generating';
    emit(taskId, 'send-confirmed', { baselineHashes, requestFingerprint: record.requestFingerprint });
    watchReply(record);
  }

  async function resumeSending(record) {
    const found = await waitUntil(() => taskRequest(record.taskId, record.requestFingerprint), Math.max(1_000, Math.min(SEND_TIMEOUT, Number(record.deadlineAt || 0) - Date.now())));
    if (!active.has(record.taskId)) return;
    if (!found) {
      dispose(record.taskId);
      emit(record.taskId, 'needs-attention', { code: 'send-uncertain', error: '恢复后无法确认 Dola 是否已发送，未自动重试。' });
      return;
    }
    record.requestFingerprint = found.fingerprint;
    emitPhase(record.taskId, 'sending', { progress: 1 });
    emit(record.taskId, 'send-confirmed', { baselineHashes: record.baselineHashes || [], requestFingerprint: record.requestFingerprint });
    watchReply(record);
  }

  function resume(taskId, baselineHashes, requestFingerprint, deadlineAt, mode = 'image-edit', stage = 'generating', rawBridgeToken = '') {
    if (active.has(taskId)) return;
    if (active.size) throw new Error('无法确认原请求，未自动重发。');
    if (stage !== 'sending' && !requestFingerprint) throw new Error('无法确认原请求，未自动重发。');
    const record = { taskId, mode, phaseEvents: true, stage, rawBridgeToken: String(rawBridgeToken || ''), requestFingerprint: String(requestFingerprint || ''), deadlineAt, baselineHashes: Array.isArray(baselineHashes) ? baselineHashes : [], baselineElements: new Set(), baselineTurnFingerprints: new Map(), observer: null, timeout: null, pollTimer: null, stabilityTimer: null, sawBusy: false, lastImageKey: '', lastImageChangedAt: 0, rawMissingSince: 0, returning: false };
    active.set(taskId, record);
    requestRawBridgeReplay(taskId, record.rawBridgeToken);
    emit(taskId, 'resumed');
    const resumeStage = ['sending', 'generating', 'returning'].includes(stage) ? stage : 'generating';
    emitPhase(taskId, resumeStage, { progress: 0 });
    if (stage === 'sending') resumeSending(record).catch(error => { dispose(taskId); emit(taskId, 'needs-attention', { code: 'content-error', error: String(error?.message || 'Dola 页面恢复失败。') }); });
    else watchReply(record);
  }

  function probeTask(taskId, mode = 'image-edit', renewUntil = 0, baselineHashes = [], requestFingerprint = '') {
    const record = active.get(taskId);
    if (record) {
      if (Number(renewUntil) > Date.now()) record.deadlineAt = Number(renewUntil);
      return { active: true, stage: record.stage || 'generating', requestFound: !!record.requestFingerprint, requestFingerprint: record.requestFingerprint || '' };
    }
    const users = userMessages();
    const request = taskRequest(taskId, requestFingerprint) || users.findLast(message => message.fingerprint === String(requestFingerprint || '') || message.text.includes(`任务编号：${taskId}`));
    if (!request) return { active: false, requestFound: false, busy: generationBusy() };
    const baseline = new Set(Array.isArray(baselineHashes) ? baselineHashes.map(String) : []);
    const fresh = assistantTurns().filter(message => {
      if (baseline.has(message.fingerprint)) return false;
      if (!request.element?.compareDocumentPosition) return true;
      return !!(request.element.compareDocumentPosition(message.element) & 4);
    });
    const latest = fresh.at(-1) || null;
    const candidates = latest ? imageCandidates(latest) : [];
    const candidate = candidates[0] || null;
    return {
      active: false, stage: candidate || latest ? 'generating' : 'sending', requestFound: true,
      requestFingerprint: request.fingerprint, busy: generationBusy(), hasReply: !!latest,
      replyText: latest?.text || '', replyFingerprint: latest?.fingerprint || '',
      imageUrl: candidate?.imageUrl || '', imageFingerprint: candidate?.fingerprint || ''
    };
  }

  function handle(message, sender) {
    if (!message || message.type !== 'qd-ai-dola-command') return false;
    if (!globalThis.chrome?.runtime?.id || sender?.id !== chrome.runtime.id) return false;
    const taskId = String(message.taskId || '');
    if (!taskId) return false;
    if (message.action === 'readiness') {
      const input = findInput();
      return { ok: true, ready: !!input, auth: authRequiredPage() };
    }
    if (message.action === 'start') { start(taskId, String(message.prompt || ''), message.mode || 'image-edit', String(message.imageDataUrl || ''), Array.isArray(message.imageDataUrls) ? message.imageDataUrls : [], String(message.rawBridgeToken || '')).catch(error => { dispose(taskId); emit(taskId, 'needs-attention', { code: 'content-error', error: String(error?.message || 'Dola 页面处理失败。') }); }); return true; }
    if (message.action === 'resume') { try { resume(taskId, message.baselineHashes, message.requestFingerprint, message.deadlineAt, message.mode || 'image-edit', message.stage || 'generating', String(message.rawBridgeToken || '')); } catch (error) { dispose(taskId); emit(taskId, 'needs-attention', { code: 'content-error', error: String(error?.message || 'Dola 页面恢复失败。') }); } return true; }
    if (message.action === 'probe') return { ok: true, state: probeTask(taskId, message.mode || 'image-edit', message.renewUntil, message.baselineHashes, message.requestFingerprint) };
    if (message.action === 'stop') { dispose(taskId); return true; }
    if (message.action === 'ping') { emit(taskId, 'ready'); return true; }
    return false;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { handle, imageCandidates, imageCandidate, dedupeImageCandidates, imageSourceKey, findImageReply, hasCompletionEvidence, rawForAlias, dolaUrlKeys, acceptRawBridgeMessage, findAttachmentButton, findAttachmentInput, findOpenUploadMenuItem, openAttachmentInput, waitForAttachment, attachImagesDetailed, attachmentMarkers, attachmentPreviewImages, attachmentPreviewState, attachmentMarkerState, attachmentIsBusy, attachmentIsComplete, attachmentIsError, isLoadedAttachmentPreview, attachmentProgress, attachmentReadyEvidence, setInputValue, fillPrompt, realActivate, plusGlyphButton, isSendControl, iconOnlyNonSend, resultActionBarPresent, streamingBusyText, active, hash, visible, textOf, findInput, findSendButton, userMessages, assistantTurns, generationBusy, start, resume, probeTask, dispose };
  globalThis.chrome?.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
    const handled = handle(message, sender);
    if (!handled) return false;
    sendResponse?.(handled === true ? { ok: true } : handled);
    return false;
  });
})();
