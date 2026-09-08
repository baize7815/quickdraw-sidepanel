'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AI = require('../ai-protocol.js');
require('../ai-task-store.js');
require('../ai-gpt-provider.js');
require('../ai-doubao-provider.js');
const GrokProvider = require('../ai-grok-provider.js');
const Router = require('../ai-router.js');
const Content = require('../grok-content.js');

function setup() {
  const data = {};
  const storage = { get: async key => ({ [key]: structuredClone(data[key]) }), set: async value => Object.assign(data, structuredClone(value)), remove: async key => { delete data[key]; } };
  global.chrome = { runtime: { id: 'grok-test', sendMessage: async () => ({}) }, storage: { local: storage, session: storage } };
  return { data, sender: { id: 'grok-test', frameId: 0, url: 'chrome-extension://grok-test/sidepanel.html' } };
}
const clearTimers = router => { for (const timer of router.timers.values()) clearTimeout(timer); };

test('Grok 编辑器出现但文件控件尚未展开时已就绪，并能经加号打开上传控件', async () => {
  const saved={document:global.document,location:global.location,getComputedStyle:global.getComputedStyle,chrome:global.chrome};
  const editor={tagName:'TEXTAREA',type:'',value:'',offsetParent:{},getAttribute:()=>'',getClientRects:()=>[{}]};
  const file={tagName:'INPUT',type:'file',offsetParent:{},getAttribute:()=>'',getClientRects:()=>[{}]};
  let expanded=false;
  const plus={tagName:'BUTTON',textContent:'+',innerText:'+',offsetParent:{},disabled:false,className:'',outerHTML:'<button>+</button>',getAttribute:()=>'',getClientRects:()=>[{}],click:()=>{expanded=true;}};
  global.location={href:'https://grok.com/',origin:'https://grok.com'};global.getComputedStyle=()=>({display:'block',visibility:'visible'});
  global.chrome={runtime:{id:'grok-test'}};
  global.document={querySelector:selector=>selector==='input[type="file"]'&&expanded?file:null,querySelectorAll:selector=>{
    if(selector==='textarea')return[editor];if(selector==='input')return expanded?[file]:[];if(selector==='input[type="file"]')return expanded?[file]:[];
    if(selector.includes('button'))return[plus];return[];
  }};
  try {
    assert.deepEqual(Content.handle({type:'qd-ai-grok-command',taskId:'ready-task',action:'readiness'},{id:'grok-test'}),{ok:true,ready:true,auth:false});
    assert.equal(await Content.openAttachmentInput(editor,1_000),file);
  } finally {Object.assign(global,saved);}
});

test('Grok 使用独立站点、认证域、标签页和消息通道且仅接图片编辑', () => {
  setup(); const provider = new GrokProvider(); const config = AI.provider('grok');
  assert.equal(config.enabled, true); assert.equal(config.capabilities.image, true); assert.equal(config.capabilities.mermaid, false);
  assert.equal(provider.getTabKey(), 'quickdraw_ai_grok_tab_id_v1'); assert.equal(provider.getRootUrl(), 'https://grok.com/');
  assert.equal(provider.getContentScript(), 'grok-content.js'); assert.equal(provider.getCommandType(), 'qd-ai-grok-command');
  assert.equal(provider.isAllowedUrl('https://grok.com/c/abc'), true); assert.equal(provider.isAllowedUrl('https://evil.grok.com/'), false);
  assert.equal(provider.isAllowedAuthUrl('https://accounts.x.ai/sign-in?redirect=grok-com'), true);
  assert.equal(AI.buildGrokImagePrompt('', 'task-grok'), '');
});

test('Grok 多图任务单次发送、结果持久化并仅在画布 receipt ACK 后关闭 owned tab', async () => {
  const { data } = setup();
  const records = new Map([['left',{blob:new Blob(['left'],{type:'image/png'})}],['right',{blob:new Blob(['right'],{type:'image/png'})}]]);
  const assets = { getAsset: async id => records.get(id), putAsset: async blob => { records.set('out',{blob}); return 'out'; }, deleteAsset: async id => records.delete(id) };
  const router = new Router({assetStore:assets}); await router.ready; const provider=router.providers.grok;
  let sent=0,closed=0;
  provider.prepare=async()=>{provider.tabMeta={tabId:31,ownedByExtension:true,ownerToken:'grok-owner',taskId:'x',groupId:4};return 31;};
  provider.send=async task=>{sent++;assert.deepEqual(task.inputAssetIds,['left','right']);};provider.accepts=()=>true;
  provider.materializeImage=async()=>({blob:new Blob(['result'],{type:'image/png'}),type:'image/png',bytes:6,width:512,height:512,imageUrl:'https://grok.com/assets/result.png'});
  provider.cleanup=async task=>{if(task.tabOwned&&task.tabOwnerToken==='grok-owner')closed++;return true;};
  const submitted=await router.submit({provider:'grok',kind:'image-edit',prompt:'',boardId:'board',sourceInstanceId:'instance',inputAssets:[{assetId:'left',order:0},{assetId:'right',order:1}]});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(sent,1);
  const web={id:'grok-test',frameId:0,url:'https://grok.com/',tab:{id:31}};
  await router.handleMessage({type:'qd-ai-provider-event',taskId:submitted.taskId,kind:'send-confirmed',requestFingerprint:'grok-request',baselineHashes:[]},web);
  await router.handleMessage({type:'qd-ai-provider-event',taskId:submitted.taskId,kind:'image-reply',phase:'complete',imageDataUrl:'data:image/png;base64,AAAA',imageUrl:'https://grok.com/assets/result.png'},web);
  let task=await router.store.find(submitted.taskId);assert.equal(task.status,'image-ready');assert.equal(closed,0);
  await router.claimImport({taskId:task.taskId,ownerId:'instance'});data['quickdraw_v2_file:board']={aiTaskReceipts:{[task.taskId]:{taskId:task.taskId}}};
  await router.markImported({taskId:task.taskId,ownerId:'instance',targetBoardId:'board'});assert.equal(closed,1);clearTimers(router);
});

test('Grok 任务固定 provider，切换默认值不会接收豆包标签页旧事件', async()=>{
  setup();const router=new Router();await router.ready;const task=AI.createTask({provider:'grok',kind:'image-edit',prompt:'x',boardId:'b',sourceInstanceId:'i',inputAssetId:'a'});Object.assign(task,{status:'waiting',tabId:8,requestFingerprint:'r'});await router.store.upsert(task);
  router.providers.grok.accepts=sender=>sender?.url==='https://grok.com/';
  const result=await router.handleProviderEvent({taskId:task.taskId,kind:'image-reply',phase:'complete',imageUrl:'https://grok.com/x.png'},{id:'grok-test',frameId:0,url:'https://www.doubao.com/chat/',tab:{id:8}});
  assert.equal(result.ok,false);assert.equal((await router.store.find(task.taskId)).status,'waiting');clearTimers(router);
});
