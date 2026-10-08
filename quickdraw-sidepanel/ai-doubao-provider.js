(() => {
  'use strict';

  const AI = globalThis.QuickdrawAI;
  const Image = globalThis.QuickdrawAIImage || (typeof require === 'function' ? require('./ai-image-utils.js') : null);
  const GPTProvider = globalThis.QuickdrawGPTProvider || (typeof require === 'function' ? require('./ai-gpt-provider.js') : null);
  const TAB_KEY = 'quickdraw_ai_doubao_tab_id_v1';
  const ROOT_URL = 'https://www.doubao.com/chat/';

  class QuickdrawDoubaoProvider extends GPTProvider {
    usesRawImageBridge() { return true; }
    getTabKey() { return TAB_KEY; }
    getRootUrl() { return ROOT_URL; }
    getLabel() { return '豆包'; }
    getContentScript() { return 'doubao-content.js'; }
    getCommandType() { return 'qd-ai-doubao-command'; }
    // Input images are sent as extension-owned data URLs. Request output CDN
    // access only when the actual reply URL needs to be fetched.
    getQueryUrls() { return ['https://www.doubao.com/*']; }
    getTextPrompt(prompt, taskId, diagramType = 'flowchart') { return AI.buildDoubaoPrompt(prompt, taskId, diagramType); }
    getImagePrompt(prompt, taskId) { return AI.buildDoubaoImagePrompt(prompt, taskId); }
    getPermissionOrigins(task = null) {
      return [...(AI.DOUBAO_ORIGINS || ['https://www.doubao.com/*']), ...(task?.kind === 'image-edit' ? (AI.DOUBAO_IMAGE_ORIGINS || []) : [])];
    }
    async activateTaskTab(tabId) {
      const tab = await chrome.tabs.get(tabId);
      if (!this.isAllowedUrl(tab.url || tab.pendingUrl)) return;
      if (Number.isInteger(tab.groupId) && tab.groupId >= 0 && chrome.tabGroups?.update) {
        // Group presentation must not prevent activating the task page.
        try { await chrome.tabGroups.update(tab.groupId, { collapsed: false }); } catch {}
      }
      await chrome.tabs.update(tabId, { active: true });
    }
    async ensureTab(sourceWindowId, task = null) {
      const tabId = await super.ensureTab(sourceWindowId, task);
      // Doubao defers initialization/uploads in an unshown, collapsed tab.
      // Activate once at task launch; do not keep stealing focus during polling.
      await this.activateTaskTab(tabId);
      return tabId;
    }
    isAllowedUrl(url) {
      try {
        const parsed = new URL(String(url || ''));
        return parsed.protocol === 'https:' && !parsed.port && !parsed.username && !parsed.password && parsed.hostname === 'www.doubao.com';
      } catch { return false; }
    }
    isAllowedAuthUrl(url) {
      if (!this.isAllowedUrl(url)) return false;
      try { return /\/(?:login|log-in|signup|sign-up|passport|auth|account)(?:\/|$)/i.test(new URL(String(url)).pathname); } catch { return false; }
    }
    isRootTab(tab) {
      try {
        const parsed = new URL(String(tab?.url || ''));
        return this.isAllowedUrl(tab?.url) && /^\/chat\/?$/i.test(parsed.pathname) && !parsed.search && !parsed.hash;
      } catch { return false; }
    }
    isAllowedOutputImageUrl(url) {
      const text = String(url || '');
      if (/^blob:|^data:image\//i.test(text)) return true;
      try {
        const parsed = new URL(text);
        const host = parsed.hostname.toLowerCase();
        return parsed.protocol === 'https:' && !parsed.port && !parsed.username && !parsed.password && (host === 'doubao.com' || host.endsWith('.doubao.com') || host === 'byteimg.com' || host.endsWith('.byteimg.com'));
      } catch { return false; }
    }
    getOutputPermissionOrigins(url) {
      try {
        const parsed = new URL(String(url || ''));
        if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password) return [];
        const host = parsed.hostname.toLowerCase();
        // 豆包签名图片会在 p3/p9 等 imagex 子域间切换；按同一受控 CDN
        // 后缀授权，避免每张图因子域变化重复弹权限。
        if (host === 'byteimg.com' || host.endsWith('.byteimg.com')) return ['https://*.byteimg.com/*'];
        if (host === 'doubao.com' || host.endsWith('.doubao.com')) return ['https://*.doubao.com/*'];
        return [`${parsed.origin}/*`];
      } catch { return []; }
    }
    async waitForPageReady(task) {
      const deadline = Date.now() + 120_000;
      let consecutive = 0;
      while (Date.now() < deadline) {
        const tab = await chrome.tabs.get(task.tabId);
        const url = String(tab?.url || tab?.pendingUrl || '');
        if (this.isAllowedAuthUrl(url)) { const error = new Error(`${this.getLabel()} 页面需要登录或完成验证，任务已暂停。`); error.code = 'auth-required'; error.tabId = task.tabId; throw error; }
        if (!this.isAllowedUrl(url)) { consecutive = 0; await new Promise(resolve => setTimeout(resolve, 400)); continue; }
        try {
          await chrome.scripting.executeScript({ target: { tabId: task.tabId }, files: [this.getContentScript()] });
          const response = await chrome.tabs.sendMessage(task.tabId, { type: this.getCommandType(), action: 'readiness', taskId: task.taskId, mode: task.kind === 'image-edit' ? 'image-edit' : 'mindmap' }, { frameId: 0 });
          if (response?.auth) { const error = new Error(`${this.getLabel()} 页面需要登录或完成验证，任务已暂停。`); error.code = 'auth-required'; error.tabId = task.tabId; throw error; }
          if (response?.ready) { consecutive += 1; if (consecutive >= 2) return true; }
          else consecutive = 0;
        } catch (error) { if (error?.code === 'auth-required') throw error; consecutive = 0; }
        await new Promise(resolve => setTimeout(resolve, 400));
      }
      const error = new Error(`${this.getLabel()} 页面编辑器或图片上传控件长时间未就绪，原任务已保留且未发送。`); error.code = 'provider-page-not-ready'; throw error;
    }
    rawBridgeToken() {
      try { return globalThis.crypto?.randomUUID?.() || `raw-${Date.now()}-${Math.random()}`; }
      catch { return `raw-${Date.now()}-${Math.random()}`; }
    }
    async installRawImageBridge(task) {
      if (!this.usesRawImageBridge() || task?.kind !== 'image-edit') return '';
      const token = this.rawBridgeToken();
      const results = await chrome.scripting.executeScript({ target: { tabId: task.tabId }, world: 'MAIN', args: [task.taskId, token], func: (taskId, bridgeToken) => {
        const KEY = '__quickdrawDoubaoRawBridgeV2', VERSION = 4;
        if (globalThis[KEY]?.version === VERSION && globalThis[KEY]?.taskId === taskId) {
          return { installed: true, token: globalThis[KEY].token, version: VERSION, reused: true };
        }
        globalThis[KEY]?.cleanup?.();
        const original = JSON.parse;
        const originalResponseJson = globalThis.Response?.prototype?.json;
        const originalResponseText = globalThis.Response?.prototype?.text;
        const delivered = new Set();
        const cache = [];
        const cacheKeys = new Set();
        const validUrl = value => { try { const text = String(value || '').trim(); if (!text) return ''; const url = new URL(text, location.href); return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url.href : ''; } catch { return ''; } };
        const urlFrom = value => {
          if (typeof value === 'string') return validUrl(value);
          if (Array.isArray(value)) { for (const item of value) { const url = urlFrom(item); if (url) return url; } return ''; }
          if (!value || typeof value !== 'object') return '';
          for (const key of ['url', 'uri', 'src']) {
            const candidate = value[key];
            const url = Array.isArray(candidate) ? urlFrom(candidate) : validUrl(candidate);
            if (url) return url;
          }
          const list = value.url_list || value.urlList || value.urls;
          if (Array.isArray(list)) for (const item of list) { const url = validUrl(item); if (url) return url; }
          return '';
        };
        const identifiers = value => {
          const result = [];
          const add = candidate => { const text = String(candidate || '').trim(); if (text.length >= 8 && text.length <= 240 && !result.includes(text)) result.push(text); };
          if (value && typeof value === 'object') for (const key of ['id','image_id','imageId','creation_id','creationId','creation_task_id','creationTaskId','resource_id','resourceId','message_id','messageId','block_id','blockId','identifier','uri']) add(value[key]);
          return result;
        };
        const rawFrom = value => {
          if (!value || typeof value !== 'object') return '';
          const meta = value.imageMeta || value.image_meta || null;
          const candidates = [
            value.image_ori_raw, value.imageOriRaw, value.image_raw, value.imageRaw,
            value.original_raw, value.originalRaw,
            meta?.originalRaw, meta?.original_raw, meta?.imageRaw, meta?.image_raw,
            value.media?.imageMeta?.originalRaw, value.media?.image_meta?.original_raw
          ];
          for (const candidate of candidates) {
            const url = urlFrom(candidate);
            if (url) return url;
          }
          return '';
        };
        const aliasesFor = value => {
          if (!value || typeof value !== 'object') return [];
          const aliases = [];
          const add = candidate => { const url = urlFrom(candidate); if (url && !aliases.includes(url)) aliases.push(url); };
          for (const key of ['image_ori', 'image_preview', 'image_thumb', 'preview', 'thumb', 'original', 'image', 'url', 'src']) add(value[key]);
          const meta = value.imageMeta || value.image_meta || null;
          if (meta && typeof meta === 'object') for (const key of ['thumb', 'preview', 'original', 'image', 'url', 'src']) add(meta[key]);
          const media = value.media;
          if (media && typeof media === 'object') {
            for (const key of ['image_ori', 'image_preview', 'image_thumb', 'preview', 'thumb', 'original', 'image', 'url', 'src']) add(media[key]);
            const mediaMeta = media.imageMeta || media.image_meta || null;
            if (mediaMeta && typeof mediaMeta === 'object') for (const key of ['thumb', 'preview', 'original', 'image', 'url', 'src']) add(mediaMeta[key]);
          }
          return aliases;
        };
        const addPair = (raw, node, parent = null) => {
          if (!raw) return;
          const aliases = [...aliasesFor(node), ...aliasesFor(parent)].filter((value, index, values) => value && values.indexOf(value) === index);
          const pair = { aliases: [...aliases, raw].filter((value, index, values) => values.indexOf(value) === index), raw, identifiers: [...identifiers(node), ...identifiers(parent)] };
          const key = `${pair.raw}|${pair.aliases.join('|')}|${pair.identifiers.join('|')}`;
          if (cacheKeys.has(key)) return;
          cacheKeys.add(key); cache.push(pair);
          if (cache.length > 160) {
            const removed = cache.shift();
            const removedKey = `${removed.raw}|${removed.aliases.join('|')}|${removed.identifiers.join('|')}`;
            cacheKeys.delete(removedKey); delivered.delete(removedKey);
          }
        };
        const postPairs = pairs => { if (pairs.length) window.postMessage({ source: 'quickdraw-doubao-raw-v1', taskId, bridgeToken, pairs: pairs.slice(0, 80) }, location.origin); };
        const inspect = root => {
          const seen = new Set(), stack = [{ value: root, parent: null }]; let visited = 0;
          while (stack.length && visited++ < 20_000) {
            const entry = stack.pop(), value = entry.value, parent = entry.parent;
            if (typeof value === 'string' && value.length >= 2 && value.length <= 2_000_000 && /^[\s]*[\[{]/.test(value)) {
              try { stack.push({ value: Reflect.apply(original, JSON, [value]), parent }); } catch {}
              continue;
            }
            if (!value || typeof value !== 'object' || seen.has(value)) continue;
            try {
              if ((typeof Node !== 'undefined' && value instanceof Node) || (typeof Window !== 'undefined' && value instanceof Window) || (typeof EventTarget !== 'undefined' && value instanceof EventTarget)) continue;
            } catch {}
            seen.add(value);
            const creations = Array.isArray(value.creations) ? value.creations : (value.creations && typeof value.creations === 'object' ? Object.values(value.creations) : []);
            for (const item of creations.slice(0, 80)) {
              const image = item?.image || item;
              const raw = rawFrom(image) || rawFrom(item);
              addPair(raw, image, item);
            }
            const directRaw = rawFrom(value);
            if (directRaw) addPair(directRaw, value, parent);
            if (Array.isArray(value)) {
              for (const child of value) stack.push({ value: child, parent });
            } else {
              let entries = [];
              try { entries = Object.entries(value).slice(0, 240); } catch {}
              for (const [key, child] of entries) {
                if (['_owner','ref','return','child','sibling','alternate','stateNode'].includes(key)) continue;
                stack.push({ value: child, parent: value });
              }
            }
          }
          const fresh = cache.filter(pair => { const key = `${pair.raw}|${pair.aliases.join('|')}|${pair.identifiers.join('|')}`; if (delivered.has(key)) return false; delivered.add(key); return true; });
          postPairs(fresh);
        };
        const scanReactImageState = () => {
          const roots = [...document.querySelectorAll('[data-testid="message_image_content"],[data-testid="mdbox_image"],img[data-track-key]')].slice(-60);
          const seenFibers = new Set();
          for (const root of roots) {
            for (let node = root, depth = 0; node && node !== document.body && depth < 6; node = node.parentElement, depth++) {
              let keys = [];
              try { keys = Object.keys(node); } catch {}
              for (const key of keys) {
                if (key.startsWith('__reactProps$')) { try { inspect(node[key]); } catch {} }
                if (!key.startsWith('__reactFiber$')) continue;
                let fiber = node[key], hops = 0;
                while (fiber && hops++ < 24 && !seenFibers.has(fiber)) {
                  seenFibers.add(fiber);
                  try { inspect(fiber.memoizedProps); } catch {}
                  try { inspect(fiber.pendingProps); } catch {}
                  fiber = fiber.return;
                }
              }
            }
          }
        };
        function wrappedParse() { const result = Reflect.apply(original, this, arguments); try { inspect(result); } catch {} return result; }
        async function wrappedResponseJson() { const result = await Reflect.apply(originalResponseJson, this, arguments); try { inspect(result); } catch {} return result; }
        async function wrappedResponseText() { const result = await Reflect.apply(originalResponseText, this, arguments); try { inspect(result); } catch {} return result; }
        const cleanup = () => { window.removeEventListener('message', onMessage); if (JSON.parse === wrappedParse) JSON.parse = original; if (originalResponseJson && Response.prototype.json === wrappedResponseJson) Response.prototype.json = originalResponseJson; if (originalResponseText && Response.prototype.text === wrappedResponseText) Response.prototype.text = originalResponseText; if (globalThis[KEY]?.token === bridgeToken) delete globalThis[KEY]; };
        const onMessage = event => {
          if (event.source !== window || event.origin !== location.origin || event.data?.taskId !== taskId || event.data?.bridgeToken !== bridgeToken) return;
          if (event.data?.source === 'quickdraw-doubao-raw-cleanup-v1') cleanup();
          if (event.data?.source === 'quickdraw-doubao-raw-replay-v1') { try { scanReactImageState(); } catch {} postPairs(cache); }
        };
        JSON.parse = wrappedParse; if (originalResponseJson) Response.prototype.json = wrappedResponseJson; if (originalResponseText) Response.prototype.text = wrappedResponseText;
        window.addEventListener('message', onMessage);
        globalThis[KEY] = { token: bridgeToken, taskId, version: VERSION, cleanup };
        return { installed: JSON.parse === wrappedParse && (!originalResponseJson || Response.prototype.json === wrappedResponseJson), token: bridgeToken, version: VERSION };
      } });
      const confirmation = results?.[0]?.result;
      if (!confirmation?.installed || !confirmation.token || confirmation.version !== 4) throw new Error('豆包原图读取桥接未确认安装，任务未发送。');
      return String(confirmation.token);
    }
    async command(task, command) {
      if (command?.action === 'resume') await this.activateTaskTab(task.tabId);
      const rawBridgeToken = await this.installRawImageBridge(task);
      const isStart = command?.action === 'start';
      const requestText = isStart
        ? String(command?.prompt || '')
        : (task?.kind === 'image-edit' ? this.getImagePrompt(task.prompt, task.taskId) : this.getTextPrompt(task.prompt, task.taskId, task.diagramType));
      const enriched = {
        ...command,
        requestText,
        requestFingerprint: String(command?.requestFingerprint || task?.requestFingerprint || ''),
        requestMessageId: String(command?.requestMessageId || task?.requestMessageId || '')
      };
      if (rawBridgeToken) enriched.rawBridgeToken = rawBridgeToken;
      return super.command(task, enriched);
    }
    async probe(task, options = {}) {
      const tab = await chrome.tabs.get(task.tabId);
      if (!this.isAllowedUrl(tab.url || tab.pendingUrl)) throw new Error(`绑定标签页已离开 ${this.getLabel()}。`);
      await chrome.scripting.executeScript({ target: { tabId: task.tabId }, files: [this.getContentScript()] });
      const requestText = task?.kind === 'image-edit' ? this.getImagePrompt(task.prompt, task.taskId) : this.getTextPrompt(task.prompt, task.taskId, task.diagramType);
      const response = await chrome.tabs.sendMessage(task.tabId, {
        type: this.getCommandType(), taskId: task.taskId, action: 'probe',
        mode: task.kind === 'image-edit' ? 'image-edit' : 'mindmap',
        renewUntil: Number(options.renewUntil) || 0,
        baselineHashes: Array.isArray(task.baselineHashes) ? task.baselineHashes.slice(0, 80) : [],
        requestFingerprint: String(task.requestFingerprint || '').slice(0, 80),
        requestMessageId: String(task.requestMessageId || '').slice(0, 240),
        requestText
      }, { frameId: 0 });
      if (!response?.ok) throw new Error(`${this.getLabel()} 页面未确认恢复探测。`);
      return response.state || null;
    }
    async send(task) { await this.waitForPageReady(task); return super.send(task); }
  }

  globalThis.QuickdrawDoubaoProvider = QuickdrawDoubaoProvider;
  if (typeof module !== 'undefined' && module.exports) module.exports = QuickdrawDoubaoProvider;
})();
