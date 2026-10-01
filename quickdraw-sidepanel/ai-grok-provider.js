(() => {
  'use strict';
  const AI = globalThis.QuickdrawAI;
  const DoubaoProvider = globalThis.QuickdrawDoubaoProvider || (typeof require === 'function' ? require('./ai-doubao-provider.js') : null);
  const TAB_KEY = 'quickdraw_ai_grok_tab_id_v1';
  const ROOT_URL = 'https://grok.com/';

  class QuickdrawGrokProvider extends DoubaoProvider {
    usesRawImageBridge() { return false; }
    getTabKey() { return TAB_KEY; }
    getRootUrl() { return ROOT_URL; }
    getLabel() { return 'Grok'; }
    getContentScript() { return 'grok-content.js'; }
    getCommandType() { return 'qd-ai-grok-command'; }
    getQueryUrls() { return ['https://grok.com/*']; }
    getPermissionOrigins() { return [...(AI.GROK_ORIGINS || ['https://grok.com/*']), ...(AI.GROK_AUTH_ORIGINS || ['https://accounts.x.ai/*'])]; }
    getTextPrompt() { throw new Error('Grok 当前仅接入图片编辑。'); }
    getImagePrompt(prompt, taskId) { return AI.buildGrokImagePrompt(prompt, taskId); }
    isAllowedUrl(url) {
      try { const parsed = new URL(String(url || '')); return parsed.protocol === 'https:' && !parsed.port && !parsed.username && !parsed.password && parsed.hostname === 'grok.com'; }
      catch { return false; }
    }
    isAllowedAuthUrl(url) {
      try { const parsed = new URL(String(url || '')); return parsed.protocol === 'https:' && !parsed.port && !parsed.username && !parsed.password && (parsed.hostname === 'accounts.x.ai' || (parsed.hostname === 'grok.com' && /\/(?:sign-in|login|auth)(?:\/|$)/i.test(parsed.pathname))); }
      catch { return false; }
    }
    isRootTab(tab) {
      try { const parsed = new URL(String(tab?.url || '')); return this.isAllowedUrl(tab?.url) && parsed.pathname === '/' && !parsed.search && !parsed.hash; }
      catch { return false; }
    }
    getOutputPermissionOrigins(url) {
      try { const parsed = new URL(String(url || '')); return parsed.protocol === 'https:' && parsed.origin ? [`${parsed.origin}/*`] : []; }
      catch { return []; }
    }
  }
  globalThis.QuickdrawGrokProvider = QuickdrawGrokProvider;
  if (typeof module !== 'undefined' && module.exports) module.exports = QuickdrawGrokProvider;
})();
