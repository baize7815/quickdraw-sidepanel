'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const AI=require('./ai-protocol.js');
const Gemini=require('./ai-gemini-provider.js');
test('Gemini provider configured for isolated web conversation and exact site origin',()=>{
 const p=new Gemini();
 assert.equal(p.getLabel(),'Gemini');
 assert.equal(p.getRootUrl(),'https://gemini.google.com/app');
 assert.equal(p.getContentScript(),'gemini-content.js');
 assert.equal(p.getCommandType(),'qd-ai-gemini-command');
 assert.deepEqual(p.getPermissionOrigins(),['https://gemini.google.com/*']);
 assert.equal(p.isAllowedUrl('https://gemini.google.com/app'),true);
 assert.equal(p.isAllowedUrl('https://gemini.google.com/app/abcdef'),true);
 for(const bad of ['http://gemini.google.com/app','https://gemini.google.com.evil.com/app','https://gemini.google.com.attacker.net/app','https://gemini.google.com:444/app','https://evil.com/'])assert.equal(p.isAllowedUrl(bad),false,bad);
});
test('Gemini does not hijack personal chat tabs',async()=>{
 const p=new Gemini();
 assert.equal(await p.findReusableTab(123),null);
});
test('Gemini task tab is not grouped and remains open after cleanup',async()=>{
 const previous=globalThis.chrome;
 const saved={};const calls=[];
 const tab={id:77,windowId:5,url:'https://gemini.google.com/app',status:'complete',groupId:-1};
 globalThis.chrome={
  storage:{session:{get:async key=>({[key]:saved[key]}),set:async data=>Object.assign(saved,data),remove:async key=>{delete saved[key];}}},
  tabs:{create:async opts=>{calls.push('create');return {...tab,url:opts.url};},get:async()=>tab,
   group:async()=>{calls.push('group');return 4;},update:async()=>{calls.push('activate');return tab;},
   remove:async()=>{calls.push('remove');}},
  tabGroups:{update:async()=>{calls.push('collapse');}}
 };
 try{
  const provider=new Gemini();
  const id=await provider.ensureTab(null,{taskId:'gemini_test_1'});
  assert.equal(id,77);
  assert.equal(provider.getTabMeta().ownedByExtension,true);
  const task={taskId:'gemini_test_1',tabId:id,tabOwned:true,tabOwnerToken:provider.getTabMeta().ownerToken};
  assert.equal(await provider.cleanup(task),true);
  assert.equal(saved[provider.getTabKey()],undefined);
  assert.deepEqual(calls,['create','activate']);
  assert.equal(await provider.cleanup(task),true);
  assert.deepEqual(calls,['create','activate']);
 }finally{globalThis.chrome=previous;}
});
test('Image output hosts are explicit Google media origins',()=>{
 const p=new Gemini();
 assert.equal(p.isAllowedOutputImageUrl('https://lh3.googleusercontent.com/abc'),true);
 assert.equal(p.isAllowedOutputImageUrl('https://gemini.google.com/resource/x'),true);
 assert.equal(p.isAllowedOutputImageUrl('https://lh3.googleusercontent.com.evil.io/file'),false);
 assert.deepEqual(p.getOutputPermissionOrigins('https://lh3.googleusercontent.com/abc'),['https://lh3.googleusercontent.com/*']);
 assert.deepEqual(p.getOutputPermissionOrigins('https://evil.io/file'),[]);
});
test('Gemini visual edit task keeps ordered image inputs',()=>{
 assert.equal(AI.provider('gemini').capabilities.image,true);
 const task=AI.createTask({provider:'gemini',kind:'image-edit',visualEdit:true,prompt:'adjust selected details',boardId:'board',sourceInstanceId:'sidepanel',inputAssets:[0,1,2,3,4].map((i)=>({assetId:'a_photo_'+i,order:i}))});
 assert.equal(task.provider,'gemini');
 assert.deepEqual(task.inputAssetIds,['a_photo_0','a_photo_1','a_photo_2','a_photo_3','a_photo_4']);
});
