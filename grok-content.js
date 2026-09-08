(() => {
  'use strict';

  if (globalThis.__quickdrawGrokContentLoaded) return;
  globalThis.__quickdrawGrokContentLoaded = true;

  const active = new Map();
  const HYDRATE_TIMEOUT = 120_000;
  const UPLOAD_INACTIVITY_TIMEOUT = 180_000;
  const SEND_TIMEOUT = 60_000;
  const REPLY_TIMEOUT = 1_200_000;
  const STABLE_WINDOW = 800;
  const PROMPT_FILL_ATTEMPTS = 4;
  const PROMPT_READBACK_TIMEOUT = 1_000;
  const INCOMPLETE_ATTACHMENT_TIMEOUT = 8_000;

  const visible = element => {
    if (!element || element.isConnected === false || element.hidden || element.disabled || element.getAttribute?.('aria-disabled') === 'true') return false;
    const style = globalThis.getComputedStyle?.(element);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    return !!(element.offsetParent || element.getClientRects?.().length);
  };

  const textOf = element => String(element?.innerText ?? element?.textContent ?? '').replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim();

  const isEditableElement = element => {
    const tag = String(element?.tagName || '').toLowerCase();
    const type = String(element?.type || '').toLowerCase();
    return tag === 'textarea' || (tag === 'input' && !/^(?:file|button|submit|image|checkbox|radio|password)$/i.test(type)) || element?.isContentEditable === true || element?.getAttribute?.('contenteditable') === 'true' || element?.getAttribute?.('role') === 'textbox';
  };

  function composerRoot(input = null) {
    if (!input) return document;
    try {
      const nearest = input.closest?.('form,[class*="composer" i],[class*="chat-input" i],[class*="input-area" i],[class*="footer" i]');
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
    for (const selector of ['button', 'svg', 'nav', 'details', '[aria-hidden="true"]', '[aria-label*="copy" i]', '[aria-label*="复制"]', '[data-testid*="copy" i]', '[data-testid*="thinking" i]', '[data-testid*="reason" i]', '[class*="thinking" i]', '[class*="reasoning" i]']) {
      copy.querySelectorAll?.(selector).forEach(node => node.remove());
    }
    // Detached elements have no rendered innerText. Preserve paragraph and <br>
    // boundaries explicitly before reading textContent (plain-text Grok replies).
    for (const pre of copy.querySelectorAll('pre')) {
      const code = pre.querySelector('code');
      const value = String((code || pre).textContent || '').trim();
      pre.replaceWith(document.createTextNode(`\n\x60\x60\x60mermaid\n${value}\n\x60\x60\x60\n`));
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

  function emitPhase(taskId, stage, data = {}) {
    emit(taskId, 'phase', { stage: String(stage || ''), ...data });
  }

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
    for (const root of query(['[data-testid*="chat-input" i]', '[data-testid*="prompt" i]', '[class*="chat-input" i]', '[class*="editor" i]']).reverse()) addRoot(root);
    for (const element of query(['textarea', 'input', '[contenteditable="true"]', '[role="textbox"]']).reverse()) addRoot(element);
    return candidates.filter(element => visible(element) && isEditableElement(element)).at(-1) || null;
  }

  function authRequiredPage() {
    let pathname = '';
    try { pathname = new URL(String(globalThis.location?.href || '')).pathname.toLowerCase(); } catch {}
    if (/\/(?:auth|login|log-in|signup|sign-up|registration|passport|account)(?:\/|$)/.test(pathname)) return true;
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
    const structural = output.replace(/[\u200b\u200c\u200d\ufeff]/g, '');
    return (structural || String(element.innerText || element.textContent || '').replace(/[\u200b\u200c\u200d\ufeff]/g, '')).trim();
  }

  function normalizePromptText(value) {
    return String(value ?? '').replace(/[\u200b\u200c\u200d\ufeff]/g, '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n+/g, '\n').trim();
  }

  function promptSemanticText(value) { return normalizePromptText(value).replace(/\s+/g, ' ').trim(); }

  function promptMatches(actual, expected) {
    const target = promptSemanticText(expected);
    return promptSemanticText(actual) === target;
  }

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
      '[data-testid="send-button"]',
      'button[data-testid*="send" i]',
      '[data-testid*="submit" i]',
      'button[class*="send" i]',
      'button[class*="submit" i]',
      'button[data-testid*="chat-input" i][data-testid*="button" i]',
      'button[type="submit"]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="发送"]',
      'button[title*="Send" i]',
      'button[title*="发送"]'
    ];
    for (const selector of selectors) {
      const button = [...document.querySelectorAll(selector)].reverse().find(visible);
      if (button) return button;
    }
    const input = findInput();
    const hasContent = !!inputText(input).trim() || Number(findAttachmentInput(input)?.files?.length || 0) > 0;
    if (!hasContent) return null;
    const root = composerRoot(input);
    const fallback = [...(root?.querySelectorAll?.('button,[role="button"]') || [])].filter(button => {
      if (!visible(button) || button.disabled || button.getAttribute?.('aria-disabled') === 'true') return false;
      const label = `${button.getAttribute?.('aria-label') || ''} ${button.getAttribute?.('title') || ''} ${button.getAttribute?.('data-icon') || ''} ${button.getAttribute?.('name') || ''} ${textOf(button)} ${button.className || ''} ${button.innerHTML || ''}`.toLowerCase();
      if (/解释图片|解释图像|explain\s*(image|picture)|attach|upload|image|photo|file|附件|上传|图片|文件|voice|microphone|语音|录音|麦克风/.test(label)) return false;
      return /send|submit|发送|提交|arrow[-_ ]?up|paper[-_ ]?plane|enter/.test(label) || (!textOf(button) && !!button.querySelector?.('svg') && !/plus|add|more|翻译|音乐|视频/.test(label));
    }).at(-1);
    if (fallback) return fallback;
    // Grok currently renders the composer send arrow with hashed classes and
    // an icon-only button. Its stable semantic label is often on a nested
    // SVG/path rather than the button itself, so inspect the complete local
    // markup after excluding attachment/voice controls above.
    const semantic = [...(root?.querySelectorAll?.('button,[role="button"]') || [])].filter(button => {
      if (!visible(button) || button.disabled || button.getAttribute?.('aria-disabled') === 'true') return false;
      const markup = `${button.outerHTML || ''} ${button.innerHTML || ''}`.toLowerCase();
      return /arrow[-_ ]?up|paper[-_ ]?plane|send|submit|发送|提交/.test(markup) && !/voice|microphone|语音|录音|attach|upload|附件|上传/.test(markup);
    }).at(-1);
    if (semantic) return semantic;
    return null;
  }

  const GROK_MESSAGE_SELECTORS = [
    '[data-message-id]',
    '[data-testid*="message" i]',
    '[data-testid*="conversation" i]',
    '[data-testid*="turn" i]',
    '[class*="message" i]',
    '[class*="conversation" i]',
    '[class*="turn" i]'
  ];
  const GROK_ASSISTANT_SELECTORS = [
    '[data-message-author-role="assistant"]',
    '[data-message-role="assistant"]',
    '[data-role="assistant"]',
    '[data-testid*="conversation-turn" i][data-turn="assistant"]',
    '[data-testid*="assistant" i]',
    '[class*="assistant" i]',
    '[class*="bot-message" i]',
    '[class*="ai-message" i]'
  ];
  const GROK_USER_SELECTORS = [
    '[data-message-author-role="user"]',
    '[data-message-role="user"]',
    '[data-role="user"]',
    '[data-testid*="conversation-turn" i][data-turn="user"]',
    '[data-testid*="user-message" i]',
    '[class*="user-message" i]',
    '[class*="human-message" i]'
  ];
  const COMPLETION_TEXT = /已完成图片生成|图片生成完成|图片已生成|生成了图片|generated\s+(?:an?\s+)?image|image\s+(?:has\s+been\s+)?generated/i;

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
    if (/(?:^|[\s_-])(user|human|用户)(?:$|[\s_-])/.test(`${value} ${classes}`)) return 'user';
    if (/(?:^|[\s_-])(assistant|bot|ai|Grok|助手)(?:$|[\s_-])/.test(`${value} ${classes}`)) return 'assistant';
    return '';
  }

  function isComposerElement(element) {
    if (!element) return false;
    const marker = `${element.getAttribute?.('data-testid') || ''} ${element.getAttribute?.('aria-label') || ''} ${element.className || ''}`.toLowerCase();
    return /composer|chat[-_ ]?input|prompt|editor|input[-_ ]?area|footer/.test(marker) || !!element.querySelector?.('textarea,input[contenteditable="true"],[role="textbox"]');
  }

  function allTaskTextElements(taskId) {
    const marker = String(taskId || '') ? taskMarkerPattern(taskId) : null;
    const candidates = queryAll([...GROK_USER_SELECTORS, ...GROK_MESSAGE_SELECTORS]);
    const matching = candidates.filter(element => visible(element) && !isComposerElement(element) && (marker ? marker.test(textOf(element)) : /任务编号\s*[:：]/.test(textOf(element))));
    if (matching.length) return matching;
    // Grok message wrappers have changed several times without retaining a
    // stable role/testid. Fall back to text-bearing nodes only when semantic
    // message selectors produced no anchor.
    try {
      return [...(document.querySelectorAll?.('body *') || [])].filter(element => visible(element) && !isComposerElement(element) && (marker ? marker.test(textOf(element)) : /任务编号\s*[:：]/.test(textOf(element))));
    } catch { return []; }
  }

  function chooseTaskAnchor(elements) {
    const values = [...new Set(elements || [])].filter(Boolean);
    if (!values.length) return null;
    // Prefer a semantic message wrapper. Otherwise use the smallest visible
    // text node wrapper; it still preserves document order for reply matching
    // and avoids selecting the entire conversation root.
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
    return queryAll(['button', '[role="button"]'], turn?.element || turn).some(control => {
      const label = `${control.getAttribute?.('aria-label') || ''} ${control.getAttribute?.('title') || ''} ${textOf(control)} ${control.className || ''}`.toLowerCase();
      return /download|下载|保存图片|复制图片|重新生成|regenerate/.test(label);
    });
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
    const selectors = [...GROK_ASSISTANT_SELECTORS, ...GROK_MESSAGE_SELECTORS];
    for (const element of queryAll(selectors)) {
      if (!visible(element) || seen.has(element) || isComposerElement(element)) continue;
      const role = roleOf(element);
      const raw = textOf(element);
      // A wrapper containing the task marker is a user request, even when the
      // site has no explicit role attribute. Keep it out of assistant output.
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
    const selectors = [...GROK_ASSISTANT_SELECTORS, ...GROK_MESSAGE_SELECTORS];
    for (const element of queryAll(selectors)) {
      if (!visible(element) || seen.has(element) || isComposerElement(element)) continue;
      const role = roleOf(element);
      const raw = textOf(element);
      if (role === 'user' || /任务编号\s*[:：]/.test(raw)) continue;
      const hasImage = !!element.querySelector?.('img');
      const text = extractAssistantText(element);
      if (!text && !hasImage) continue;
      seen.add(element); result.push({ element, text, fingerprint: hash(element.innerHTML || raw) });
    }
    // The result card visible in Grok has had no stable role/testid across
    // builds. Add its image card by semantic completion text/actions, while
    // retaining the message-selector path for GPT-shaped test fixtures.
    for (const image of queryAll(['img'])) {
      if (!visible(image)) continue;
      const card = imageCardFor(image);
      if (!card || seen.has(card) || isComposerElement(card) || roleOf(card) === 'user') continue;
      const text = textOf(card);
       if (/任务编号\s*[:：]/.test(text) || !hasCompletionEvidence({ element: card }, imageCandidate({ element: card }))) continue;
      seen.add(card);
      result.push({ element: card, text: extractAssistantText(card), fingerprint: hash(card.innerHTML || text) });
    }
    return result;
  }

  function imageCandidate(turn) {
    const element = turn?.element || turn;
    const images = String(element?.tagName || '').toLowerCase() === 'img' ? [element] : [...(element?.querySelectorAll?.('img') || [])];
    for (const image of images.reverse()) {
      const url = String(image.currentSrc || image.src || '').trim();
      if (!url || /^data:image\/svg|^about:blank/i.test(url)) continue;
      const marker = `${image.alt || ''} ${image.getAttribute?.('aria-label') || ''} ${image.className || ''} ${image.closest?.('button')?.getAttribute?.('aria-label') || ''}`.toLowerCase();
      if (/avatar|profile|logo|icon|favicon|placeholder|thumbnail|thumb|copy|download|user/.test(marker)) continue;
      if (/processing|loading|generating|error|failed|失败|处理中|加载中/.test(marker)) continue;
      const rect = image.getBoundingClientRect?.() || {};
      const width = Number(image.naturalWidth || image.width || rect.width || 0);
      const height = Number(image.naturalHeight || image.height || rect.height || 0);
      if (image.complete === false || (image.naturalWidth != null && image.naturalWidth <= 0)) continue;
      if ((width && width < 64) || (height && height < 64)) continue;
      return { image, imageUrl: url, width, height, fingerprint: hash(`${url}|${width}|${height}`) };
    }
    return null;
  }

  function findImageReply(record) {
    const users = userMessages();
    const request = taskRequest(record.taskId, record.requestFingerprint) || users.findLast(message => message.fingerprint === record.requestFingerprint || message.text.includes(`任务编号：${record.taskId}`));
    if (!request) return null;
    const currentTask = taskIdFromText(request.text) || String(record.taskId);
    const laterTask = users.findLast(message => {
      const candidateTask = taskIdFromText(message.text);
      return candidateTask && candidateTask !== currentTask && isAfter(request.element, message.element);
    });
    if (laterTask) throw new Error('Grok会话中出现了其他请求，已停止监听，避免取错回复。');
    const turns = assistantTurns().filter(message => {
      if (record.baselineElements?.has(message.element) && record.baselineTurnFingerprints?.get?.(message.element) === message.fingerprint) return false;
      if (!request.element?.compareDocumentPosition) return true;
      return !!(request.element.compareDocumentPosition(message.element) & 4);
    });
    for (const turn of turns.reverse()) {
      const candidate = imageCandidate(turn);
      if (candidate) return { ...turn, candidate };
    }
    return null;
  }

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
    for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024));
    }
    return `data:${type};base64,${btoa(binary)}`;
  }

  async function dataUrlToBlob(value) {
    const match = String(value || '').match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/i);
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
    for (const element of queryAll([...GROK_USER_SELECTORS, ...GROK_MESSAGE_SELECTORS])) {
      if (!visible(element) || seen.has(element) || isComposerElement(element)) continue;
      const role = roleOf(element);
      const text = textOf(element);
      if ((!text && !element.querySelector?.('img')) || (role !== 'user' && !/任务编号\s*[:：]/.test(text) && !(expectedText && promptMatches(text, expectedText)))) continue;
      // With hashed Grok wrappers, nested selectors can report the same
      // user bubble several times. Keep the most specific task/message node.
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

  function generationBusy() {
    const selectors = [
      '[data-testid*="stop"]',
      'button[aria-label*="Stop" i]',
      'button[aria-label*="停止"]',
      '[data-state="loading"]'
    ];
    return selectors.some(selector => [...document.querySelectorAll(selector)].some(visible));
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
  }

  function findReply(record) {
    const messages = assistantMessages();
    const users = userMessages();
    const request = taskRequest(record.taskId, record.requestFingerprint) || users.findLast(message => message.fingerprint === record.requestFingerprint || message.text.includes(`任务编号：${record.taskId}`));
    if (!request) return null;
    const laterTask = users.findLast(message => {
      const candidateTask = taskIdFromText(message.text);
      return candidateTask && candidateTask !== String(record.taskId) && isAfter(request.element, message.element);
    });
    if (laterTask) throw new Error('Grok会话中出现了其他请求，已停止监听，避免取错回复。');
    const fresh = messages.filter(message => {
      if (record.baselineElements?.has(message.element)) return false;
      if (!request.element?.compareDocumentPosition) return false;
      return !!(request.element.compareDocumentPosition(message.element) & 4);
    });
    if (!fresh.length) return null;
    return fresh.at(-1) || null;
  }

  function watchReply(record) {
    const taskId = record.taskId;
    record.stage = 'generating';
    if (record.phaseEvents) emitPhase(taskId, 'generating', { progress: 0 });
    const startedAt = Date.now();
    let last = '';
    let lastChangedAt = 0;
    let scheduled = false;
    const schedule = delay => {
      if (scheduled || !active.has(taskId)) return;
      scheduled = true;
      record.pollTimer = setTimeout(() => { scheduled = false; record.pollTimer = null; check(); }, delay);
    };
    const check = () => {
      if (!active.has(taskId)) return;
      if (record.mode === 'image-edit') { checkImage(); return; }
      let message;
      try { message = findReply(record); }
      catch (error) { dispose(taskId); emit(taskId, 'needs-attention', { error: error.message }); return; }
      const reply = message?.text || '';
      const busy = generationBusy();
      if (busy) record.sawBusy = true;
      if (reply && reply !== last) { last = reply; lastChangedAt = Date.now(); }
      const stableFor = lastChangedAt ? Date.now() - lastChangedAt : 0;
      const turn = message?.element.closest?.('article,[data-testid^="conversation-turn"],[data-message-id],[class*="message" i]') || message?.element;
      const completedControl = turn?.querySelector?.('button[data-testid="copy-turn-action-button"],button[data-testid="good-response-turn-action-button"],button[aria-label="Copy response"],button[aria-label="复制回复"]');
      const ended = visible(completedControl) || hasCompletionEvidence({ element: turn }, null) || (record.sawBusy && !!findSendButton());
      if (message && reply && stableFor >= STABLE_WINDOW && !busy && ended) {
        if (record.phaseEvents) emitPhase(taskId, 'returning', { progress: 0 });
        dispose(taskId);
        emit(taskId, 'reply', { text: reply, phase: 'complete', fingerprint: message.fingerprint });
        return;
      }
      if (Date.now() - startedAt >= REPLY_TIMEOUT || (record.deadlineAt && Date.now() >= record.deadlineAt)) {
        dispose(taskId);
        emit(taskId, 'needs-attention', { code: 'reply-timeout', error: 'Grok回复超时，未自动重发。' });
        return;
      }
      schedule(generationBusy() ? 450 : 700);
    };
    schedule(350);
    record.observer = new MutationObserver(() => schedule(180));
    if (document.body) record.observer.observe(document.body, { subtree: true, childList: true, characterData: true });

    async function checkImage() {
      if (!active.has(taskId)) return;
      let message;
      try { message = findImageReply(record); }
      catch (error) { dispose(taskId); emit(taskId, 'needs-attention', { error: error.message }); return; }
      const candidate = message?.candidate;
      const busy = generationBusy();
      if (busy) record.sawBusy = true;
      const key = candidate?.fingerprint || '';
      if (key && key !== record.lastImageKey) { record.lastImageKey = key; record.lastImageChangedAt = Date.now(); }
      const stableFor = record.lastImageChangedAt ? Date.now() - record.lastImageChangedAt : 0;
      const turn = message?.element.closest?.('article,[data-testid^="conversation-turn"],[data-message-id],[class*="message" i]') || message?.element;
       const ended = hasCompletionEvidence({ element: turn }, candidate);
      if (candidate && stableFor >= STABLE_WINDOW && !busy && ended) {
        if (record.phaseEvents) emitPhase(taskId, 'returning', { progress: 0 });
        const imageBlob = await fetchCandidateBlob(candidate);
        const imageDataUrl = imageBlob ? await blobToDataUrl(imageBlob) : '';
        if (!active.has(taskId)) return;
        dispose(taskId);
        emit(taskId, 'image-reply', { phase: 'complete', imageUrl: candidate.imageUrl, imageDataUrl, fingerprint: key, imageWidth: candidate.width, imageHeight: candidate.height });
        return;
      }
      if (Date.now() - startedAt >= REPLY_TIMEOUT || (record.deadlineAt && Date.now() >= record.deadlineAt)) {
        dispose(taskId); emit(taskId, 'needs-attention', { code: 'reply-timeout', error: 'Grok回复超时，未自动重发。' }); return;
      }
      schedule(generationBusy() ? 450 : 700);
    }
  }

  function findAttachmentInput(anchor = null) {
    const root = anchor ? composerRoot(anchor) : null;
    const scoped = [...(root?.querySelectorAll?.('input[type="file"]') || [])];
    const all = [...(document.querySelectorAll?.('input[type="file"]') || [])];
    const candidates = scoped.length ? scoped : all;
    return candidates.reverse().find(element => element && element.isConnected !== false && !element.disabled) || null;
  }

  function findAttachmentButton(anchor = null, clicked = new Set()) {
    const root = anchor ? composerRoot(anchor) : document;
    const scoped = [...(root?.querySelectorAll?.('button,[role="button"]') || [])];
    const candidates = scoped.length ? scoped : [...(document.querySelectorAll?.('button,[role="button"]') || [])];
    const usable = candidates.filter(element => visible(element) && !element.disabled && !clicked.has(element));
    const description = element => `${element.getAttribute?.('aria-label') || ''} ${element.getAttribute?.('title') || ''} ${textOf(element)} ${element.className || ''} ${element.outerHTML || ''}`.toLowerCase();
    return usable.find(element => /attach|upload|add (?:file|photo|image)|image upload|paperclip|附件|上传|添加图片|选择图片|本地图片|文件/.test(description(element)))
      || usable.find(element => /^\s*\+\s*$/.test(textOf(element)) || /aria-label=["'][^"']*(?:add|plus|more)[^"']*["']|data-icon=["']plus["']|icon-plus|lucide-plus/.test(description(element)))
      || null;
  }

  async function openAttachmentInput(anchor, timeout = 10_000) {
    const clicked = new Set(); const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      const input = findAttachmentInput(anchor); if (input) return input;
      const button = findAttachmentButton(anchor, clicked);
      if (button) { clicked.add(button); button.click(); }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    return null;
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
    return !!image && image.complete !== false && Number(image.naturalWidth || 0) > 0 && Number(image.naturalHeight || 0) > 0 &&
      !/^data:image\/svg|^about:blank/i.test(String(image.currentSrc || image.src || ''));
  }

  function findFreshAttachmentPreview(previews, baselinePreviews) {
    return (previews || []).find(image => !baselinePreviews?.has(image) || baselinePreviews.get(image) !== attachmentPreviewState(image)) || null;
  }

  function attachmentReadyEvidence(marker, preview, sendReady) {
    if (!sendReady || (marker && (attachmentIsBusy(marker) || attachmentIsError(marker)))) return false;
    return !!((marker && attachmentIsComplete(marker)) || isLoadedAttachmentPreview(preview));
  }

  function attachmentMarkerState(element) {
    const attrs = ['data-state', 'aria-busy', 'aria-valuenow', 'aria-valuemax', 'role', 'title', 'aria-label'];
    const values = attrs.map(name => `${name}:${element?.getAttribute?.(name) || ''}`).join('|');
    return `${values}|class:${element?.className || ''}|text:${textOf(element).slice(0, 300)}`;
  }

  function attachmentProgress(element) {
    const ariaNow = Number(element?.getAttribute?.('aria-valuenow'));
    if (Number.isFinite(ariaNow) && (element?.getAttribute?.('role') === 'progressbar' || element?.getAttribute?.('aria-valuemax'))) return Math.max(0, Math.min(100, ariaNow));
    const source = [
      element?.getAttribute?.('aria-valuenow'),
      element?.getAttribute?.('data-progress'),
      element?.getAttribute?.('value'),
      textOf(element)
    ].filter(Boolean).join(' ');
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

  function uploadHasStalled(lastProgressAt, now = Date.now()) {
    return now - Number(lastProgressAt || 0) >= UPLOAD_INACTIVITY_TIMEOUT;
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
      if (progress >= 0 && progress !== emittedProgress) {
        emittedProgress = progress;
        emitPhase(taskId, 'uploading', { progress: progress / 100 });
      }
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
      if (uploadHasStalled(lastActivityAt)) return options.details ? { ok: false, code: 'stalled', ...lastState } : false;
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

  async function attachImages(blobs, taskId = '') { return (await attachImagesDetailed(blobs, taskId)).ok; }

  async function attachImage(blob, taskId = '') { return attachImages(blob ? [blob] : [], taskId); }

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
      // Uploads and controlled rich editors can replace the node after the
      // input event. The next bounded attempt deliberately re-queries it;
      // attachments are already ready and are never uploaded again here.
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    return { ok: false, code: attempted ? 'readback-mismatch' : 'input-unavailable', attempted, observed };
  }

  async function start(taskId, prompt, mode = 'mindmap', imageDataUrl = '', imageDataUrls = []) {
    if (active.size) {
      emit(taskId, 'needs-attention', { code: 'busy', error: 'Grok专用标签页正在处理其他任务。' });
      return;
    }
    const reservation = { taskId, mode, stage: 'hydrating', deadlineAt: 0 };
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
      emit(taskId, 'needs-attention', { code: 'auth-required', error: 'Grok页面需要登录或完成验证，任务已暂停。请完成后点击“继续任务”。' });
      return;
    }
    const input = hydrated?.input || null;
    if (!input) {
      dispose(taskId);
      emit(taskId, 'needs-attention', { code: 'not-ready', error: '未找到Grok输入框，请先等待页面加载完成。' });
      return;
    }
    if (generationBusy()) { dispose(taskId); emit(taskId, 'needs-attention', { error: 'Grok正在生成其他回复，未发送新需求。' }); return; }
    const imageValues = mode === 'image-edit' ? (Array.isArray(imageDataUrls) && imageDataUrls.length ? imageDataUrls : (imageDataUrl ? [imageDataUrl] : [])) : [];
    reservation.stage = mode === 'image-edit' && imageValues.length ? 'uploading' : 'sending';
    const imageBlobs = mode === 'image-edit' ? (await Promise.all(imageValues.map(value => dataUrlToBlob(value)))).filter(Boolean) : [];
    if (mode === 'image-edit' && imageValues.length) {
      const upload = imageBlobs.length === imageValues.length && imageBlobs.length ? await attachImagesDetailed(imageBlobs, taskId) : { ok: false, code: 'invalid-image-data', expectedCount: imageValues.length, readyCount: 0, previewCount: 0, markerCount: 0, inputFileCount: 0 };
      if (!upload.ok) {
        dispose(taskId);
        const count = Number(upload.readyCount || 0), expected = Number(upload.expectedCount || imageValues.length || 0);
        const detail = upload.code === 'incomplete' && expected > 1 ? `Grok只确认了 ${count}/${expected} 张图片同时就绪，未发送需求。` : '图片上传失败或长时间没有可验证进展，未发送需求。';
        emit(taskId, 'needs-attention', { code: 'image-upload-failed', stage: 'uploading', expectedImageCount: expected, readyImageCount: count, error: detail });
        return;
      }
    }
    const baseline = mode === 'image-edit' ? assistantTurns() : assistantMessages();
    const baselineHashes = baseline.map(message => message.fingerprint);
    const baselineElements = new Set(baseline.map(message => message.element));
    const baselineUsers = userMessages(prompt);
    const baselineUserElements = new Set(baselineUsers.map(message => message.element));
    const baselineUserHashes = new Set(baselineUsers.map(message => message.fingerprint));
    const baselineTurnFingerprints = new Map(baseline.map(message => [message.element, message.fingerprint]));
    const record = { taskId, mode, stage: 'sending', phaseEvents: true, baselineHashes, baselineElements, baselineTurnFingerprints, baselineUserElements, baselineUserHashes, observer: null, timeout: null, pollTimer: null, stabilityTimer: null, sawBusy: false, lastImageKey: '', lastImageChangedAt: 0 };
    active.set(taskId, record);
    emit(taskId, 'ready');
    emitPhase(taskId, 'sending', { progress: 0 });
    const filled = await fillPrompt(taskId, prompt);
    if (active.get(taskId) !== record) return;
    if (!filled.ok) {
      dispose(taskId);
      const error = filled.code === 'input-unavailable' ? '未找到可用的Grok编辑器，未写入或发送内容。' : 'Grok编辑器写入后完整需求回读校验未通过，未发送内容。';
      emit(taskId, 'needs-attention', { code: filled.code === 'input-unavailable' ? 'prompt-input-unavailable' : 'prompt-readback-failed', stage: 'sending', error });
      return;
    }
    const send = await waitUntil(() => findSendButton(), 3_000).then(found => found ? findSendButton() : null);
    if (active.get(taskId) !== record) return;
    if (!send) {
      dispose(taskId);
      emit(taskId, 'needs-attention', { code: 'send-control-not-found', error: '未找到Grok发送控件，未发送内容。' });
      return;
    }
    send.click();
    const confirmedMessage = await waitUntil(() => {
      if (generationBusy()) record.sawBusy = true;
      return userMessages(prompt).find(message => !record.baselineUserElements.has(message.element) && (prompt.trim() ? promptMatches(message.text, prompt) : !!message.element.querySelector?.('img'))) || null;
    }, SEND_TIMEOUT);
    if (active.get(taskId) !== record) return;
    if (!confirmedMessage) {
      dispose(taskId);
      emit(taskId, 'needs-attention', { code: 'send-uncertain', error: '无法确认Grok是否已发送，未自动重试。' });
      return;
    }
    record.baselineHashes = baselineHashes;
    record.requestFingerprint = confirmedMessage?.fingerprint || '';
    record.stage = 'generating';
    emit(taskId, 'send-confirmed', { baselineHashes, requestFingerprint: record.requestFingerprint });
    watchReply(record);
  }

  async function resumeSending(record) {
    const found = await waitUntil(() => {
      const request = taskRequest(record.taskId, record.requestFingerprint);
      if (request) return request;
      return null;
    }, Math.max(1_000, Math.min(SEND_TIMEOUT, Number(record.deadlineAt || 0) - Date.now())));
    if (!active.has(record.taskId)) return;
    if (!found) {
      dispose(record.taskId);
      emit(record.taskId, 'needs-attention', { code: 'send-uncertain', error: '恢复后无法确认Grok是否已发送，未自动重试。' });
      return;
    }
    record.requestFingerprint = found.fingerprint;
    emitPhase(record.taskId, 'sending', { progress: 1 });
    emit(record.taskId, 'send-confirmed', { baselineHashes: record.baselineHashes || [], requestFingerprint: record.requestFingerprint });
    watchReply(record);
  }

  function resume(taskId, baselineHashes, requestFingerprint, deadlineAt, mode = 'mindmap', stage = 'generating') {
    if (active.has(taskId)) return;
    if (active.size) throw new Error('无法确认原请求，未自动重发。');
    if (stage !== 'sending' && !requestFingerprint) throw new Error('无法确认原请求，未自动重发。');
    const record = { taskId, mode, phaseEvents: true, stage, requestFingerprint: String(requestFingerprint || ''), deadlineAt, baselineHashes: Array.isArray(baselineHashes) ? baselineHashes : [], baselineElements: new Set(), observer: null, timeout: null, pollTimer: null, stabilityTimer: null, sawBusy: false, lastImageKey: '', lastImageChangedAt: 0 };
    active.set(taskId, record);
    emit(taskId, 'resumed');
    const resumeStage = ['sending', 'generating', 'returning'].includes(stage) ? stage : 'generating';
    emitPhase(taskId, resumeStage, { progress: 0 });
    if (stage === 'sending') resumeSending(record).catch(error => { dispose(taskId); emit(taskId, 'needs-attention', { code: 'content-error', error: String(error?.message || 'Grok页面恢复失败。') }); });
    else watchReply(record);
  }

  function probeTask(taskId, mode = 'mindmap', renewUntil = 0, baselineHashes = [], requestFingerprint = '') {
    const record = active.get(taskId);
    if (record) {
      if (Number(renewUntil) > Date.now()) record.deadlineAt = Number(renewUntil);
      return { active: true, stage: record.stage || 'generating', requestFound: !!record.requestFingerprint, requestFingerprint: record.requestFingerprint || '' };
    }
    const users = userMessages();
    const request = taskRequest(taskId, requestFingerprint) || users.findLast(message => message.fingerprint === String(requestFingerprint || '') || message.text.includes(`任务编号：${taskId}`));
    if (!request) return { active: false, requestFound: false, busy: generationBusy() };
    const baseline = new Set(Array.isArray(baselineHashes) ? baselineHashes.map(String) : []);
    const fresh = (mode === 'image-edit' ? assistantTurns() : assistantMessages()).filter(message => {
      if (baseline.has(message.fingerprint)) return false;
      if (!request.element?.compareDocumentPosition) return true;
      return !!(request.element.compareDocumentPosition(message.element) & 4);
    });
    const latest = fresh.at(-1) || null;
    const candidate = mode === 'image-edit' ? imageCandidate(latest) : null;
    return {
      active: false, stage: candidate || latest ? 'generating' : 'sending', requestFound: true,
      requestFingerprint: request.fingerprint, busy: generationBusy(), hasReply: !!latest,
      replyText: latest?.text || '', replyFingerprint: latest?.fingerprint || '',
      imageUrl: candidate?.imageUrl || '', imageFingerprint: candidate?.fingerprint || ''
    };
  }

  function handle(message, sender) {
    if (!message || message.type !== 'qd-ai-grok-command') return false;
    if (!globalThis.chrome?.runtime?.id || sender?.id !== chrome.runtime.id) return false;
    const taskId = String(message.taskId || '');
    if (!taskId) return false;
    if (message.action === 'readiness') {
      const input = findInput();
      return { ok: true, ready: !!input, auth: authRequiredPage() };
    }
    if (message.action === 'start') { start(taskId, String(message.prompt || ''), message.mode || 'mindmap', String(message.imageDataUrl || ''), Array.isArray(message.imageDataUrls) ? message.imageDataUrls : []).catch(error => { dispose(taskId); emit(taskId, 'needs-attention', { code: 'content-error', error: String(error?.message || 'Grok页面处理失败。') }); }); return true; }
    if (message.action === 'resume') { try { resume(taskId, message.baselineHashes, message.requestFingerprint, message.deadlineAt, message.mode || 'mindmap', message.stage || 'generating'); } catch (error) { dispose(taskId); emit(taskId, 'needs-attention', { code: 'content-error', error: String(error?.message || 'Grok页面恢复失败。') }); } return true; }
    if (message.action === 'probe') return { ok: true, state: probeTask(taskId, message.mode || 'mindmap', message.renewUntil, message.baselineHashes, message.requestFingerprint) };
    if (message.action === 'stop') { dispose(taskId); return true; }
    if (message.action === 'ping') { emit(taskId, 'ready'); return true; }
    return false;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { handle, extractAssistantText, watchReply, resume, start, probeTask, attachImage, attachImages, attachImagesDetailed, findAttachmentButton, openAttachmentInput, fillPrompt, findInput, inputText, editableText, normalizePromptText, promptSemanticText, promptMatches, setInputValue, waitForAttachment, uploadHasStalled, active, hash, assistantMessages, assistantTurns, userMessages, taskRequest, imageCandidate, findImageReply, hasCompletionEvidence, generationBusy, attachmentMarkers, attachmentPreviewImages, attachmentPreviewState, isLoadedAttachmentPreview, findFreshAttachmentPreview, attachmentReadyEvidence, attachmentProgress, attachmentIsComplete, attachmentIsError };
  globalThis.chrome?.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
    const handled = handle(message, sender);
    if (!handled) return false;
    sendResponse?.(handled === true ? { ok: true } : handled);
    return false;
  });
})();

