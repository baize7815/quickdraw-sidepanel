'use strict';

importScripts('core-utils.js', 'storage.js', 'ai-image-utils.js', 'ai-protocol.js', 'ai-task-store.js', 'ai-gpt-provider.js', 'ai-doubao-provider.js', 'ai-grok-provider.js', 'ai-gemini-provider.js', 'ai-router.js');

const assetStore = new QuickdrawStorage();
const aiRouter = globalThis.QuickdrawAIRouter ? new QuickdrawAIRouter({ assetStore }) : null;

const MENU_IMAGE = 'send-image-to-quickdraw';
const MENU_SELECTION = 'send-selection-to-quickdraw';
const MENU_SCREENSHOT = 'capture-page-to-quickdraw';

if (aiRouter && chrome.runtime?.onMessage?.addListener) chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type?.startsWith('qd-ai-')) return false;
  aiRouter.handleMessage(message, sender).then(result => sendResponse(result ?? { ok: true })).catch(error => sendResponse({ ok: false, error: String(error?.message || 'AI 任务处理失败。') }));
  return true;
});

if (aiRouter && chrome.tabs?.onRemoved) chrome.tabs.onRemoved.addListener(tabId => { aiRouter.handleTabRemoved(tabId).catch(error => console.warn('Quickdraw AI tab cleanup failed', error)); });
if (aiRouter && chrome.tabs?.onUpdated) chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => { aiRouter.handleTabUpdated(tabId, changeInfo, tab).catch(error => console.warn('Quickdraw AI tab recovery failed', error)); });

chrome.runtime.onInstalled.addListener(async () => {
  try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); } catch (error) { console.warn(error); }
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_IMAGE, title: '发送图片到 Quickdraw', contexts: ['image'] });
    chrome.contextMenus.create({ id: MENU_SELECTION, title: '发送选中文字到 Quickdraw', contexts: ['selection'] });
    chrome.contextMenus.create({ id: MENU_SCREENSHOT, title: '截取当前可见页面到 Quickdraw', contexts: ['page'] });
  });
});

chrome.action.onClicked.addListener(async tab => {
  if (!tab?.windowId) return;
  try { await chrome.sidePanel.open({ windowId: tab.windowId }); } catch (error) { console.warn(error); }
});

async function ensureImageOrigin(url) {
  if (!/^https?:/i.test(url)) return true;
  const origin = `${new URL(url).origin}/*`;
  return chrome.permissions.request({ origins: [origin] });
}

async function deliver(windowId, payload) {
  const key = `quickdraw_pending_capture:${windowId ?? 'default'}`;
  await chrome.storage.session.set({ [key]: { ...payload, id: crypto.randomUUID(), createdAt: Date.now() } });
  if (windowId != null) await chrome.sidePanel.open({ windowId });
}

// Return a locally composited image to Quickdraw. This does not invoke any remote AI service.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'qd-visual-editor-import') return false;
  (async () => {
    if (sender.id !== chrome.runtime.id || !/^a[\w-]{1,150}$/.test(String(message.assetId || ''))) throw new Error('无效的编辑器回填请求。');
    const record = await assetStore.getAsset(message.assetId);
    if (!record?.blob || !String(record.type || '').startsWith('image/')) throw new Error('图片资源不存在。');
    const windowId = Number.isInteger(message.windowId) && message.windowId >= 0 ? message.windowId : (sender.tab?.windowId ?? null);
    try {
      await deliver(windowId, { kind:'asset', assetId:message.assetId, sourceUrl:'quickdraw-visual-edit' });
      return { ok:true };
    } catch (error) {
      // Some browsers require a direct gesture to reopen the side panel. The
      // session-stored asset remains available when Quickdraw opens manually.
      const key = 'quickdraw_pending_capture:' + (windowId ?? 'default');
      const pending = await chrome.storage.session.get(key);
      if (pending?.[key]?.assetId === message.assetId) return { ok:true, needsOpen:true };
      throw error;
    }
  })().then(sendResponse).catch(error => sendResponse({ok:false,error:String(error?.message||error)}));
  return true;
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const windowId = tab?.windowId;
  try {
    if (info.menuItemId === MENU_IMAGE && info.srcUrl) {
      const granted = await ensureImageOrigin(info.srcUrl);
      await deliver(windowId, granted
        ? { kind: 'image-url', url: info.srcUrl, sourceUrl: tab?.url || '', permissionGranted: true }
        : { kind: 'error', message: '未获得该图片所在网站的读取权限。' });
    } else if (info.menuItemId === MENU_SELECTION && info.selectionText) {
      await deliver(windowId, { kind: 'selection', text: info.selectionText.slice(0, 100_000), sourceUrl: info.pageUrl || tab?.url || '' });
    } else if (info.menuItemId === MENU_SCREENSHOT && windowId != null) {
      const data = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      const blob = await assetStore.dataUrlToBlob(data);
      const assetId = await assetStore.putAsset(blob, { sourceUrl: info.pageUrl || tab?.url || '', capture: 'visible-tab' });
      await deliver(windowId, { kind: 'asset', assetId, sourceUrl: info.pageUrl || tab?.url || '' });
    }
  } catch (error) {
    console.error('Quickdraw capture failed', error);
    try { await deliver(windowId, { kind: 'error', message: '网页内容采集失败，请重试。' }); } catch {}
  }
});
