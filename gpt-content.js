(() => {
  'use strict';

  if (globalThis.__quickdrawGPTContentLoaded) return;
  globalThis.__quickdrawGPTContentLoaded = true;

  const active = new Map();
  const HYDRATE_TIMEOUT = 120_000;
  const UPLOAD_INACTIVITY_TIMEOUT = 180_000;
  const SEND_TIMEOUT = 60_000;
  const REPLY_TIMEOUT = 1_200_000;
  const STABLE_WINDOW = 800;

  const visible = element => {
    if (!element || element.hidden || element.disabled || element.getAttribute?.('aria-disabled') === 'true') return false;
    const style = globalThis.getComputedStyle?.(element);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    return !!(element.offsetParent || element.getClientRects?.().length);
  };

  const textOf = element => String(element?.innerText ?? element?.textContent ?? '').replace(/\u200b/g, '').trim();

  function extractAssistantText(element) {
    const copy = element.cloneNode?.(true);
    if (!copy) return '';
    for (const selector of ['button', 'svg', 'nav', 'details', '[aria-hidden="true"]', '[aria-label*="copy" i]', '[aria-label*="复制"]', '[data-testid*="copy" i]', '[data-testid*="thinking" i]', '[data-testid*="reason" i]', '[class*="thinking" i]', '[class*="reasoning" i]']) {
      copy.querySelectorAll?.(selector).forEach(node => node.remove());
    }
    // Detached elements have no rendered innerText. Preserve paragraph and <br>
    // boundaries explicitly before reading textContent (plain-text GPT replies).
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
    const primary = document.querySelector('#prompt-textarea');
    if (visible(primary)) return primary;
    const candidates = [
      ...document.querySelectorAll('textarea'),
      ...document.querySelectorAll('[contenteditable="true"]'),
      ...document.querySelectorAll('[role="textbox"]')
    ];
    return candidates.reverse().find(visible) || null;
  }

  function authRequiredPage() {
    let pathname = '';
    try { pathname = new URL(String(globalThis.location?.href || '')).pathname.toLowerCase(); } catch {}
    if (/\/(?:auth|login|log-in|signup|sign-up|registration)(?:\/|$)/.test(pathname)) return true;
    const password = [...document.querySelectorAll('input[type="password"]')].find(visible);
    const challenge = [...document.querySelectorAll('iframe[src*="challenges.cloudflare.com"],iframe[src*="captcha" i],[data-testid*="challenge" i],[data-testid*="captcha" i]')].find(visible);
    if (challenge) return true;
    if (!password) return false;
    const controls = [...document.querySelectorAll('button,a,[role="button"]')].filter(visible);
    const labels = controls.map(element => `${element.getAttribute?.('aria-label') || ''} ${element.getAttribute?.('title') || ''} ${textOf(element)}`).join(' ').toLowerCase();
    return /log\s*in|sign\s*up|continue|登录|注册|继续|验证|verify/.test(labels);
  }

  function inputText(element) {
    if (!element) return '';
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return String(element.value || '');
    return textOf(element);
  }

  function setInputValue(element, value) {
    element.focus();
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
      descriptor?.set?.call(element, value);
      if (!descriptor?.set) element.value = value;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      return;
    }
    let inserted = false;
    try {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      inserted = document.execCommand('insertText', false, value);
    } catch {}
    if (!inserted) {
      element.textContent = value;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    }
  }

  function findSendButton() {
    const selectors = [
      '[data-testid="send-button"]',
      'button[data-testid*="send"]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="发送"]',
      'button[title*="Send" i]',
      'button[title*="发送"]'
    ];
    for (const selector of selectors) {
      const button = [...document.querySelectorAll(selector)].reverse().find(visible);
      if (button) return button;
    }
    return null;
  }

  function assistantMessages() {
    const result = [];
    const seen = new Set();
    const selectors = [
      '[data-message-author-role="assistant"]',
      '[data-testid*="conversation-turn"][data-turn="assistant"]',
      'article[data-message-author-role="assistant"]'
    ];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!visible(element) || seen.has(element)) continue;
        const text = extractAssistantText(element);
        if (!text) continue;
        seen.add(element);
        result.push({ element, text, fingerprint: hash(text) });
      }
    }
    return result;
  }

  function assistantTurns() {
    const result = [];
    const seen = new Set();
    const selectors = [
      '[data-message-author-role="assistant"]',
      '[data-testid*="conversation-turn"][data-turn="assistant"]',
      'article[data-message-author-role="assistant"]'
    ];
    for (const selector of selectors) for (const element of document.querySelectorAll(selector)) {
      if (!visible(element) || seen.has(element)) continue;
      seen.add(element); result.push({ element, fingerprint: hash(element.innerHTML || textOf(element)) });
    }
    return result;
  }

  function imageCandidate(turn) {
    const images = [...(turn?.element?.querySelectorAll?.('img') || [])];
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
    const request = users.findLast(message => message.fingerprint === record.requestFingerprint || message.text.includes(`任务编号：${record.taskId}`));
    if (!request) return null;
    if (users.at(-1)?.fingerprint !== request.fingerprint && users.at(-1)?.text?.includes(`任务编号：${record.taskId}`) === false) throw new Error('GPT 会话中出现了其他请求，已停止监听，避免取错回复。');
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

  function userMessages() {
    const result = [];
    const seen = new Set();
    for (const selector of ['[data-message-author-role="user"]', '[data-testid*="conversation-turn"][data-turn="user"]']) {
      for (const element of document.querySelectorAll(selector)) {
        if (!visible(element) || seen.has(element)) continue;
        const text = textOf(element);
        if (text) { seen.add(element); result.push({ element, text, fingerprint: hash(text) }); }
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
    const request = users.findLast(message => message.fingerprint === record.requestFingerprint);
    if (!request) return null;
    if (users.at(-1)?.fingerprint !== record.requestFingerprint) throw new Error('GPT 会话中出现了其他请求，已停止监听，避免取错回复。');
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
      const turn = message?.element.closest('article,[data-testid^="conversation-turn"]') || message?.element;
      const completedControl = turn?.querySelector('button[data-testid="copy-turn-action-button"],button[data-testid="good-response-turn-action-button"],button[aria-label="Copy response"],button[aria-label="复制回复"]');
      const ended = visible(completedControl) || (record.sawBusy && !!findSendButton());
      if (message && reply && stableFor >= STABLE_WINDOW && !busy && ended) {
        if (record.phaseEvents) emitPhase(taskId, 'returning', { progress: 0 });
        dispose(taskId);
        emit(taskId, 'reply', { text: reply, phase: 'complete', fingerprint: message.fingerprint });
        return;
      }
      if (Date.now() - startedAt >= REPLY_TIMEOUT || (record.deadlineAt && Date.now() >= record.deadlineAt)) {
        dispose(taskId);
        emit(taskId, 'needs-attention', { code: 'reply-timeout', error: 'GPT 回复超时，未自动重发。' });
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
      const turn = message?.element.closest?.('article,[data-testid^="conversation-turn"]') || message?.element;
      const completedControl = turn?.querySelector?.('button[data-testid="copy-turn-action-button"],button[data-testid="good-response-turn-action-button"],button[aria-label="Copy response"],button[aria-label="复制回复"]');
      const ended = visible(completedControl) || (record.sawBusy && !!findSendButton());
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
        dispose(taskId); emit(taskId, 'needs-attention', { code: 'reply-timeout', error: 'GPT 回复超时，未自动重发。' }); return;
      }
      schedule(generationBusy() ? 450 : 700);
    }
  }

  function findAttachmentInput() { return document.querySelector('input[type="file"]'); }

  function attachmentMarkers() {
    const selectors = '[data-testid*="attachment" i],[aria-label*="attachment" i],[class*="attachment" i],[data-testid*="upload" i],[class*="upload" i]';
    return [...document.querySelectorAll(selectors)].filter(visible);
  }

  function attachmentPreviewImages(input) {
    const root = input?.closest?.('form') || input?.parentElement?.parentElement || document;
    return [...(root?.querySelectorAll?.('img') || [])].filter(image => {
      const marker = `${image.alt || ''} ${image.getAttribute?.('aria-label') || ''} ${image.className || ''}`.toLowerCase();
      return visible(image) && !/avatar|profile|logo|icon|emoji/.test(marker);
    });
  }

  function attachmentPreviewState(image) {
    return `${image?.currentSrc || image?.src || image?.getAttribute?.('src') || ''}|${Number(image?.naturalWidth || 0)}x${Number(image?.naturalHeight || 0)}|${image?.complete === false ? 'loading' : 'complete'}`;
  }

  function isLoadedAttachmentPreview(image) {
    return !!image && image.complete !== false && Number(image.naturalWidth || 0) >= 64 && Number(image.naturalHeight || 0) >= 64 &&
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

  async function waitForAttachment(taskId, input, baselineMarkers, baselinePreviews = new Map(), expectedCount = 1) {
    let lastActivityAt = Date.now();
    let targetMarker = null;
    let lastProgress = -1;
    let emittedProgress = -1;
    let lastBusy = false;
    let readySince = 0;
    while (active.has(taskId)) {
      const markers = attachmentMarkers();
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
      if (targetMarker && attachmentIsError(targetMarker)) return false;
      const previews = attachmentPreviewImages(input);
      const freshPreviews = previews.filter(image => !baselinePreviews.has(image) || baselinePreviews.get(image) !== attachmentPreviewState(image));
      const freshMarkers = markers.filter(element => !baselineMarkers.has(element) || baselineMarkers.get(element) !== attachmentMarkerState(element));
      const sendReady = !!findSendButton();
      const completePreviews = freshPreviews.filter(isLoadedAttachmentPreview).length;
      const completeMarkers = freshMarkers.filter(attachmentIsComplete).length;
      const readyCount = Math.max(completePreviews, completeMarkers, attachmentReadyEvidence(targetMarker, freshPreviews[0], sendReady) ? 1 : 0);
      if (sendReady && readyCount >= expectedCount && !freshMarkers.some(attachmentIsBusy) && !freshMarkers.some(attachmentIsError)) {
        if (!readySince) readySince = Date.now();
        if (Date.now() - readySince >= 800) return true;
      } else readySince = 0;
      if (uploadHasStalled(lastActivityAt)) return false;
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    return false;
  }

  async function attachImages(blobs, taskId = '') {
    const values = (blobs || []).filter(Boolean);
    if (!values.length) return true;
    emitPhase(taskId, 'uploading', { progress: 0 });
    const baselineMarkers = new Map(attachmentMarkers().map(element => [element, attachmentMarkerState(element)]));
    const baselinePreviews = new Map(attachmentPreviewImages(null).map(image => [image, attachmentPreviewState(image)]));
    let input = findAttachmentInput();
    if (!input) {
      const button = [...document.querySelectorAll('button,[role="button"]')].find(element => {
        const label = `${element.getAttribute?.('aria-label') || ''} ${element.getAttribute?.('title') || ''} ${element.textContent || ''}`.toLowerCase();
        return /attach|upload|image|photo|附件|上传|图片/.test(label) && visible(element);
      });
      button?.click();
      input = await waitUntil(() => findAttachmentInput(), 10_000);
    }
    if (!input || typeof DataTransfer === 'undefined') return false;
    try {
      const transfer = new DataTransfer();
      values.forEach((blob, index) => {
        const file = typeof File !== 'undefined' ? new File([blob], `quickdraw-source-${String(index + 1).padStart(2, '0')}.png`, { type: blob.type || 'image/png' }) : blob;
        transfer.items.add(file);
      });
      input.files = transfer.files;
      if (Number(input.files?.length || 0) !== values.length) return false;
      input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
      return await waitForAttachment(taskId, input, baselineMarkers, baselinePreviews, values.length);
    } catch { return false; }
  }

  async function attachImage(blob, taskId = '') { return attachImages(blob ? [blob] : [], taskId); }

  async function start(taskId, prompt, mode = 'mindmap', imageDataUrl = '', imageDataUrls = []) {
    if (active.size) {
      emit(taskId, 'needs-attention', { code: 'busy', error: 'GPT 专用标签页正在处理其他任务。' });
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
      emit(taskId, 'needs-attention', { code: 'auth-required', error: 'GPT 页面需要登录或完成验证，任务已暂停。请完成后点击“继续任务”。' });
      return;
    }
    const input = hydrated?.input || null;
    if (!input) {
      dispose(taskId);
      emit(taskId, 'needs-attention', { code: 'not-ready', error: '未找到 GPT 输入框，请先等待页面加载完成。' });
      return;
    }
    if (generationBusy()) { dispose(taskId); emit(taskId, 'needs-attention', { error: 'GPT 正在生成其他回复，未发送新需求。' }); return; }
    const imageValues = mode === 'image-edit' ? (Array.isArray(imageDataUrls) && imageDataUrls.length ? imageDataUrls : (imageDataUrl ? [imageDataUrl] : [])) : [];
    reservation.stage = mode === 'image-edit' && imageValues.length ? 'uploading' : 'sending';
    const imageBlobs = mode === 'image-edit' ? (await Promise.all(imageValues.map(value => dataUrlToBlob(value)))).filter(Boolean) : [];
    if (mode === 'image-edit' && imageValues.length && (imageBlobs.length !== imageValues.length || !imageBlobs.length || !(await attachImages(imageBlobs, taskId)))) { dispose(taskId); emit(taskId, 'needs-attention', { code: 'image-upload-failed', error: '图片上传失败或长时间没有可验证进展，未发送需求。' }); return; }
    const baseline = mode === 'image-edit' ? assistantTurns() : assistantMessages();
    const baselineHashes = baseline.map(message => message.fingerprint);
    const baselineElements = new Set(baseline.map(message => message.element));
    const baselineUsers = userMessages();
    const baselineUserElements = new Set(baselineUsers.map(message => message.element));
    const baselineUserHashes = new Set(baselineUsers.map(message => message.fingerprint));
    const baselineTurnFingerprints = new Map(baseline.map(message => [message.element, message.fingerprint]));
    const record = { taskId, mode, stage: 'sending', phaseEvents: true, baselineHashes, baselineElements, baselineTurnFingerprints, baselineUserElements, baselineUserHashes, observer: null, timeout: null, pollTimer: null, stabilityTimer: null, sawBusy: false, lastImageKey: '', lastImageChangedAt: 0 };
    active.set(taskId, record);
    emit(taskId, 'ready');
    emitPhase(taskId, 'sending', { progress: 0 });
    setInputValue(input, prompt);
    const send = await waitUntil(() => findSendButton(), 3_000).then(found => found ? findSendButton() : null);
    if (active.get(taskId) !== record) return;
    if (!send) {
      dispose(taskId);
      emit(taskId, 'needs-attention', { code: 'send-control-not-found', error: '未找到 GPT 发送控件，未发送内容。' });
      return;
    }
    send.click();
    const confirmedMessage = await waitUntil(() => {
      const users = userMessages();
      if (generationBusy()) record.sawBusy = true;
      return users.find(message => message.text.includes(`任务编号：${taskId}`) && !record.baselineUserElements.has(message.element)) || null;
    }, SEND_TIMEOUT);
    if (active.get(taskId) !== record) return;
    if (!confirmedMessage) {
      dispose(taskId);
      emit(taskId, 'needs-attention', { code: 'send-uncertain', error: '无法确认 GPT 是否已发送，未自动重试。' });
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
      const users = userMessages();
      const request = users.find(message => message.text.includes(`任务编号：${record.taskId}`));
      if (request) return request;
      return null;
    }, Math.max(1_000, Math.min(SEND_TIMEOUT, Number(record.deadlineAt || 0) - Date.now())));
    if (!active.has(record.taskId)) return;
    if (!found) {
      dispose(record.taskId);
      emit(record.taskId, 'needs-attention', { code: 'send-uncertain', error: '恢复后无法确认 GPT 是否已发送，未自动重试。' });
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
    if (stage === 'sending') resumeSending(record).catch(error => { dispose(taskId); emit(taskId, 'needs-attention', { code: 'content-error', error: String(error?.message || 'GPT 页面恢复失败。') }); });
    else watchReply(record);
  }

  function probeTask(taskId, mode = 'mindmap', renewUntil = 0, baselineHashes = [], requestFingerprint = '') {
    const record = active.get(taskId);
    if (record) {
      if (Number(renewUntil) > Date.now()) record.deadlineAt = Number(renewUntil);
      return { active: true, stage: record.stage || 'generating', requestFound: !!record.requestFingerprint, requestFingerprint: record.requestFingerprint || '' };
    }
    const users = userMessages();
    const request = users.findLast(message => message.fingerprint === String(requestFingerprint || '') || message.text.includes(`任务编号：${taskId}`));
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
    if (!message || message.type !== 'qd-ai-gpt-command') return false;
    if (!globalThis.chrome?.runtime?.id || sender?.id !== chrome.runtime.id) return false;
    const taskId = String(message.taskId || '');
    if (!taskId) return false;
    if (message.action === 'start') { start(taskId, String(message.prompt || ''), message.mode || 'mindmap', String(message.imageDataUrl || ''), Array.isArray(message.imageDataUrls) ? message.imageDataUrls : []).catch(error => { dispose(taskId); emit(taskId, 'needs-attention', { code: 'content-error', error: String(error?.message || 'GPT 页面处理失败。') }); }); return true; }
    if (message.action === 'resume') { try { resume(taskId, message.baselineHashes, message.requestFingerprint, message.deadlineAt, message.mode || 'mindmap', message.stage || 'generating'); } catch (error) { dispose(taskId); emit(taskId, 'needs-attention', { code: 'content-error', error: String(error?.message || 'GPT 页面恢复失败。') }); } return true; }
    if (message.action === 'probe') return { ok: true, state: probeTask(taskId, message.mode || 'mindmap', message.renewUntil, message.baselineHashes, message.requestFingerprint) };
    if (message.action === 'stop') { dispose(taskId); return true; }
    if (message.action === 'ping') { emit(taskId, 'ready'); return true; }
    return false;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { extractAssistantText, watchReply, resume, start, probeTask, attachImage, attachImages, waitForAttachment, uploadHasStalled, active, hash, assistantTurns, imageCandidate, findImageReply, attachmentMarkers, attachmentPreviewImages, attachmentPreviewState, isLoadedAttachmentPreview, findFreshAttachmentPreview, attachmentReadyEvidence, attachmentProgress, attachmentIsComplete, attachmentIsError };
  globalThis.chrome?.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
    const handled = handle(message, sender);
    if (!handled) return false;
    sendResponse?.(handled === true ? { ok: true } : handled);
    return false;
  });
})();
