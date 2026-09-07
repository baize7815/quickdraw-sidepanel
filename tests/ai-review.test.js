'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const AI = require('../ai-protocol.js');
require('../ai-task-store.js');
const GPT = require('../ai-gpt-provider.js');
const Router = require('../ai-router.js');
require('../core-utils.js');
require('../vector-utils.js');
require('../editing-tools.js');
require('../sidepanel.js');

function setup() {
  const data = {};
  const storage = { get: async key => ({ [key]: structuredClone(data[key]) }), set: async value => Object.assign(data, structuredClone(value)) };
  global.chrome = { runtime: { id: 'test-extension', sendMessage: async () => ({}) }, storage: { local: storage, session: storage } };
  const sender = { id: chrome.runtime.id, url: 'chrome-extension://test-extension/sidepanel.html?file=board-a', frameId: 0 };
  const router = new Router();
  return { router, sender, data, cleanup: () => { for (const timer of router.timers.values()) clearTimeout(timer); } };
}
const input = { prompt: '外卖流程图', boardId: 'board-a', sourceInstanceId: 'instance-a', provider: 'gpt', sourceBoardEpoch: 1 };

test('全幅画板可提交；并发提交只启动一个任务；网页不能提交特权命令', async () => {
  const {router,sender,cleanup}=setup();await router.ready;
  let runs=0;router.runProvider=async()=>{runs++;};
  try {
    const replies=await Promise.all([1,2].map(()=>router.handleMessage({type:'qd-ai-submit',payload:input},sender)));
    assert.equal(replies.filter(r=>r.ok).length,1);assert.equal(runs,1);
    assert.equal((await router.handleMessage({type:'qd-ai-list-tasks'},{...sender,url:'https://chatgpt.com/'})).ok,false);
    assert.equal(router.isExtensionPageSender({...sender,url:'chrome-extension://other/sidepanel.html'}),false);
  } finally {cleanup();}
});

test('两实例并发领取仅一方成功；持久保存之前不能确认导入', async()=>{
  const {router,sender,data,cleanup}=setup();await router.ready;
  const task={...AI.createTask(input),status:'ready'};await router.store.upsert(task);
  try {
    const claims=await Promise.all(['a','b'].map(ownerId=>router.handleMessage({type:'qd-ai-claim-import',taskId:task.taskId,ownerId},sender)));
    assert.equal(claims.filter(r=>r.ok).length,1);
    const ownerId=claims[0].ok?'a':'b';
    const message={type:'qd-ai-mark-imported',taskId:task.taskId,ownerId,targetBoardId:'board-a'};
    assert.equal((await router.handleMessage(message,sender)).ok,false);
    data['quickdraw_v2_file:board-a']={aiTaskReceipts:{[task.taskId]:{createdAt:Date.now()}}};
    assert.equal((await router.handleMessage(message,sender)).ok,true);
    assert.equal((await router.handleMessage(message,sender)).ok,true);
    assert.equal((await router.handleMessage({type:'qd-ai-claim-import',taskId:task.taskId,ownerId},sender)).ok,false);
  } finally {cleanup();}
});

test('旧事件不能覆盖已完成回复；超长原回复不允许先截断再导入', async()=>{
  const {router,cleanup}=setup();await router.ready;
  const task={...AI.createTask(input),status:'waiting',tabId:7};await router.store.upsert(task);
  const sender={id:chrome.runtime.id,frameId:0,url:'https://chatgpt.com/c/test',tab:{id:7,url:'https://chatgpt.com/c/test'}};
  const event={type:'qd-ai-provider-event',taskId:task.taskId,kind:'reply',phase:'complete',text:'flowchart TD\nA --> B'};
  try {
    await Promise.all([router.handleMessage(event,sender),router.handleMessage({...event,kind:'ready'},sender)]);
    assert.equal((await router.store.find(task.taskId)).status,'ready');
    const other={...AI.createTask(input),status:'waiting',tabId:7};await router.store.upsert(other);
    await router.handleMessage({...event,taskId:other.taskId,text:'flowchart TD\nA --> B\n'+' '.repeat(AI.MAX_REPLY_LENGTH)},sender);
    assert.equal(await router.store.find(other.taskId),null);
    assert.equal((await router.handleMessage(event,{...sender,frameId:2})).ok,false);
  } finally {cleanup();}
});

