(() => {
  'use strict';
  const AI = globalThis.QuickdrawAI;
  const Parent = globalThis.QuickdrawGrokProvider || (typeof require === 'function' ? require('./ai-grok-provider.js') : null);
  class QuickdrawGeminiProvider extends Parent {
    getTabKey() { return 'quickdraw_ai_gemini_tab_id_v1'; }
    getRootUrl() { return 'https://gemini.google.com/app'; }
    getLabel() { return 'Gemini'; }
    getContentScript() { return 'gemini-content.js'; }
    getCommandType() { return 'qd-ai-gemini-command'; }
    getQueryUrls() { return ['https://gemini.google.com/*']; }
    getPermissionOrigins() { return [...(AI.GEMINI_ORIGINS || ['https://gemini.google.com/*'])]; }
    getImagePrompt(prompt, taskId) { return AI.buildGrokImagePrompt(prompt, taskId); }
    getTextPrompt() { throw new Error('Gemini 当前只支持从 Quickdraw 提交图片任务。'); }
    // Each task gets an extension-owned conversation tab. Never reuse a
    // potentially personal conversation found in the user's browser.
    async findReusableTab() { return null; }
    // Gemini chats are user-visible artifacts. Never auto-group or close them.
    async groupOwnedTab(tabId) { return this.loadTabMeta(); }
    async cleanup(task) {
      // Background cleanup/import must release ownership, not remove the tab.
      await this.detach(task);
      return true;
    }
    isAllowedUrl(url) {
      try { const u = new URL(String(url || '')); return u.protocol === 'https:' && !u.port && !u.username && !u.password && u.hostname === 'gemini.google.com' && /^\/app(?:\/|$)/.test(u.pathname); }
      catch { return false; }
    }
    isAllowedAuthUrl(url) {
      try { const u = new URL(String(url || '')); return u.protocol === 'https:' && !u.port && !u.username && !u.password && (u.hostname === 'accounts.google.com' || (u.hostname === 'gemini.google.com' && /^\/(?:signin|login|auth)(?:\/|$)/i.test(u.pathname))); }
      catch { return false; }
    }
    isRootTab(tab) {
      try { const u = new URL(String(tab?.url || '')); return this.isAllowedUrl(tab?.url) && /^\/app\/?$/.test(u.pathname) && !u.search && !u.hash; }
      catch { return false; }
    }
    isAllowedOutputImageUrl(url) {
      if (/^(?:blob:|data:image\/(?:png|jpeg|webp|gif);base64,)/i.test(String(url || ''))) return true;
      try {
        const u = new URL(String(url || ''));
        const host = u.hostname.toLowerCase();
        return u.protocol === 'https:' && !u.port && !u.username && !u.password &&
          (host === 'gemini.google.com' || host === 'googleusercontent.com' || host.endsWith('.googleusercontent.com') || host === 'gstatic.com' || host.endsWith('.gstatic.com'));
      } catch { return false; }
    }
    getOutputPermissionOrigins(url) {
      try { const u = new URL(String(url || '')); return this.isAllowedOutputImageUrl(url) && u.protocol === 'https:' ? [u.origin + '/*'] : []; }
      catch { return []; }
    }
  }
  globalThis.QuickdrawGeminiProvider = QuickdrawGeminiProvider;
  if (typeof module !== 'undefined' && module.exports) module.exports = QuickdrawGeminiProvider;
})();
