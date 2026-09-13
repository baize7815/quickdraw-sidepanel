(() => {
  'use strict';

  const AI = globalThis.QuickdrawAI;
  const Image = globalThis.QuickdrawAIImage || (typeof require === 'function' ? require('./ai-image-utils.js') : null);
  const DoubaoProvider = globalThis.QuickdrawDoubaoProvider || (typeof require === 'function' ? require('./ai-doubao-provider.js') : null);
  const TAB_KEY = 'quickdraw_ai_dola_tab_id_v1';
  const ROOT_URL = 'https://www.dola.com/chat';
  const RAW_BRIDGE_VERSION = 1;

  class QuickdrawDolaProvider extends DoubaoProvider {
    usesRawImageBridge() { return true; }
    getTabKey() { return TAB_KEY; }
    getRootUrl() { return ROOT_URL; }
    getLabel() { return 'Dola'; }
    getContentScript() { return 'dola-content.js'; }
    getCommandType() { return 'qd-ai-dola-command'; }
    getQueryUrls() { return ['https://www.dola.com/*', 'https://dola.com/*']; }
    // Dola is wired for image generation only, mirroring Grok.
    getTextPrompt() { throw new Error('Dola 当前仅接入图片生成。'); }
    getImagePrompt(prompt, taskId) { return AI.buildDolaImagePrompt(prompt, taskId); }
    getPermissionOrigins(task = null) {
      return [...(AI.DOLA_ORIGINS || ['https://www.dola.com/*', 'https://dola.com/*']), ...(task?.kind === 'image-edit' ? (AI.DOLA_IMAGE_ORIGINS || []) : [])];
    }
    isAllowedUrl(url) {
      try {
        const parsed = new URL(String(url || ''));
        return parsed.protocol === 'https:' && !parsed.port && !parsed.username && !parsed.password &&
          (parsed.hostname === 'www.dola.com' || parsed.hostname === 'dola.com');
      } catch { return false; }
    }
    isAllowedAuthUrl(url) {
      if (!this.isAllowedUrl(url)) return false;
      try { return /\/(?:login|log-in|signup|sign-up|passport|auth|account|verify|verification)(?:\/|$)/i.test(new URL(String(url)).pathname); } catch { return false; }
    }
    isRootTab(tab) {
      try {
        const parsed = new URL(String(tab?.url || ''));
        return this.isAllowedUrl(tab?.url) && /^\/chat\/?$/i.test(parsed.pathname) && !parsed.hash;
      } catch { return false; }
    }
    // Result media can be served from a CDN host that is only known once the
    // reply arrives. Accept any well-formed image URL (the base materialize
    // path requests the exact origin before fetching), instead of restricting
    // to first-party Dola hosts.
    isAllowedOutputImageUrl(url) {
      const text = String(url || '');
      if (/^blob:|^data:image\//i.test(text)) return true;
      return !!Image?.isAllowedImageUrl?.(url);
    }
    getOutputPermissionOrigins(url) {
      try {
        const parsed = new URL(String(url || ''));
        return parsed.protocol === 'https:' && parsed.origin ? [`${parsed.origin}/*`] : [];
      } catch { return []; }
    }

    // MAIN-world bridge. Dola embeds both a display image (image.image_ori) and
    // the unwatermarked original (image.image_ori_raw) in its JSON/SSE/XHR
    // responses. Observe those channels without mutating the page and forward
    // {raw, aliases} pairs to the isolated content script, which maps the
    // visible <img src> back to the raw URL before reporting the reply.
    async installRawImageBridge(task) {
      if (!this.usesRawImageBridge() || task?.kind !== 'image-edit') return '';
      const token = this.rawBridgeToken();
      const results = await chrome.scripting.executeScript({ target: { tabId: task.tabId }, world: 'MAIN', args: [task.taskId, token], func: (taskId, bridgeToken) => {
        const KEY = '__quickdrawDolaRawBridgeV1', VERSION = 1;
        if (globalThis[KEY]?.version === VERSION && globalThis[KEY]?.taskId === taskId) {
          return { installed: true, token: globalThis[KEY].token, version: VERSION, reused: true };
        }
        globalThis[KEY]?.cleanup?.();
        const originalParse = JSON.parse;
        const origResponseJson = globalThis.Response?.prototype?.json;
        const origResponseText = globalThis.Response?.prototype?.text;
        const origFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
        const XHR = globalThis.XMLHttpRequest;
        const origXhrOpen = XHR?.prototype?.open;
        const origXhrSend = XHR?.prototype?.send;
        const cache = [];
        const cacheKeys = new Set();
        const delivered = new Set();

        const validUrl = value => {
          try {
            const text = String(value || '').trim();
            if (!text) return '';
            const url = new URL(text, location.href);
            return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url.href : '';
          } catch { return ''; }
        };
        const urlFrom = value => {
          if (typeof value === 'string') return validUrl(value);
          if (Array.isArray(value)) { for (const item of value) { const url = urlFrom(item); if (url) return url; } return ''; }
          if (!value || typeof value !== 'object') return '';
          for (const key of ['url', 'uri', 'src']) {
            const candidate = value[key];
            const url = Array.isArray(candidate) ? urlFrom(candidate) : validUrl(candidate);
            if (url) return url;
          }
          for (const key of ['url_list', 'urlList', 'urls']) {
            const list = value[key];
            if (Array.isArray(list)) for (const item of list) { const url = validUrl(item); if (url) return url; }
          }
          return '';
        };
        // Collect every variant URL reachable inside an image descriptor so the
        // isolated side can match whatever URL the page finally renders.
        const collectAliases = image => {
          const out = [];
          const push = value => { const url = validUrl(value); if (url && !out.includes(url)) out.push(url); };
          const walk = (value, depth) => {
            if (depth > 3) return;
            if (typeof value === 'string') { push(value); return; }
            if (Array.isArray(value)) { value.forEach(item => walk(item, depth + 1)); return; }
            if (!value || typeof value !== 'object') return;
            if (value.url || value.uri || value.src) push(urlFrom(value));
            for (const key of ['url_list', 'urlList', 'urls']) if (Array.isArray(value[key])) value[key].forEach(item => push(item));
            for (const child of Object.values(value)) {
              if (typeof child === 'string' && /^https?:/i.test(child)) push(child);
              else if (child && typeof child === 'object') walk(child, depth + 1);
            }
          };
          walk(image, 0);
          return out.slice(0, 20);
        };
        const pairKey = pair => `${pair.raw}|${pair.aliases.join('|')}`;
        const addPair = (raw, image) => {
          if (!raw) return;
          const aliases = collectAliases(image).filter(url => url !== raw);
          const pair = { raw, aliases, identifiers: [] };
          const key = pairKey(pair);
          if (cacheKeys.has(key)) return;
          cacheKeys.add(key); cache.push(pair);
          if (cache.length > 160) {
            const removed = cache.shift();
            const removedKey = pairKey(removed);
            cacheKeys.delete(removedKey); delivered.delete(removedKey);
          }
        };
        const postPairs = pairs => { if (pairs.length) window.postMessage({ source: 'quickdraw-dola-raw-v1', taskId, bridgeToken, pairs: pairs.slice(0, 80) }, location.origin); };
        const inspect = root => {
          const seen = new Set();
          const stack = [{ value: root }];
          let visited = 0;
          while (stack.length && visited++ < 20_000) {
            const entry = stack.pop(), value = entry.value;
            if (typeof value === 'string' && value.length >= 2 && value.length <= 2_000_000 && /^[\s]*[\[{]/.test(value) && /image_ori_raw|creations|creation_block/.test(value)) {
              try { stack.push({ value: Reflect.apply(originalParse, JSON, [value]) }); } catch {}
              continue;
            }
            if (!value || typeof value !== 'object' || seen.has(value)) continue;
            seen.add(value);
            if (value.image && typeof value.image === 'object') {
              const raw = urlFrom(value.image.image_ori_raw || value.image.imageOriRaw);
              if (raw) addPair(raw, value.image);
            }
            const directRaw = urlFrom(value.image_ori_raw || value.imageOriRaw);
            if (directRaw) addPair(directRaw, value);
            if (Array.isArray(value)) for (const child of value) stack.push({ value: child });
            else {
              const values = Object.values(value);
              for (let i = 0; i < values.length && i < 240; i++) stack.push({ value: values[i] });
            }
          }
          const fresh = cache.filter(pair => { const key = pairKey(pair); if (delivered.has(key)) return false; delivered.add(key); return true; });
          postPairs(fresh);
        };
        const parseText = text => {
          if (!text || typeof text !== 'string') return;
          const trimmed = text.trim();
          if (!trimmed) return;
          if (trimmed[0] === '{' || trimmed[0] === '[') { try { inspect(Reflect.apply(originalParse, JSON, [trimmed])); } catch {} return; }
          // SSE stream: one JSON object per `data:` line.
          for (const line of trimmed.split(/\r?\n/)) {
            const match = line.match(/^\s*data\s*:\s*(.+?)\s*$/i);
            if (!match || !match[1] || match[1] === '[DONE]') continue;
            try { inspect(Reflect.apply(originalParse, JSON, [match[1]])); } catch {}
          }
        };
        function wrappedParse() {
          const result = Reflect.apply(originalParse, this, arguments);
          try { if (typeof arguments[0] === 'string' && /image_ori_raw|creations|creation_block/.test(arguments[0])) inspect(result); } catch {}
          return result;
        }
        async function wrappedRespJson() { const result = await Reflect.apply(origResponseJson, this, arguments); try { inspect(result); } catch {} return result; }
        async function wrappedRespText() { const result = await Reflect.apply(origResponseText, this, arguments); try { parseText(String(result || '')); } catch {} return result; }
        let wrappedFetch = null;
        if (origFetch) {
          wrappedFetch = async function (input, init) {
            const response = await origFetch(input, init);
            try {
              const clone = response.clone();
              const contentType = clone.headers?.get?.('content-type') || '';
              const inputUrl = typeof input === 'string' ? input : (input?.url || '');
              if (/event-stream/i.test(contentType) && clone.body?.getReader) {
                (async () => {
                  const reader = clone.body.getReader();
                  const decoder = new TextDecoder();
                  let buffer = '';
                  while (true) {
                    const next = await reader.read();
                    if (next.done) break;
                    buffer += decoder.decode(next.value, { stream: true });
                    const lines = buffer.split(/\r?\n/);
                    buffer = lines.pop() || '';
                    for (const line of lines) parseText(line);
                  }
                  if (buffer) parseText(buffer);
                })().catch(() => {});
              } else if (/json|text\/plain/i.test(contentType) || /im\/chain\/single|chat\/completion|samantha/i.test(String(inputUrl))) {
                clone.text().then(parseText).catch(() => {});
              }
            } catch {}
            return response;
          };
        }
        let wrappedXhrOpen = null, wrappedXhrSend = null;
        if (origXhrOpen && origXhrSend && XHR) {
          wrappedXhrOpen = function (method, url, ...rest) { this.__qdDolaUrl = url; return origXhrOpen.call(this, method, url, ...rest); };
          wrappedXhrSend = function (...args) {
            this.addEventListener('loadend', () => {
              try {
                if (this.responseType === 'json' && this.response) inspect(this.response);
                else if ((!this.responseType || this.responseType === 'text') && this.responseText) parseText(String(this.responseText));
              } catch {}
            }, { once: true });
            return origXhrSend.apply(this, args);
          };
        }
        const onMessage = event => {
          if (event.source !== window || event.origin !== location.origin || event.data?.taskId !== taskId || event.data?.bridgeToken !== bridgeToken) return;
          if (event.data?.source === 'quickdraw-dola-raw-cleanup-v1') cleanup();
          if (event.data?.source === 'quickdraw-dola-raw-replay-v1') postPairs(cache);
        };
        const cleanup = () => {
          window.removeEventListener('message', onMessage);
          if (JSON.parse === wrappedParse) JSON.parse = originalParse;
          if (origResponseJson && Response.prototype.json === wrappedRespJson) Response.prototype.json = origResponseJson;
          if (origResponseText && Response.prototype.text === wrappedRespText) Response.prototype.text = origResponseText;
          if (wrappedFetch && globalThis.fetch === wrappedFetch) globalThis.fetch = origFetch;
          if (wrappedXhrOpen && XHR.prototype.open === wrappedXhrOpen) XHR.prototype.open = origXhrOpen;
          if (wrappedXhrSend && XHR.prototype.send === wrappedXhrSend) XHR.prototype.send = origXhrSend;
          if (globalThis[KEY]?.token === bridgeToken) delete globalThis[KEY];
        };
        JSON.parse = wrappedParse;
        if (origResponseJson) Response.prototype.json = wrappedRespJson;
        if (origResponseText) Response.prototype.text = wrappedRespText;
        if (wrappedFetch) globalThis.fetch = wrappedFetch;
        if (wrappedXhrOpen) XHR.prototype.open = wrappedXhrOpen;
        if (wrappedXhrSend) XHR.prototype.send = wrappedXhrSend;
        window.addEventListener('message', onMessage);
        globalThis[KEY] = { token: bridgeToken, taskId, version: VERSION, cleanup };
        return { installed: JSON.parse === wrappedParse, token: bridgeToken, version: VERSION };
      } });
      const confirmation = results?.[0]?.result;
      if (!confirmation?.installed || !confirmation.token || confirmation.version !== RAW_BRIDGE_VERSION) throw new Error('Dola 原图读取桥接未确认安装，任务未发送。');
      return String(confirmation.token);
    }
  }

  globalThis.QuickdrawDolaProvider = QuickdrawDolaProvider;
  if (typeof module !== 'undefined' && module.exports) module.exports = QuickdrawDolaProvider;
})();