test('恢复只续接等待中的任务；发送中及导入中不会重新发送或自动重导', async()=>{
  const {router,cleanup}=setup();await router.ready;
  const tasks=['waiting','sending','importing','connecting'].map(status=>({...AI.createTask(input),status,tabId:7,requestFingerprint:'x',deadlineAt:Date.now()+10000}));
  for(const task of tasks)await router.store.upsert(task);
  let resumed=0;router.providers.gpt.resume=async()=>{resumed++;};
  try {
    await router.restore();assert.equal(resumed,1);
    for(const task of tasks){
      const stored=await router.store.find(task.taskId);
      if(task.status==='waiting')assert.equal(stored.status,'waiting');
      else if(task.status==='importing')assert.equal(stored.status,'pending');
      else assert.equal(stored,null);
    }
  } finally {cleanup();}
});

test('GPT 专用页在来源窗口后台创建，准备发送不会聚焦窗口', async()=>{
  setup();let created;let activated=false;
  chrome.tabs={create:async args=>{created=args;return{id:9,...args};},get:async()=>({id:9,url:'https://chatgpt.com/'}),update:async(_,args)=>{if(args.active)activated=true;}};
  const provider=new GPT();await provider.ensureTab(42);
  assert.deepEqual(created,{url:'https://chatgpt.com/',active:false,windowId:42});assert.equal(activated,false);
  for(const url of ['http://chatgpt.com/','https://other.chatgpt.com/','https://chatgpt.com:444/'])assert.equal(AI.isAllowedGPTUrl(url),false);
});

test('旧历史自动清理，结束后不保存需求和回复；进行中与待导入结果保留',async()=>{
  const {router,data,cleanup}=setup();await router.ready;
  const statuses=['waiting','ready','pending','failed','needs-attention','imported'];
  const records=statuses.map(status=>({...AI.createTask(input),status,rawReply:'私有回复内容'}));
  data.quickdraw_ai_tasks_v1=records;
  try{
    await router.store.pruneHistory();
    assert.deepEqual(data.quickdraw_ai_tasks_v1.map(t=>t.status),['waiting','ready','pending']);
    for(const status of ['failed','needs-attention','imported']){
      const active=AI.createTask(input);await router.store.upsert(active);
      const result=await router.store.upsert({...active,status,rawReply:'临时错误'});
      assert.equal(result.status,status);
      assert.equal(data.quickdraw_ai_tasks_v1.some(t=>t.taskId===active.taskId),false);
    }
  }finally{cleanup();}
});

