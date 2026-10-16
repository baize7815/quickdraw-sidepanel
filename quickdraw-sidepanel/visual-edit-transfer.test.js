'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Transfer=require('./ai-visual-transfer.js');
function store() {
 const records=new Map([['a_original',{blob:new Blob(['original'],{type:'image/png'})}],['a_guide',{blob:new Blob(['guide'],{type:'image/png'})}],['a_reference',{blob:new Blob(['reference'],{type:'image/png'})}]]);
 let counter=0;
 return {records,getAsset:async id=>records.get(id)||null,putAsset:async(blob,meta)=>{const id='a_copy_'+(++counter);records.set(id,{blob,...meta});return id;},deleteAsset:async id=>records.delete(id)};
}
test('图片任务输入全部复制，完成清理不损坏源图片',async()=>{
 const s=store(),ids=await Transfer.stage(s,['a_original','a_guide','a_reference'],async blob=>assert.ok(blob.size>0));
 assert.deepEqual(ids,['a_copy_1','a_copy_2','a_copy_3']);
 for(const id of ids)assert.equal(s.records.get(id).visualEditorTaskInput,true);
 await Transfer.cleanup(s,ids);
 assert.equal(s.records.size,3);
 assert.deepEqual([...s.records.keys()].sort(),['a_guide','a_original','a_reference']);
});
test('中途资源失效时回滚先前生成的临时副本',async()=>{
 const s=store();
 await assert.rejects(Transfer.stage(s,['a_original','missing'],null),/失效/);
 assert.equal(s.records.size,3);
 assert.equal([...s.records.keys()].some(id=>id.startsWith('a_copy')),false);
});
test('副本验证失败时不删除任何原图',async()=>{
 const s=store();
 await assert.rejects(Transfer.stage(s,['a_original'],()=>{throw Error('不支持的图像')}),/不支持/);
 assert.ok(s.records.get('a_original'));
});
