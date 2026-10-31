(() => {
  'use strict';
  const AI = globalThis.QuickdrawAI;
  const Parent = globalThis.QuickdrawGrokProvider || (typeof require === 'function' ? require('./ai-grok-provider.js') : null);
  class QuickdrawGeminiProvider extends Parent {
    getLastConversationKey(){return 'quickdraw_ai_gemini_previous_owned_conversation_v1';}
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
    async ensureTab(sourceWindowId,task=null){
      const activeMeta=await this.loadTabMeta();
      if(activeMeta?.ownedByExtension&&activeMeta.taskId&&activeMeta.taskId!==task?.taskId){
        // A previous task's tab must never be inherited implicitly. The
        // explicit recent-conversation record below is the only reuse gate.
        try{await chrome.storage.session.remove(this.getTabKey());}catch{}
        this.tabMeta=null;this.tabId=null;
      }
      // Reuse is explicit and restricted to a previous, successful tab that
      // Quickdraw itself created. Do not search arbitrary user conversations.
      if(task?.reuseGeminiTab===true&&task.boardId&&globalThis.chrome?.storage?.local){
        const key=this.getLastConversationKey();
        let previous=null;
        try{previous=(await chrome.storage.local.get(key))?.[key];}catch{}
        const recent=previous&&Number.isInteger(previous.tabId)&&previous.tabId>=0
          &&previous.boardId===task.boardId&&Number.isInteger(previous.savedAt)&&Date.now()-previous.savedAt<7*24*3600*1000
          &&(!Number.isInteger(sourceWindowId)||sourceWindowId===previous.windowId);
        if(recent){
          let tab=null;
          try{tab=await chrome.tabs.get(previous.tabId);}catch{}
          if(tab?.id===previous.tabId&&tab.status==='complete'&&this.isAllowedUrl(tab.url)
              &&tab.windowId===previous.windowId){
            await this.saveTabMeta({tabId:tab.id,windowId:tab.windowId,boardId:task.boardId,ownedByExtension:true,ownerToken:this.randomToken(),taskId:task.taskId||null,groupId:null});
            return tab.id;
          }
        }
      }
      const id=await super.ensureTab(sourceWindowId,task);
      const meta=await this.loadTabMeta();
      if(meta?.ownedByExtension&&task?.boardId)await this.saveTabMeta({...meta,boardId:task.boardId});
      return id;
    }
    // Gemini chats are user-visible artifacts. Never auto-group or close them.
    async groupOwnedTab(tabId) { return this.loadTabMeta(); }
    async cleanup(task) {
      // Background cleanup/import must release ownership, not remove the tab.
      const meta=await this.loadTabMeta();
      if(task?.outputAssetId&&task.tabOwned===true&&Number.isInteger(task.tabId)
        &&meta?.ownedByExtension&&meta.tabId===task.tabId&&task.tabOwnerToken===meta.ownerToken){
        try{
          const tab=await chrome.tabs.get(task.tabId);
          if(this.isAllowedUrl(tab.url)){
            await chrome.storage.local.set({[this.getLastConversationKey()]:{
              tabId:tab.id,windowId:tab.windowId,boardId:task.boardId,
              savedAt:Date.now(),sourceTaskId:task.taskId
            }});
          }
        }catch{}
      }
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