// Minimal DOM-shaped fixture, no browser process or network. It reproduces the
// detached-clone textContent behavior that flattened GPT's plain-text reply.
class Element {
  constructor(tag,children=[]){this.tag=tag;this.children=[];this.disabled=false;for(const child of children)this.appendChild(typeof child==='string'?new TextNode(child):child);}
  appendChild(child){child.parent=this;this.children.push(child);return child;}
  get textContent(){return this.children.map(x=>x.textContent).join('');}
  getClientRects(){return[{}];}
  cloneNode(){return new Element(this.tag,this.children.map(x=>x.cloneNode()));}
  querySelectorAll(selectors){const tags=selectors.split(',').map(x=>x.trim());const result=[];for(const c of this.children){if(tags.includes(c.tag))result.push(c);result.push(...c.querySelectorAll(selectors));}return result;}
  querySelector(s){return this.querySelectorAll(s)[0]||null;}
  remove(){if(this.parent)this.parent.children.splice(this.parent.children.indexOf(this),1);}
  replaceWith(node){const p=this.parent;if(p){node.parent=p;p.children.splice(p.children.indexOf(this),1,node);}}
  closest(){return this.turn||this;}
  compareDocumentPosition(){return 4;}
}
class TextNode extends Element {constructor(text){super('#text');this.text=text;}get textContent(){return this.text;}cloneNode(){return new TextNode(this.text);}}
function contentFixture(options={}){
  let now=0,id=0;const timers=new Map(),events=[];const flags={busy:false,complete:false};let observer;
  const user=new Element('div',['request']);
  const assistant=new Element('div',[new Element('p',['flowchart TD',new Element('br'),'A[用户端]',new Element('br'),'B[商家端]',new Element('br'),'A --> B'])]);
  const button=new Element('button');assistant.turn={querySelector:()=>flags.complete?button:null};
  const document={body:new Element('body'),createTextNode:text=>new TextNode(text),querySelectorAll:selector=>{
    if(selector==='[data-message-author-role="assistant"]')return[assistant];
    if(selector==='[data-message-author-role="user"]')return[user];
    if(selector==='[data-testid="send-button"]')return flags.busy?[]:[button];
    if(selector==='[data-testid*="stop"]')return flags.busy?[button]:[];
    return[];
  }};
  const context={module:{exports:{}},document,location:{origin:'https://chatgpt.com',href:options.href||'https://chatgpt.com/'},URL,Date:{now:()=>now},Math,
    setTimeout:(fn,delay)=>{timers.set(++id,{fn,due:now+delay});return id;},clearTimeout:key=>timers.delete(key),
    MutationObserver:class{constructor(fn){observer=fn;}observe(){}disconnect(){}},chrome:{runtime:{id:'test',sendMessage:async event=>{events.push(event);},onMessage:{addListener(){}}}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../gpt-content.js'),'utf8'),context);
  const tick=duration=>{const end=now+duration;let loops=0;while(true){const next=[...timers].sort((a,b)=>a[1].due-b[1].due)[0];if(!next||next[1].due>end)break;if(++loops>100)throw Error('timer explosion');timers.delete(next[0]);now=next[1].due;next[1].fn();}now=end;};
  return{api:context.module.exports,assistant,user,flags,events,timers,tick,mutate:()=>observer?.()};
}

test('GPT 纯文本段落和 br 保留换行，可以解析截图中的 flowchart',()=>{
  const {api,assistant}=contentFixture();const text=api.extractAssistantText(assistant);
  assert.equal(text,'flowchart TD\nA[用户端]\nB[商家端]\nA --> B');
  assert.equal(AI.validateMermaid(text).ok,true);
  const code=new Element('div',[new Element('pre',[new Element('code',['flowchart LR\nA --> B'])])]);
  assert.equal(AI.validateMermaid(api.extractAssistantText(code)).ok,true);
});

test('GPT 登录页会发出认证暂停事件，而不是把页面未就绪当作登录失败',async()=>{
  const f=contentFixture({href:'https://chatgpt.com/auth/login'});
  await f.api.start('auth-task','恢复后继续');
  const event=f.events.find(item=>item.kind==='needs-attention');
  assert.equal(event?.code,'auth-required');
  assert.match(event?.error||'',/暂停/);
});

test('回复稳定但没有完成信号时不得导入；DOM 变更不会堆积计时器',()=>{
  const f=contentFixture();const record={taskId:'t',requestFingerprint:f.api.hash(f.user.textContent),baselineElements:new Set()};
  f.api.active.set('t',record);f.api.watchReply(record);
  for(let i=0;i<100;i++)f.mutate();assert.equal(f.timers.size,1);
  f.tick(8000);assert.equal(f.events.length,0);
  f.flags.complete=true;f.tick(1000);
  assert.equal(f.events.length,1);assert.equal(f.events[0].kind,'reply');assert.equal(f.timers.size,0);
});

function boardFixture(){
  const board=Object.create(globalThis.QuickdrawBoard.prototype);
  Object.assign(board,{currentFileId:'board-a',instanceId:'instance-a',aiBoardEpoch:1,boardLoading:false,
    aiImporting:new Set(),aiTaskReceipts:new Map(),elements:[],history:[],redos:[],historyBaseline:[],
    width:800,height:600,offsetX:0,offsetY:0,scale:1,theme:'light',currentMindStyle:'rounded',imageCache:new Map(),
    ctx:{save(){},restore(){},measureText:text=>({width:text.length*8})},store:{releaseObjectUrlsExcept(){}},
    setSelection(){},clearSelection(){},updateHistoryUI(){},scheduleSave(){},render(){},toast(){},onAITaskUpdated(){},
    showAITaskError(error){this.lastError=String(error);}});
  return board;
}

function aiProgressUiFixture(){
  const nodes = new Map();
  const ids = ['ai-mindmap-dialog','ai-task-error','ai-task-status','ai-task-flyout','ai-task-flyout-provider','ai-task-flyout-stage','ai-task-flyout-text','ai-task-flyout-cancel','ai-task-flyout-reedit','ai-task-flyout-dismiss','ai-task-cancel','ai-mindmap-submit'];
  for(const id of ids)nodes.set(id,{id,hidden:id==='ai-task-flyout',disabled:false,textContent:'',value:'',dataset:{},focus(){}});
  const card={dataset:{}};const root=nodes.get('ai-task-flyout');root.querySelector=selector=>selector==='.ai-task-flyout-card'?card:null;
  return {nodes,document:{querySelector(selector){if(selector.startsWith('#'))return nodes.get(selector.slice(1))||null;if(selector==='.ai-dialog-hint')return null;return null;}}};
}

test('失败任务关闭详情或点击×会清掉临时卡；收起活动任务保留，旧事件不复活，新任务隔离', async()=>{
  const savedDocument=global.document;const ui=aiProgressUiFixture();global.document=ui.document;
  try{
    const board=boardFixture();board.onAITaskUpdated=globalThis.QuickdrawBoard.prototype.onAITaskUpdated;board.aiDismissedTaskIds=new Set();board.aiTasks=[];
    const failed={...AI.createTask(input),status:'needs-attention',error:'豆包编辑器写入后完整需求回读校验未通过，未发送内容。'};
    board.aiProgressTask=failed;board.aiCurrentTaskId=failed.taskId;ui.nodes.get('ai-mindmap-dialog').hidden=false;ui.nodes.get('ai-task-error').hidden=false;
    board.closeAIMindmapDialog();
    assert.equal(board.aiCurrentTaskId,null);assert.equal(board.aiProgressTask,null);assert.equal(ui.nodes.get('ai-task-flyout').hidden,true);assert.equal(board.aiDismissedTaskIds.has(failed.taskId),true);

    const failedByX={...failed,taskId:'failed-by-x'};board.aiProgressTask=failedByX;board.aiCurrentTaskId=null;board.renderAIProgress();assert.equal(ui.nodes.get('ai-task-flyout-dismiss').hidden,false);
    board.dismissAIProgressTask(failedByX.taskId);assert.equal(board.aiProgressTask,null);assert.equal(ui.nodes.get('ai-task-flyout').hidden,true);assert.equal(board.aiDismissedTaskIds.has(failedByX.taskId),true);

    const active={...AI.createTask(input),taskId:'active-task',status:'sending',stage:'sending'};board.aiProgressTask=active;board.aiCurrentTaskId=active.taskId;ui.nodes.get('ai-task-flyout').hidden=false;board.closeAIMindmapDialog();assert.equal(board.aiProgressTask.taskId,active.taskId);assert.equal(ui.nodes.get('ai-task-flyout').hidden,false);

    board.aiProgressTask=null;board.aiCurrentTaskId=null;board.onAITaskUpdated({...failedByX,status:'needs-attention',error:'迟到旧错误'});assert.equal(board.aiProgressTask,null,'old task progress');assert.equal(ui.nodes.get('ai-task-flyout').hidden,true,'old task flyout hidden');
    const next={...AI.createTask(input),taskId:'new-task',status:'sending',stage:'sending'};board.onAITaskUpdated(next);assert.equal(board.aiProgressTask.taskId,'new-task');
    const cancelled={...next,status:'cancelled'};board.onAITaskUpdated(cancelled);assert.equal(board.aiProgressTask,null);assert.equal(ui.nodes.get('ai-task-flyout').hidden,true);
  }finally{global.document=savedDocument;}
});

test('多图选区按画布坐标排序，群组文字整体导出且父子不重复',()=>{
  setup();
  const board=boardFixture();
  const imageRight={id:'image-right',type:'image',x:320,y:40,w:80,h:80,assetId:'right'};
  const groupTextA={id:'group-a',type:'text',x:120,y:60,w:80,h:20,text:'标题',groupId:'g1',fontSize:18};
  const groupTextB={id:'group-b',type:'text',x:120,y:90,w:80,h:20,text:'正文',groupId:'g1',fontSize:18};
  const imageLeft={id:'image-left',type:'image',x:10,y:20,w:80,h:80,assetId:'left'};
  board.elements=[imageRight,groupTextA,groupTextB,imageLeft];
  const units=board.getAIImageInputUnits([imageRight,groupTextB,imageLeft,groupTextA]);
  assert.equal(units.length,3);
  assert.deepEqual(units.map(unit=>unit.seedId),['image-left','group-b','image-right']);
  assert.deepEqual(units[1].ids.sort(),['group-a','group-b']);
});

test('嵌套思维节点选区只生成一个包含可见后代的输入单元',()=>{
  setup();
  const board=boardFixture();
  const root={id:'root',type:'mindnode',x:0,y:0,w:120,h:40,text:'根',parentId:null};
  const child={id:'child',type:'mindnode',x:160,y:0,w:120,h:40,text:'子',parentId:'root'};
  const grand={id:'grand',type:'mindnode',x:320,y:0,w:120,h:40,text:'孙',parentId:'child'};
  board.elements=[root,child,grand];
  const units=board.getAIImageInputUnits([root,child]);
  assert.equal(units.length,1); assert.deepEqual(units[0].ids.sort(),['child','grand','root']);
});

test('图片权限复用 Chrome 已授权范围，拒绝时保留结果且不触发二次任务', async()=>{
  const previousChrome=global.chrome;const requests=[];let sends=0,granted=false;
  global.chrome={permissions:{contains:async()=>granted,request:async value=>{requests.push(value);granted=true;return true;}},runtime:{sendMessage:async()=>{sends++;return{ok:true};}}};
  try{
    const board=boardFixture();
    const family=['https://*.byteimg.com/*'];
    assert.equal(await board.ensureImageOriginPermission('https://p3-flow-imagex-sign.byteimg.com/result.png?x=1',family),true);
    assert.equal(await board.ensureImageOriginPermission('https://p9-flow-imagex-sign.byteimg.com/other.png?x=2',family),true);
    assert.deepEqual(requests,[{origins:family}]);
    assert.equal(await board.ensureImageOriginPermission('blob:https://cdn.example.com/result'),false);
    assert.equal(requests.length,1);
    granted=false;global.chrome.permissions.request=async value=>{requests.push(value);return false;};
    await board.retryAIImage({taskId:'pending-task',imageUrl:'https://other.example.com/result.png',imagePermissionOrigins:['https://other.example.com/*']});
    assert.equal(sends,0);
    assert.match(board.lastError||'',/权限未授予/);
  }finally{global.chrome=previousChrome;}
});

test('完整导入先保存再确认；重复调用不重复插入；一次撤销删除全部生成节点',async()=>{
  setup();const board=boardFixture();
  const task={...AI.createTask(input),status:'ready',validatedMermaid:'flowchart TD\nA[用户] --> B[商家]'};
  const calls=[];
  chrome.runtime.sendMessage=async message=>{
    calls.push(message.type);
    return{ok:true,task:{...task,status:message.type==='qd-ai-claim-import'?'importing':'imported'}};
  };
  board.saveFileNow=async()=>{calls.push('saved');return'board-a';};
  await board.importAITask(task,false);
  assert.deepEqual(calls,['qd-ai-claim-import','saved','qd-ai-mark-imported']);
  assert.equal(board.elements.length,3);assert.equal(board.history.length,1);
  await board.importAITask(task,true);assert.equal(board.elements.length,3);
  board.undo();assert.equal(board.elements.length,0);
});

test('领取期间切换画板保留结果；保存失败不得撤销随后发生的用户编辑',async()=>{
  setup();const board=boardFixture();
  const task={...AI.createTask(input),status:'ready',validatedMermaid:'flowchart TD\nA --> B'};
  chrome.runtime.sendMessage=async message=>{
    if(message.type==='qd-ai-claim-import'){board.currentFileId='board-b';board.aiBoardEpoch++;}
    return{ok:true,task:{...task,status:'importing'}};
  };
  await board.importAITask(task,false);assert.equal(board.elements.length,0);
  const other=boardFixture();chrome.runtime.sendMessage=async()=>({ok:true,task:{...task,status:'importing'}});
  other.saveFileNow=async()=>{other.elements.push({id:'later-edit',type:'text',text:'保留我'});other.commit();throw Error('disk full');};
  await other.importAITask(task,false);
  assert.equal(other.elements.length,4);assert.equal(other.elements.at(-1).id,'later-edit');
  assert.equal(other.aiTaskReceipts.has(task.taskId),true);
});

test('豆包首个图片任务一次申请平台与必要 CDN 权限，后续任务复用 Chrome 授权',async()=>{
  const previousChrome=global.chrome;let granted=false;const requests=[];
  global.chrome={permissions:{contains:async()=>granted,request:async value=>{requests.push(value);granted=true;return true;}}};
  try{
    const board=boardFixture();
    assert.equal(await board.ensureProviderPermission('doubao',true),true);
    assert.equal(await board.ensureProviderPermission('doubao',true),true);
    assert.equal(requests.length,1);
    assert.deepEqual(requests[0].origins,['https://www.doubao.com/*','https://*.doubao.com/*','https://*.byteimg.com/*']);
  }finally{global.chrome=previousChrome;}
});
