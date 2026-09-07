'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AI = require('../ai-protocol.js');
require('../ai-task-store.js');
require('../ai-gpt-provider.js');
const Router = require('../ai-router.js');
const GPT = globalThis.QuickdrawGPTProvider;
const Content = require('../gpt-content.js');

function setup() {
  const data = {};
  const storage = {
    get: async key => ({ [key]: structuredClone(data[key]) }),
    set: async value => Object.assign(data, structuredClone(value)),
    remove: async key => { delete data[key]; }
  };
  global.chrome = { runtime: { id: 'lifecycle-test', sendMessage: async () => ({}) }, storage: { local: storage, session: storage } };
  return { data, sender: { id: chrome.runtime.id, frameId: 0, url: 'chrome-extension://lifecycle-test/sidepanel.html' } };
}

function clearTimers(router) { for (const timer of router.timers.values()) clearTimeout(timer); }

test('新 AI 任务从 queued 阶段开始并持久化阶段截止时间', () => {
  const task = AI.createTask({ prompt: '阶段测试', boardId: 'board', sourceInstanceId: 'instance' });
  assert.equal(task.stage, 'queued');
  assert.equal(task.stageStartedAt <= Date.now(), true);
  assert.equal(task.stageDeadlineAt > task.stageStartedAt, true);
  assert.equal(task.deadlineAt, task.stageDeadlineAt);
  assert.equal(AI.stageTimeout('generating'), 1_200_000);
});

test('worker 恢复时先探测页面现场，过期生成任务续接且不重复发送', async () => {
  setup(); const router = new Router(); await router.ready;
  const task = { ...AI.createTask({ prompt: '过期但仍在生成', boardId: 'board', sourceInstanceId: 'instance' }), status: 'waiting', stage: 'generating', tabId: 7, requestFingerprint: 'sent' };
  task.stageDeadlineAt = Date.now() - 1; task.deadlineAt = task.stageDeadlineAt;
  await router.store.upsert(task);
  let probed = 0, resumed = 0;
  router.providers.gpt.probe = async () => { probed += 1; return { active: false, requestFound: true, requestFingerprint: 'sent', requestMessageId: 'message-after-restart', hasReply: false }; };
  router.providers.gpt.resume = async () => { resumed += 1; };
  await router.restore();
  const recovered = await router.store.find(task.taskId);
  assert.equal(probed, 1); assert.equal(resumed, 1); assert.equal(recovered.status, 'waiting'); assert.equal(recovered.stage, 'generating'); assert.equal(recovered.requestMessageId, 'message-after-restart'); assert.equal(recovered.stageDeadlineAt > Date.now(), true);
  clearTimers(router);
});

test('worker 恢复探测到页面仍有活动监听时只续期，不重复调用 resume', async () => {
  setup(); const router = new Router(); await router.ready;
  const task = { ...AI.createTask({ prompt: '页面仍在生成', boardId: 'board', sourceInstanceId: 'instance' }), status: 'waiting', stage: 'generating', tabId: 7, requestFingerprint: 'sent' };
  task.stageDeadlineAt = Date.now() - 1; task.deadlineAt = task.stageDeadlineAt;
  await router.store.upsert(task);
  let resumed = 0;
  router.providers.gpt.probe = async (_task, options) => { assert.equal(options.renewUntil > Date.now(), true); return { active: true, stage: 'generating', requestFound: true, requestFingerprint: 'sent' }; };
  router.providers.gpt.resume = async () => { resumed += 1; };
  await router.restore();
  const recovered = await router.store.find(task.taskId);
  assert.equal(resumed, 0); assert.equal(recovered.status, 'waiting'); assert.equal(recovered.stageDeadlineAt > Date.now(), true);
  clearTimers(router);
});

test('worker 恢复探测不到本次请求时保留准确失联错误且不重发', async () => {
  setup(); const router = new Router(); await router.ready;
  const task = { ...AI.createTask({ prompt: '请求已丢失', boardId: 'board', sourceInstanceId: 'instance' }), status: 'waiting', stage: 'generating', tabId: 7, requestFingerprint: 'sent' };
  task.stageDeadlineAt = Date.now() - 1; task.deadlineAt = task.stageDeadlineAt;
  await router.store.upsert(task);
  let resumed = 0, emitted = [];
  router.emit = async value => { emitted.push(value); };
  router.providers.gpt.probe = async () => ({ active: false, requestFound: false });
  router.providers.gpt.resume = async () => { resumed += 1; };
  await router.restore();
  const failed = await router.store.find(task.taskId);
  assert.equal(resumed, 0); assert.equal(failed, null); assert.match(emitted.at(-1)?.error || '', /超时|未自动重发/);
  clearTimers(router);
});

