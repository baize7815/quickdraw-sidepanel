'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'sidepanel.js'),'utf8');
const start=source.indexOf('    async receiveVisualEditorMessage(event){');
const end=source.indexOf('    openAIImageDialog(){',start);
assert.ok(start>=0&&end>start);
const method=source.slice(start,end).trim();
function setup(){
 const assets=new Map([
 ['a_main',{blob:new Blob(['main'],{type:'image/png'})}],
 ['a_reference',{blob:new Blob(['reference'],{type:'image/png'})}],
 ['a_guide',{blob:new Blob(['guide'],{type:'image/png'}),visualEditorGuide:true,visualSource:'a_main'}]
 ]);
 let sequence=0;const emitted=[],messages=[],notes=[],deletes=[];
 const store={
  async getAsset(id){return assets.get(id)||null;},
  async putAsset(blob,meta){const id='a_clone_'+(++sequence);assets.set(id,{blob,...meta});return id;},
  async deleteAsset(id){deletes.push(id);assets.delete(id);}
 };
 const frame={contentWindow:{postMessage(packet){messages.push(packet);}}};
 const sandbox={
  console,URL,location:{origin:'chrome-extension://quickdraw-test'},
  $:selector=>selector==='#qd-visual-frame'?frame:null,
  chrome:{permissions:{contains:async()=>true},runtime:{sendMessage:async packet=>{emitted.push(packet);return {ok:true,taskId:'test_task'};}}},
  QuickdrawVisualTransfer:require('./ai-visual-transfer.js'),
  QuickdrawAIImage:{MAX_INPUT_BYTES:25*1024*1024,inspectBlob:async blob=>{if(!blob.size)throw Error('empty');}},
  QuickdrawAI:{provider:id=>({id,label:'GPT',enabled:true,capabilities:{image:true},origins:['https://chatgpt.com/*'],authOrigins:[]}),isActiveTask:()=>true},
 };
 sandbox.globalThis=sandbox;
 const receive=vm.runInNewContext('({'+method+'}).receiveVisualEditorMessage',sandbox);
 const board={
  visualEditContext:{boardId:'b',epoch:4,sources:[{id:'e_main',assetId:'a_main'},{id:'e_ref',assetId:'a_reference'}]},
  currentFileId:'b',aiBoardEpoch:4,instanceId:'instance',windowId:5,documentRevision:3,elements:[{id:'e_main',assetId:'a_main'},{id:'e_ref',assetId:'a_reference'}],
  store,aiSubmitBusy:false,aiDismissedTaskIds:new Set(),
  getElementsBBox:()=>({x:3,y:5,w:100,h:100}),closeVisualImageEditor(){notes.push('closed');},
  renderAIProgress(){},refreshAITasks(){return Promise.resolve();},toast(t){notes.push(t);}
 };
 const event={origin:'chrome-extension://quickdraw-test',source:frame.contentWindow,data:{type:'qd-visual-submit',provider:'gpt',mode:'point',mainAssetId:'a_main',guideAssetId:'a_guide',inputAssetIds:['a_main','a_guide','a_reference'],prompt:'Edit test'}};
 return {receive,board,event,assets,emitted,messages,notes,deletes,store};
}
test('侧边栏提交使用隔离资产，画板主图和参考原件保留',async()=>{
 const s=setup();await s.receive.call(s.board,s.event);
 assert.equal(s.emitted.length,1);
 const payload=s.emitted[0].payload;
 assert.equal(s.emitted[0].type,'qd-ai-submit');
 assert.equal(payload.visualEdit,true);
 assert.equal(payload.visualMode,'point');
 assert.equal(payload.inputAssets.length,3);
 assert.notEqual(payload.inputAssets[0].assetId,'a_main');
 assert.notEqual(payload.inputAssets[1].assetId,'a_guide');
 assert.notEqual(payload.inputAssets[2].assetId,'a_reference');
 assert.deepEqual(payload.inputAssets.map(i=>i.order),[0,1,2]);
 assert.ok(s.assets.has('a_main'));
 assert.ok(s.assets.has('a_reference'));
 assert.equal(s.board.aiProgressTask.taskId,'test_task');
 await require('./ai-visual-transfer.js').cleanup(s.store,payload.inputAssetIds);
 assert.ok(s.assets.has('a_main'));
 assert.ok(s.assets.has('a_reference'));
});
test('侧边栏拒绝不属于选区的外部伪造参考图',async()=>{
 const s=setup();s.assets.set('a_untrusted',{blob:new Blob(['x'])});s.event.data.inputAssetIds[2]='a_untrusted';
 await s.receive.call(s.board,s.event);
 assert.equal(s.emitted.length,0);
 assert.equal(s.messages[0].ok,false);
 assert.match(s.messages[0].error,/参考图来源无效/);
 assert.ok(s.assets.has('a_main'));
});
test('画板已切换时禁止提交和删除图片',async()=>{
 const s=setup();s.board.currentFileId='other';
 await s.receive.call(s.board,s.event);
 assert.equal(s.emitted.length,0);
 assert.equal(s.messages[0].ok,false);
 assert.equal(s.deletes.length,0);
});
