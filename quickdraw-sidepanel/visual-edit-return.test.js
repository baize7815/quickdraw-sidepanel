'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function setup(type='image/png',failOpen=false){
 let receiver,deliveries=[],opens=[];
 const chrome={
  runtime:{id:'quickdraw-test',onMessage:{addListener(fn){if(!receiver)receiver=fn;}},onInstalled:{addListener(){}}},
  tabs:{onRemoved:{addListener(){}},onUpdated:{addListener(){}},captureVisibleTab:async()=>''},
  contextMenus:{onClicked:{addListener(){}},removeAll(){}},
  action:{onClicked:{addListener(){}}},
  sidePanel:{open:async args=>{opens.push(args);if(failOpen)throw Error('user gesture required');}},
  storage:{session:{set:async data=>{deliveries.push(data);},get:async key=>deliveries.at(-1)||{}}}
 };
 class Store{async getAsset(id){return id==='a_valid'?{blob:new Blob(['png'],{type}),type}:null;}}
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'background.js'),'utf8'),
  {chrome,QuickdrawStorage:Store,importScripts(){},crypto:{randomUUID(){return 'test-uuid';}},console,globalThis:{},Blob,URL});
 return {receiver,deliveries,opens};
}
function invoke(listener,payload,sender={id:'quickdraw-test'}){
 return new Promise((resolve,reject)=>{
  const accepted=listener(payload,sender,resolve);
  if(!accepted)reject(Error('未受理消息'));
 });
}
test('本地生成结果回填使用现有待接收资产通道',async()=>{
 const e=setup(),result=await invoke(e.receiver,{type:'qd-visual-editor-import',assetId:'a_valid',windowId:5});
 assert.equal(result.ok,true);
 assert.equal(e.deliveries.length,1);
 assert.equal(e.deliveries[0]['quickdraw_pending_capture:5'].kind,'asset');
 assert.equal(e.deliveries[0]['quickdraw_pending_capture:5'].assetId,'a_valid');
 assert.equal(e.opens[0].windowId,5);
});
test('回填入口拒绝外部发件人与无效图片',async()=>{
 const e=setup();
 const a=await invoke(e.receiver,{type:'qd-visual-editor-import',assetId:'a_valid',windowId:5},{id:'other'});
 assert.equal(a.ok,false);
 const b=await invoke(e.receiver,{type:'qd-visual-editor-import',assetId:'invalid',windowId:5});
 assert.equal(b.ok,false);
 assert.equal(e.deliveries.length,0);
});
test('浏览器禁止程序化重开侧栏时，保存结果并提示用户手动打开',async()=>{
 const e=setup('image/png',true),result=await invoke(e.receiver,{type:'qd-visual-editor-import',assetId:'a_valid',windowId:5});
 assert.equal(result.ok,true);assert.equal(result.needsOpen,true);
 assert.equal(e.deliveries[0]['quickdraw_pending_capture:5'].assetId,'a_valid');
});
test('回填入口拒绝非图片资源',async()=>{
 const e=setup('text/html');
 const result=await invoke(e.receiver,{type:'qd-visual-editor-import',assetId:'a_valid',windowId:5});
 assert.equal(result.ok,false);
 assert.equal(e.deliveries.length,0);
});
