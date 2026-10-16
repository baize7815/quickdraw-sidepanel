'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const AI=require('./ai-protocol.js');
const Store=require('./ai-task-store.js');
function task(visualEdit, count){return AI.createTask({provider:'gemini',kind:'image-edit',visualEdit,boardId:'board',sourceInstanceId:'sidebar',prompt:'Edit the original',inputAssets:Array.from({length:count},(_,i)=>({assetId:'asset_'+i,order:i}))});}
test('局部编辑子类型贯穿创建和任务存储，五图不丢失',async()=>{
 const model=task(true,5);
 assert.equal(model.kind,'image-edit');assert.equal(model.visualEdit,true);
 const memory=new Map();
 globalThis.localStorage={getItem:key=>memory.get(key)||null,setItem:(key,value)=>memory.set(key,value)};
 const db=new Store('qd_local_visual_flag_test');
 await db.upsert(model);
 const persisted=await db.find(model.taskId);
 assert.equal(persisted.visualEdit,true);
 assert.deepEqual(persisted.inputAssetIds,['asset_0','asset_1','asset_2','asset_3','asset_4']);
 await db.update(model.taskId,{stage:'sending'});
 assert.equal((await db.find(model.taskId)).visualEdit,true);
});
test('普通图片任务保留四张上限且不会误显示为局部编辑',()=>{
 assert.throws(()=>task(false,5),/最多处理 4 张图片/);
 assert.equal(task(false,4).visualEdit,false);
});