test('失败任务释放 provider 门禁后，关闭并重新提交可以创建新任务', async () => {
  setup(); const router = new Router(); await router.ready;
  let fail = true, sent = 0;
  router.providers.gpt.prepare = async () => { if (fail) throw new Error('模拟启动失败'); return 7; };
  router.providers.gpt.send = async () => { sent += 1; };
  const payload = { provider: 'gpt', prompt: '第一次', boardId: 'board', sourceInstanceId: 'instance' };
  const first = await router.submit(payload);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(first.ok, true); assert.equal(router.activeByProvider.has('gpt'), false); assert.equal(await router.store.find(first.taskId), null);
  fail = false;
  const second = await router.submit({ ...payload, prompt: '第二次' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(second.ok, true); assert.equal(sent, 1); assert.notEqual(second.taskId, first.taskId);
  await router.cancelTask({ taskId: second.taskId });
  clearTimers(router);
});

test('GPT 阶段事件更新慢上传截止时间，取消会清理任务', async () => {
  setup();
  const router = new Router();
  await router.ready;
  const task = { ...AI.createTask({ prompt: '上传测试', boardId: 'board', sourceInstanceId: 'instance', kind: 'image-edit', inputAssetId: 'input' }), status: 'connecting', stage: 'hydrating', tabId: 7 };
  await router.store.upsert(task);
  router.providers.gpt.accepts = () => true;
  let cleaned = 0;
  router.providers.gpt.cleanup = async () => { cleaned += 1; return true; };
  const webSender = { id: chrome.runtime.id, frameId: 0, url: 'https://chatgpt.com/', tab: { id: 7 } };
  const phase = await router.handleMessage({ type: 'qd-ai-provider-event', taskId: task.taskId, kind: 'phase', stage: 'uploading', progress: 0.4 }, webSender);
  assert.equal(phase.ok, true);
  const uploading = await router.store.find(task.taskId);
  assert.equal(uploading.status, 'sending');
  assert.equal(uploading.stage, 'uploading');
  assert.equal(uploading.stageProgress, 0.4);
  assert.equal(uploading.stageDeadlineAt > Date.now(), true);
  const cancelled = await router.handleMessage({ type: 'qd-ai-cancel', taskId: task.taskId }, { id: chrome.runtime.id, frameId: 0, url: 'chrome-extension://lifecycle-test/sidepanel.html' });
  assert.equal(cancelled.ok, true);
  assert.equal(cleaned, 1);
  assert.equal(await router.store.find(task.taskId), null);
  clearTimers(router);
});

test('恢复 sending 阶段只监听原请求，不自动重发', async () => {
  setup();
  const router = new Router();
  await router.ready;
  const task = { ...AI.createTask({ prompt: '恢复测试', boardId: 'board', sourceInstanceId: 'instance' }), status: 'sending', stage: 'sending', tabId: 7, requestFingerprint: '' };
  task.stageDeadlineAt = Date.now() + 30_000;
  task.deadlineAt = task.stageDeadlineAt;
  await router.store.upsert(task);
  let resumed = 0;
  router.providers.gpt.resume = async () => { resumed += 1; };
  await router.restore();
  assert.equal(resumed, 1);
  assert.equal((await router.store.find(task.taskId)).status, 'sending');
  clearTimers(router);
});

test('上传阶段重启只等待页面继续，不重发；旧定时器不会误杀续期任务', async () => {
  setup();
  const router = new Router(); await router.ready;
  const task = { ...AI.createTask({ prompt: '慢上传', boardId: 'board', sourceInstanceId: 'instance', kind: 'image-edit', inputAssetId: 'input' }), status: 'sending', stage: 'uploading', tabId: 7, stageProgress: 0.2 };
  task.stageDeadlineAt = Date.now() + 30_000; task.deadlineAt = task.stageDeadlineAt;
  await router.store.upsert(task);
  let resumed = 0; router.providers.gpt.resume = async () => { resumed += 1; };
  await router.restore();
  assert.equal(resumed, 0);
  assert.equal((await router.store.find(task.taskId)).stage, 'uploading');
  await router.timeoutTask(task.taskId);
  assert.equal((await router.store.find(task.taskId)).status, 'sending');
  clearTimers(router);
});

test('首次创建页期间重启会续跑原任务且只发送一次', async () => {
  setup(); const router=new Router(); await router.ready;
  const task={...AI.createTask({prompt:'原提示',boardId:'board',sourceInstanceId:'instance'}),status:'connecting',stage:'page-loading'};
  await router.store.upsert(task);
  let prepared=0,sent=0;
  router.providers.gpt.prepare=async()=>{prepared++;router.providers.gpt.tabMeta={tabId:7,ownedByExtension:true,ownerToken:'owner',taskId:task.taskId,groupId:3};return 7;};
  router.providers.gpt.send=async current=>{sent++;assert.equal(current.prompt,'原提示');};
  await router.restore();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(prepared,1);assert.equal(sent,1);
  const stored=await router.store.find(task.taskId);
  assert.equal(stored.stage,'hydrating');assert.equal(stored.tabOwnerToken,'owner');
  clearTimers(router);
});

test('同阶段只有真实进度前进才续期，重复或倒退事件不延长截止时间', async () => {
  setup(); const router = new Router(); await router.ready;
  const task = { ...AI.createTask({ prompt: '进度', boardId: 'board', sourceInstanceId: 'instance', kind: 'image-edit', inputAssetId: 'input' }), status: 'sending', stage: 'uploading', stageProgress: 0.4, tabId: 7 };
  task.stageStartedAt = Date.now() - 16 * 60_000;
  task.stageDeadlineAt = Date.now() + 20_000; task.deadlineAt = task.stageDeadlineAt;
  await router.store.upsert(task); router.providers.gpt.accepts = () => true;
  const sender = { id: chrome.runtime.id, frameId: 0, url: 'https://chatgpt.com/', tab: { id: 7 } };
  await router.handleMessage({ type:'qd-ai-provider-event', taskId:task.taskId, kind:'phase', stage:'uploading', progress:0.4, eventId:'same' }, sender);
  const unchanged = (await router.store.find(task.taskId)).stageDeadlineAt;
  assert.equal(unchanged, task.stageDeadlineAt);
  await router.handleMessage({ type:'qd-ai-provider-event', taskId:task.taskId, kind:'phase', stage:'uploading', progress:0.3, eventId:'lower' }, sender);
  assert.equal((await router.store.find(task.taskId)).stageDeadlineAt, unchanged);
  await router.handleMessage({ type:'qd-ai-provider-event', taskId:task.taskId, kind:'phase', stage:'uploading', progress:0.5, eventId:'higher' }, sender);
  const progressed=(await router.store.find(task.taskId)).stageDeadlineAt;
  assert.equal(progressed > unchanged, true);
  await router.handleMessage({ type:'qd-ai-provider-event', taskId:task.taskId, kind:'phase', stage:'uploading', progress:0.5, eventId:'repeat-after-progress' }, sender);
  assert.equal((await router.store.find(task.taskId)).stageDeadlineAt,progressed);
  await router.handleMessage({ type:'qd-ai-provider-event', taskId:task.taskId, kind:'send-confirmed', requestFingerprint:'sent-once', baselineHashes:[], eventId:'sent-after-long-upload' }, sender);
  assert.equal((await router.store.find(task.taskId)).status,'waiting');
  clearTimers(router);
});

test('扩展自建 tab 仅在持久导入 ACK 后关闭，取消重复调用幂等', async () => {
  const { data, sender } = setup();
  const assets = { putAsset: async () => 'output', deleteAsset: async () => {} };
  const router = new Router({ assetStore: assets }); await router.ready;
  const task = { ...AI.createTask({ prompt:'图片', boardId:'board', sourceInstanceId:'instance', kind:'image-edit', inputAssetId:'input' }), status:'waiting', stage:'generating', tabId:7, tabOwned:true, tabOwnerToken:'owner' };
  task.stageDeadlineAt=Date.now()+30_000;task.deadlineAt=task.stageDeadlineAt;
  await router.store.upsert(task); router.providers.gpt.accepts=()=>true;
  router.providers.gpt.materializeImage=async()=>({blob:new Blob(['x']),type:'image/png',bytes:1,width:64,height:64,imageUrl:'https://foo.oaiusercontent.com/a.png'});
  let cleaned=0;router.providers.gpt.cleanup=async()=>{cleaned++;return true;};
  const web={id:chrome.runtime.id,frameId:0,url:'https://chatgpt.com/',tab:{id:7}};
  await router.handleMessage({type:'qd-ai-provider-event',taskId:task.taskId,kind:'image-reply',phase:'complete',imageUrl:'https://foo.oaiusercontent.com/a.png'},web);
  assert.equal(cleaned,0);
  await router.handleMessage({type:'qd-ai-claim-import',taskId:task.taskId,ownerId:'instance'},sender);
  data['quickdraw_v2_file:board']={aiTaskReceipts:{[task.taskId]:{taskId:task.taskId}}};
  await router.handleMessage({type:'qd-ai-mark-imported',taskId:task.taskId,ownerId:'instance',targetBoardId:'board'},sender);
  assert.equal(cleaned,1);
  const first=await router.handleMessage({type:'qd-ai-cancel',taskId:'missing'},sender);
  const second=await router.handleMessage({type:'qd-ai-cancel',taskId:'missing'},sender);
  assert.equal(first.ok&&second.ok&&second.alreadyFinished,true);
  clearTimers(router);
});

test('附件必须有明确完成信号，文件名或刚出现的非 busy chip 不算完成', () => {
  const marker = (state='', text='') => ({ textContent:text, className:'attachment', getAttribute:name=>name==='data-state'?state:'', querySelector:()=>null });
  assert.equal(Content.attachmentIsComplete(marker('', 'quickdraw-source.png')), false);
  assert.equal(Content.attachmentIsComplete(marker('', 'quickdraw-source.png preview')), false);
  assert.equal(Content.attachmentIsComplete(marker('uploading', '50%')), false);
  assert.equal(Content.attachmentIsComplete(marker('uploaded', 'quickdraw-source.png')), true);
  assert.equal(Content.attachmentIsComplete(marker('failed', '上传失败')), false);
});

test('本次新预览解码完成且发送可用可作为就绪证据，processing 与旧预览不可满足', () => {
  const preview={complete:true,naturalWidth:256,naturalHeight:256,currentSrc:'blob:https://chatgpt.com/new',getClientRects:()=>[{}],getAttribute:()=>'',className:''};
  const processing={textContent:'处理中',className:'attachment',getAttribute:name=>name==='data-state'?'processing':'',querySelector:()=>null};
  assert.equal(Content.attachmentReadyEvidence(null,preview,true),true);
  assert.equal(Content.attachmentReadyEvidence(processing,preview,true),false);
  assert.equal(Content.attachmentReadyEvidence(null,preview,false),false);
  const baseline=new Map([[preview,Content.attachmentPreviewState(preview)]]);
  assert.equal(Content.findFreshAttachmentPreview([preview],baseline),null);
  preview.currentSrc='blob:https://chatgpt.com/newer';
  assert.equal(Content.findFreshAttachmentPreview([preview],baseline),preview);
});

test('无显式 ready 属性时新预览稳定后会填入原提示并只点击发送一次', async () => {
  const saved={document:global.document,location:global.location,chrome:global.chrome,MutationObserver:global.MutationObserver,DataTransfer:global.DataTransfer,File:global.File,HTMLTextAreaElement:global.HTMLTextAreaElement,HTMLInputElement:global.HTMLInputElement,InputEvent:global.InputEvent,getComputedStyle:global.getComputedStyle};
  let previewVisible=false,sendCount=0;const events=[],users=[];
  class Textarea {constructor(){this._value='';this.offsetParent={};}get value(){return this._value;}set value(v){this._value=String(v);}focus(){}dispatchEvent(){}getAttribute(){return'';}getClientRects(){return[{}];}}
  const promptInput=new Textarea();
  const uploadInput={files:[],offsetParent:{},closest:()=>form,dispatchEvent:event=>{if(event.type==='change')previewVisible=true;},getAttribute:()=>'',getClientRects:()=>[{}]};
  const preview={complete:true,naturalWidth:256,naturalHeight:256,currentSrc:'blob:https://chatgpt.com/upload',src:'blob:https://chatgpt.com/upload',alt:'',className:'',getAttribute:()=>'',getClientRects:()=>[{}]};
  const send={disabled:false,hidden:false,offsetParent:{},getAttribute:()=>'',getClientRects:()=>[{}],click:()=>{sendCount++;users.push({innerText:promptInput.value,textContent:promptInput.value,offsetParent:{},getAttribute:()=>'',getClientRects:()=>[{}]});}};
  const form={querySelectorAll:selector=>selector==='img'&&previewVisible?[preview]:[]};
  global.HTMLTextAreaElement=Textarea;global.HTMLInputElement=class{};global.InputEvent=class{constructor(type){this.type=type;}};
  global.DataTransfer=class{constructor(){this.files=[];this.items={add:value=>this.files.push(value)};}};global.File=undefined;
  global.getComputedStyle=()=>({display:'block',visibility:'visible'});global.location={origin:'https://chatgpt.com',href:'https://chatgpt.com/'};
  global.MutationObserver=class{observe(){}disconnect(){}};
  global.document={body:{},querySelector:selector=>selector==='#prompt-textarea'?promptInput:selector==='input[type="file"]'?uploadInput:null,querySelectorAll:selector=>{
    if(selector==='img')return previewVisible?[preview]:[];
    if(selector==='[data-message-author-role="user"]')return users;
    if(selector.includes('send-button'))return[send];
    return[];
  }};
  global.chrome={runtime:{id:'test-extension',sendMessage:async message=>{events.push(message);},onMessage:{addListener(){}}}};
  try{
    await Content.start('preview-task','图片编辑助手。\n任务编号：preview-task。\n用户需求：线稿上色','image-edit','data:image/png;base64,iVBORw0KGgoAAAAA');
    assert.match(promptInput.value,/线稿上色/);assert.equal(sendCount,1);
    assert.equal(events.filter(event=>event.kind==='send-confirmed').length,1);
  }finally{
    const record=Content.active.get('preview-task');if(record?.pollTimer)clearTimeout(record.pollTimer);record?.observer?.disconnect?.();Content.active.delete('preview-task');
    Object.assign(global,saved);
  }
});

test('上传年龄超过十五分钟仍以最近真实进展为准，长期 busy 无进展会停滞', () => {
  const uploadStartedAt=1_000;
  const afterSixteenMinutes=uploadStartedAt+16*60_000;
  assert.equal(Content.uploadHasStalled(afterSixteenMinutes-1_000,afterSixteenMinutes),false);
  assert.equal(Content.uploadHasStalled(uploadStartedAt,uploadStartedAt+180_001),true);
});

test('旧任务 owner token 不能关闭已重新绑定的新任务 tab，用户 tab 永不关闭', async () => {
  const { data } = setup();
  let removed=0;
  chrome.tabs={remove:async()=>{removed++;},get:async()=>({id:7,url:'https://chatgpt.com/'})};
  data.quickdraw_ai_gpt_tab_id_v1={tabId:7,ownedByExtension:true,ownerToken:'new',taskId:'new'};
  const provider=new GPT();
  assert.equal(await provider.cleanup({tabId:7,tabOwned:true,tabOwnerToken:'old'}),false);
  assert.equal(await provider.cleanup({tabId:7,tabOwned:false,tabOwnerToken:''}),false);
  assert.equal(removed,0);
});

test('fresh worker 会先读 session 所有权再清理 page-loading 遗留 tab', async () => {
  const { data }=setup();let removed=0;
  data.quickdraw_ai_gpt_tab_id_v1={tabId:7,ownedByExtension:true,ownerToken:'owner',taskId:'task-a'};
  chrome.tabs={remove:async()=>{removed++;},get:async()=>({id:7,url:'https://chatgpt.com/'})};
  const router=new Router();await router.ready;
  router.providers.gpt.tabMeta=null;router.providers.gpt.tabId=null;
  const cleaned=await router.cleanupOwnedTab({taskId:'task-a',provider:'gpt',tabId:null,tabOwned:false,tabOwnerToken:''});
  assert.equal(cleaned,true);assert.equal(removed,1);
});

test('首次没有 GPT 标签页时会等待临时空白页导航完成，不误报登录失败', async()=>{
  setup(); let reads=0,created=null,grouped=0;
  chrome.tabs={
    query:async()=>[],
    create:async args=>{created=args;return{id:7,pendingUrl:args.url,status:'loading',windowId:args.windowId||1};},
    group:async()=>{grouped++;return 3;},
    get:async()=>{
      reads+=1;
      return reads===1 ? {id:7,url:'',pendingUrl:'https://chatgpt.com/',status:'loading',windowId:1} : {id:7,url:'https://chatgpt.com/',status:'complete',windowId:1};
    },
    update:async()=>{}
  };
  const provider=new GPT();
  assert.equal(await provider.prepare({sourceWindowId:1,taskId:'first-tab'}),7);
  assert.deepEqual(created,{url:'https://chatgpt.com/',active:false,windowId:1});assert.equal(grouped,1);assert.equal(reads>=2,true);
});

test('认证域跳转暂停并保留 owned tab，登录完成的 tab 更新自动继续一次', async()=>{
  const {data}=setup();const router=new Router();await router.ready;
  const task={...AI.createTask({prompt:'登录后继续原任务',boardId:'board',sourceInstanceId:'instance',kind:'image-edit',inputAssetId:'input'}),status:'connecting',stage:'page-loading'};
  await router.store.upsert(task);router.activeByProvider.set('gpt',task.taskId);
  router.providers.gpt.tabMeta={tabId:7,ownedByExtension:true,ownerToken:'owner',taskId:task.taskId,groupId:3};
  const authError=new Error('需要认证');authError.code='auth-required';authError.tabId=7;
  router.providers.gpt.prepare=async()=>{throw authError;};
  await router.runProvider(task);
  let paused=await router.store.find(task.taskId);
  assert.equal(paused.status,'paused');assert.equal(paused.prompt,task.prompt);assert.equal(paused.inputAssetId,'input');assert.equal(paused.tabId,7);assert.equal(paused.tabOwned,true);
  let sent=0;chrome.tabs={get:async()=>({id:7,url:'https://chatgpt.com/',status:'complete'}),remove:async()=>{}};
  router.providers.gpt.send=async current=>{sent++;assert.equal(current.prompt,task.prompt);};
  await router._handleTabUpdated(7,{status:'complete'},{id:7,url:'https://chatgpt.com/',status:'complete'});
  assert.equal(sent,1);assert.equal((await router.store.find(task.taskId)).status,'connecting');
  await router._handleTabUpdated(7,{status:'complete'},{id:7,url:'https://chatgpt.com/',status:'complete'});
  assert.equal(sent,1);clearTimers(router);
});

test('迟到的认证事件不能把已发送任务暂停后再次发送',async()=>{
  setup();const router=new Router();await router.ready;
  const task={...AI.createTask({prompt:'只发一次',boardId:'board',sourceInstanceId:'instance'}),status:'waiting',stage:'generating',tabId:7,requestFingerprint:'sent'};
  task.stageDeadlineAt=Date.now()+30_000;task.deadlineAt=task.stageDeadlineAt;await router.store.upsert(task);router.providers.gpt.accepts=()=>true;
  const result=await router.handleMessage({type:'qd-ai-provider-event',taskId:task.taskId,kind:'needs-attention',code:'auth-required',error:'late'}, {id:chrome.runtime.id,frameId:0,url:'https://chatgpt.com/',tab:{id:7}});
  assert.equal(result.stale,true);assert.equal((await router.store.find(task.taskId)).status,'waiting');clearTimers(router);
});

test('暂停任务取消会清 owned tab 和输入资产，重复取消无副作用',async()=>{
  setup();let deleted=0,cleaned=0;const router=new Router({assetStore:{deleteAsset:async()=>{deleted++;}}});await router.ready;
  const task={...AI.createTask({prompt:'取消',boardId:'board',sourceInstanceId:'instance',kind:'image-edit',inputAssetId:'input'}),status:'paused',pauseReason:'auth-required',tabId:7,tabOwned:true,tabOwnerToken:'owner'};
  await router.store.upsert(task);router.providers.gpt.cleanup=async()=>{cleaned++;return true;};
  const first=await router.cancelTask({taskId:task.taskId}),second=await router.cancelTask({taskId:task.taskId});
  assert.equal(first.ok&&second.ok,true);assert.equal(cleaned,1);assert.equal(deleted,1);
});

test('认证暂停跨 worker 恢复仍保留，并阻止新任务抢占其 owned tab',async()=>{
  setup();const router=new Router();await router.ready;
  const task={...AI.createTask({prompt:'保留',boardId:'board',sourceInstanceId:'instance'}),status:'paused',pauseReason:'auth-required',tabId:7,tabOwned:true,tabOwnerToken:'owner'};
  await router.store.upsert(task);await router.restore();
  const kept=await router.store.find(task.taskId);assert.equal(kept.status,'paused');assert.equal(kept.tabOwnerToken,'owner');
  await router.timeoutTask(task.taskId);assert.equal((await router.store.find(task.taskId)).status,'paused');
  const submit=await router.submit({prompt:'另一个任务',boardId:'board',sourceInstanceId:'other'});
  assert.equal(submit.ok,false);assert.match(submit.error,/继续原任务/);clearTimers(router);
});

test('GPT 认证事件会暂停任务并保留原提示与标签页归属', async()=>{
  setup(); const router=new Router(); await router.ready;
  const task={...AI.createTask({prompt:'保留这段需求',boardId:'board',sourceInstanceId:'instance'}),status:'connecting',stage:'hydrating',tabId:7,tabOwned:true,tabOwnerToken:'owner'};
  task.stageDeadlineAt=Date.now()+30_000; task.deadlineAt=task.stageDeadlineAt;
  await router.store.upsert(task); router.activeByProvider.set('gpt',task.taskId); router.providers.gpt.accepts=()=>true;
  let stopped=0,cleaned=0; router.providers.gpt.stop=async()=>{stopped++;}; router.providers.gpt.cleanup=async()=>{cleaned++;};
  const sender={id:chrome.runtime.id,frameId:0,url:'https://chatgpt.com/auth/login',tab:{id:7}};
  const result=await router.handleMessage({type:'qd-ai-provider-event',taskId:task.taskId,kind:'needs-attention',code:'auth-required',error:'请登录后继续。'},sender);
  const paused=await router.store.find(task.taskId);
  assert.equal(result.ok,true); assert.equal(paused.status,'paused'); assert.equal(paused.prompt,task.prompt); assert.equal(paused.tabId,7); assert.equal(paused.tabOwned,true); assert.equal(paused.pauseReason,'auth-required');
  assert.equal(stopped,1); assert.equal(cleaned,0); assert.equal(router.activeByProvider.has('gpt'),false);
  clearTimers(router);
});

test('暂停任务恢复会沿用任务提示并重新进入 GPT 处理', async()=>{
  setup(); const router=new Router(); await router.ready;
  const task={...AI.createTask({prompt:'恢复原提示',boardId:'board',sourceInstanceId:'instance'}),status:'paused',pauseReason:'auth-required',tabId:7,tabOwned:true,tabOwnerToken:'owner'};
  await router.store.upsert(task);
  chrome.tabs={get:async()=>({id:7,url:'https://chatgpt.com/auth/login',pendingUrl:'https://chatgpt.com/auth/login'})};
  let sent=null; router.providers.gpt.ensureTab=async()=>7; router.providers.gpt.getTabMeta=()=>({tabId:7,ownedByExtension:true,ownerToken:'owner',groupId:3,groupError:''}); router.providers.gpt.send=async value=>{sent=value;};
  const result=await router.resumePausedTask({taskId:task.taskId});
  const resumed=await router.store.find(task.taskId);
  assert.equal(result.ok,true); assert.equal(resumed.status,'connecting'); assert.equal(resumed.prompt,task.prompt); assert.equal(resumed.pauseReason,''); assert.equal(sent.prompt,task.prompt);
  clearTimers(router);
});

test('标签页分组失败会保留错误信息供任务界面展示', async()=>{
  setup();
  chrome.tabs={query:async()=>[],create:async()=>({id:8,url:'https://chatgpt.com/',windowId:1}),group:async()=>{throw new Error('group denied');}};
  const provider=new GPT(); await provider.ensureTab(1);
  assert.equal(provider.getTabMeta().groupId,null); assert.equal(provider.getTabMeta().groupError,'group denied');
});
