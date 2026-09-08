(() => {
  'use strict';
  const AI = globalThis.QuickdrawAI;
  const Image = globalThis.QuickdrawAIImage || (typeof require === 'function' ? require('./ai-image-utils.js') : null);
  const TAB_KEY = 'quickdraw_ai_gpt_tab_id_v1';
  const ROOT_URL = 'https://chatgpt.com/';
  const PAGE_LOAD_TIMEOUT = 120_000;

  class QuickdrawGPTProvider {
    constructor(assetStore = null) { this.tabId = null; this.tabMeta = null; this.assetStore = assetStore; }
    getTabKey() { return TAB_KEY; }
    getRootUrl() { return ROOT_URL; }
    // Input images are transferred as extension-owned data URLs. Output image
    // hosts are checked only when a reply has to be fetched, so starting an
    // image task must not request every possible image CDN up front.
    getPermissionOrigins() { return [...AI.GPT_ORIGINS, ...(AI.GPT_AUTH_ORIGINS || [])]; }
    getQueryUrls() { return ['https://chatgpt.com/*', 'https://chat.openai.com/*']; }
    getContentScript() { return 'gpt-content.js'; }
    getCommandType() { return 'qd-ai-gpt-command'; }
    getLabel() { return 'GPT'; }
    getTextPrompt(prompt, taskId) { return AI.buildGPTPrompt(prompt, taskId); }
    getImagePrompt(prompt, taskId) { return AI.buildGPTImagePrompt(prompt, taskId); }
    isAllowedOutputImageUrl(url) { return !!Image?.isAllowedImageUrl?.(url); }
    getOutputPermissionOrigins(url) {
      try {
        const parsed = new URL(String(url || ''));
        return parsed.protocol === 'https:' && parsed.origin ? [`${parsed.origin}/*`] : [];
      } catch { return []; }
    }
    isAllowedUrl(url) { return AI.isAllowedGPTUrl(url); }
    isAllowedAuthUrl(url) { return !!AI.isAllowedGPTAuthUrl?.(url); }
    async loadTabMeta() {
      if (this.tabMeta) return this.tabMeta;
      let saved = null;
      const key = this.getTabKey();
      try { saved = (await chrome.storage.session.get(key))?.[key]; } catch {}
      if (saved && typeof saved === 'object') this.tabMeta = { ...saved, tabId: Number.isInteger(saved.tabId) ? saved.tabId : null, ownedByExtension: saved.ownedByExtension === true };
      else if (Number.isInteger(saved)) this.tabMeta = { tabId: saved, ownedByExtension: false, ownerToken: '', taskId: null, groupId: null };
      this.tabId = Number.isInteger(this.tabMeta?.tabId) ? this.tabMeta.tabId : null;
      return this.tabMeta;
    }
    async saveTabMeta(meta) {
      this.tabMeta = { ...meta, tabId: Number(meta.tabId), ownedByExtension: meta.ownedByExtension === true, groupId: Number.isInteger(meta.groupId) ? meta.groupId : null, groupError: String(meta.groupError || '').slice(0, 200) };
      this.tabId = this.tabMeta.tabId;
      try { await chrome.storage.session.set({ [this.getTabKey()]: this.tabMeta }); } catch {}
      return this.tabMeta;
    }
    randomToken() {
      try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch {}
      return `ai-tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
    async groupOwnedTab(tabId) {
      const meta = await this.loadTabMeta();
      if (!meta?.ownedByExtension || meta.tabId !== tabId) return meta;
      if (!chrome.tabs?.group) {
        meta.groupError = 'tab-groups-unavailable';
        return this.saveTabMeta(meta);
      }
      let groupId = null;
      try {
        groupId = await chrome.tabs.group({ tabIds: [tabId] });
        if (Number.isInteger(groupId)) meta.groupId = groupId;
        if (Number.isInteger(groupId) && chrome.tabGroups?.update) await chrome.tabGroups.update(groupId, { collapsed: true, title: 'AI' });
        meta.groupError = '';
      } catch (error) {
        meta.groupError = String(error?.message || 'tab-group-failed').slice(0, 200);
      }
      return this.saveTabMeta(meta);
    }
    isRootTab(tab) {
      try { const parsed = new URL(String(tab?.url || '')); return this.isAllowedUrl(tab?.url) && parsed.pathname === '/' && !parsed.search && !parsed.hash; } catch { return false; }
    }
    async isSafeUserTab(tab) {
      if (!tab || tab.active || (tab.status && tab.status !== 'complete') || !this.isRootTab(tab)) return false;
      if (!chrome.scripting?.executeScript) return false;
      try {
        const result = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
          const text = element => String(element?.value ?? element?.innerText ?? element?.textContent ?? '').trim();
          const input = document.querySelector('#prompt-textarea,textarea,[contenteditable="true"],[role="textbox"]');
          const users = document.querySelectorAll('[data-message-author-role="user"],[data-testid*="conversation-turn"][data-turn="user"]').length;
          const busy = document.querySelector('[data-testid*="stop"],button[aria-label*="Stop" i],button[aria-label*="停止"],[data-state="loading"]');
          return { safe: !text(input) && !users && !busy };
        } });
        return result?.[0]?.result?.safe === true;
      } catch { return false; }
    }
    async findReusableTab(sourceWindowId) {
      if (!chrome.tabs?.query) return null;
      let tabs = [];
      try { tabs = await chrome.tabs.query({ ...(Number.isInteger(sourceWindowId) ? { windowId: sourceWindowId } : {}), url: this.getQueryUrls() }); } catch { return null; }
      for (const tab of tabs) if (await this.isSafeUserTab(tab)) return tab;
      return null;
    }
    async ensureTab(sourceWindowId, task = null) {
      const saved = await this.loadTabMeta();
      let tab = null;
      if (Number.isInteger(saved?.tabId)) { try { tab = await chrome.tabs.get(saved.tabId); } catch {} }
      if (tab && !this.isAllowedUrl(tab.url) && !this.isAllowedAuthUrl(tab.url)) tab = null;
      if (tab && saved?.ownedByExtension) {
        const next = { ...saved, taskId: task?.taskId || saved.taskId || null };
        if (task?.taskId && saved.taskId !== task.taskId) next.ownerToken = this.randomToken();
        await this.saveTabMeta(next);
        await this.groupOwnedTab(tab.id);
        return tab.id;
      }
      const reusable = await this.findReusableTab(sourceWindowId);
      if (reusable) {
        await this.saveTabMeta({ tabId: reusable.id, ownedByExtension: false, ownerToken: '', taskId: task?.taskId || null, groupId: null, windowId: reusable.windowId });
        return reusable.id;
      }
      const options = { url: this.getRootUrl(), active: false };
      if (Number.isInteger(sourceWindowId)) options.windowId = sourceWindowId;
      tab = await chrome.tabs.create(options);
      await this.saveTabMeta({ tabId: tab.id, ownedByExtension: true, ownerToken: this.randomToken(), taskId: task?.taskId || null, groupId: null, windowId: tab.windowId });
      await this.groupOwnedTab(tab.id);
      return tab.id;
    }
    getTabMeta() { return this.tabMeta ? { ...this.tabMeta } : null; }
    async prepare(task) {
      const origins = this.getPermissionOrigins(task);
      if (chrome.permissions?.contains && !await chrome.permissions.contains({ origins })) throw new Error(`请先授予 ${this.getLabel()} 网站权限。`);
      const tabId = await this.ensureTab(task.sourceWindowId, task);
      const meta = await this.loadTabMeta();
      let initialTab;
      try { initialTab = await chrome.tabs.get(tabId); }
      catch (error) { error.code = 'gpt-tab-unavailable'; throw error; }
      const initialUrl = String(initialTab?.url || initialTab?.pendingUrl || '');
      if (meta?.ownedByExtension && !this.isAllowedUrl(initialUrl) && !this.isAllowedUrl(initialTab?.pendingUrl) && !this.isAllowedAuthUrl(initialUrl) && !this.isAllowedAuthUrl(initialTab?.pendingUrl)) {
        try { await chrome.tabs.update(tabId, { url: this.getRootUrl(), active: false }); }
        catch (error) { error.code = 'provider-tab-navigation'; throw new Error(`无法启动 ${this.getLabel()} 后台标签页，请重试。`, { cause: error }); }
      }
      const deadline = Date.now() + PAGE_LOAD_TIMEOUT;
      let nonGptSince = 0;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 300));
        const tab = await chrome.tabs.get(tabId);
        const url = String(tab?.url || tab?.pendingUrl || '');
        if (this.isAllowedAuthUrl(url)) {
          if (tab.status === 'complete' || tab.status == null) {
            const error = new Error(`${this.getLabel()} 页面需要登录或完成验证，任务已暂停。`);
            error.code = 'auth-required'; error.tabId = tabId;
            throw error;
          }
          continue;
        }
        if (this.isAllowedUrl(url)) {
          nonGptSince = 0;
          if (tab.status === 'complete' || tab.status == null) return tabId;
          continue;
        }
        if (tab.status === 'loading' || !tab?.url || tab?.pendingUrl) { nonGptSince = 0; continue; }
        if (!nonGptSince) nonGptSince = Date.now();
        if (Date.now() - nonGptSince < 3_000) continue;
        const error = new Error(`${this.getLabel()} 标签页未加载到目标页面，请检查网络或扩展权限后重试。`);
        error.code = 'provider-tab-navigation';
        throw error;
      }
      const timeoutError = new Error(`${this.getLabel()} 页面加载超时，请检查页面是否仍在加载。`);
      timeoutError.code = 'provider-tab-timeout';
      throw timeoutError;
    }
    accepts(sender, task) { return sender?.id === chrome.runtime.id && sender?.frameId === 0 && sender?.tab?.id === task.tabId && this.isAllowedUrl(sender.url); }
    async command(task, command) {
      const tab = await chrome.tabs.get(task.tabId);
      if (!this.isAllowedUrl(tab.url || tab.pendingUrl)) throw new Error(`绑定标签页已离开 ${this.getLabel()}。`);
      await chrome.scripting.executeScript({ target: { tabId: task.tabId }, files: [this.getContentScript()] });
      const response = await chrome.tabs.sendMessage(task.tabId, { type: this.getCommandType(), taskId: task.taskId, ...command }, { frameId: 0 });
      if (!response?.ok) throw new Error(`${this.getLabel()} 页面未确认接收任务，未自动重发。`);
    }
    async probe(task, options = {}) {
      const tab = await chrome.tabs.get(task.tabId);
      if (!this.isAllowedUrl(tab.url || tab.pendingUrl)) throw new Error(`绑定标签页已离开 ${this.getLabel()}。`);
      await chrome.scripting.executeScript({ target: { tabId: task.tabId }, files: [this.getContentScript()] });
      const response = await chrome.tabs.sendMessage(task.tabId, {
        type: this.getCommandType(), taskId: task.taskId, action: 'probe',
        mode: task.kind === 'image-edit' ? 'image-edit' : 'mindmap',
        renewUntil: Number(options.renewUntil) || 0,
        baselineHashes: Array.isArray(task.baselineHashes) ? task.baselineHashes.slice(0, 80) : [],
        requestFingerprint: String(task.requestFingerprint || '').slice(0, 80)
      }, { frameId: 0 });
      if (!response?.ok) throw new Error(`${this.getLabel()} 页面未确认恢复探测。`);
      return response.state || null;
    }
    async inputBlob(task) {
      const blobs = [];
      const assets = Array.isArray(task?.inputAssets) && task.inputAssets.length ? task.inputAssets : (Array.isArray(task?.inputAssetIds) && task.inputAssetIds.length ? task.inputAssetIds.map((assetId, order) => ({ assetId, order })) : (task?.inputAssetId ? [{ assetId: task.inputAssetId, order: 0 }] : []));
      for (const item of [...assets].sort((a, b) => Number(a?.order || 0) - Number(b?.order || 0))) {
        if (!this.assetStore || !item?.assetId) throw new Error('图片源资源不可用。');
        const record = await this.assetStore.getAsset(item.assetId);
        if (!record?.blob) throw new Error('图片源资源已丢失，请重新选择对象。');
        if (Image?.inspectBlob) await Image.inspectBlob(record.blob, { maxBytes: Image.MAX_INPUT_BYTES });
        blobs.push(record.blob);
      }
      return blobs;
    }
    async send(task) {
      if (task.kind === 'image-edit') {
        const imageBlobs = await this.inputBlob(task);
        const imageDataUrls = [];
        for (const blob of imageBlobs) imageDataUrls.push(await Image.blobToDataUrl(blob, { maxBytes: Image.MAX_INPUT_BYTES }));
        return this.command(task, { action: 'start', mode: 'image-edit', imageDataUrl: imageDataUrls[0] || '', imageDataUrls, prompt: this.getImagePrompt(task.prompt, task.taskId) });
      }
      return this.command(task, { action: 'start', mode: 'mindmap', prompt: this.getTextPrompt(task.prompt, task.taskId) });
    }
    resume(task) { return this.command(task, { action: 'resume', mode: task.kind === 'image-edit' ? 'image-edit' : 'mindmap', stage: task.stage || '', baselineHashes: task.baselineHashes || [], requestFingerprint: task.requestFingerprint, deadlineAt: task.stageDeadlineAt || task.deadlineAt }); }
    async materializeImage(event = {}) {
      let blob = null;
      if (event.imageDataUrl) { const decoded = await Image.dataUrlToBlob(event.imageDataUrl, { maxBytes: Image.MAX_OUTPUT_BYTES }); blob = decoded.blob; }
      const url = String(event.imageUrl || event.src || '').trim();
      if (!blob) {
        if (!url) { const error = new Error(`${this.getLabel()} 未返回图片。`); error.code = 'image-missing'; throw error; }
        if (!/^https:\/\//i.test(url)) { const error = new Error('返回图片地址无法由扩展读取，请在平台重新生成后重试。'); error.code = 'image-fetch-unavailable'; throw error; }
        const permissionOrigins = this.getOutputPermissionOrigins(url);
        if (!permissionOrigins.length) { const error = new Error('返回图片地址无效，无法读取。'); error.code = 'image-fetch-unavailable'; throw error; }
        let permitted = false;
        try { permitted = !!(chrome.permissions?.contains && await chrome.permissions.contains({ origins: permissionOrigins })); } catch {}
        if (!permitted) {
          const error = new Error('图片来自未授权网站，请授予该图片所在网站权限后重试。');
          error.code = 'image-origin-permission'; error.imageUrl = url; error.permissionOrigins = permissionOrigins;
          throw error;
        }
        const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 30_000);
        let response;
        try { response = await fetch(url, { credentials: 'include', signal: controller.signal }); }
        catch (cause) { const error = new Error(`无法读取 ${this.getLabel()} 返回图片，地址可能已过期或被网站拒绝。`); error.code = 'image-fetch-failed'; error.cause = cause; throw error; }
        finally { clearTimeout(timeout); }
        if (!response.ok) { const error = new Error(`无法读取 ${this.getLabel()} 返回图片。`); error.code = 'image-fetch-failed'; throw error; }
        const declaredLength = Number(response.headers?.get?.('content-length') || 0);
        if (declaredLength > Image.MAX_OUTPUT_BYTES) throw new Error('图片资源过大或为空。');
        blob = await response.blob();
      }
      if (!Image?.inspectBlob) return { blob, type: blob.type || 'image/png', bytes: blob.size || 0, width: 0, height: 0, imageUrl: url };
      const checked = await Image.inspectBlob(blob, { maxBytes: Image.MAX_OUTPUT_BYTES, requireDimensions: true });
      return { ...checked, imageUrl: url };
    }
    async stop(task) { if (!Number.isInteger(task.tabId)) return; try { await chrome.tabs.sendMessage(task.tabId, { type: this.getCommandType(), action: 'stop', taskId: task.taskId }, { frameId: 0 }); } catch {} }
    async cleanup(task) {
      if (!task?.tabOwned || !task.tabOwnerToken || !Number.isInteger(task.tabId)) return false;
      const saved = await this.loadTabMeta();
      if (!saved?.ownedByExtension || saved.tabId !== task.tabId || saved.ownerToken !== task.tabOwnerToken) return false;
      let removed = false;
      try { await chrome.tabs.remove(task.tabId); removed = true; }
      catch {
        try { await chrome.tabs.get(task.tabId); }
        catch { removed = true; }
      }
      if (!removed) return false;
      try {
        const key = this.getTabKey();
        const current = (await chrome.storage.session.get(key))?.[key];
        if (current?.ownedByExtension === true && current.tabId === task.tabId && current.ownerToken === task.tabOwnerToken) await chrome.storage.session.remove(this.getTabKey());
      } catch {}
      this.tabId = null; this.tabMeta = null;
      return true;
    }
    async detach(task) {
      const saved = await this.loadTabMeta();
      if (saved?.tabId !== task.tabId) return;
      await chrome.storage.session.remove(this.getTabKey());
      this.tabId = null; this.tabMeta = null;
    }
    async open(task) {
      let tab;
      if (Number.isInteger(task?.tabId)) { try { tab = await chrome.tabs.get(task.tabId); } catch {} }
      if (!tab || (!this.isAllowedUrl(tab.url) && !this.isAllowedAuthUrl(tab.url))) tab = await chrome.tabs.get(await this.ensureTab(task?.sourceWindowId, task));
      await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true });
      return { ok: true, tabId: tab.id };
    }
  }
  globalThis.QuickdrawGPTProvider = QuickdrawGPTProvider;
  if (typeof module !== 'undefined' && module.exports) module.exports = QuickdrawGPTProvider;
})();
