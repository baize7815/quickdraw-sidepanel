'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const M=require('./ai-visual-mentions.js');
const AI=require('./ai-protocol.js');
function sample() {return {mode:'point',width:1254,height:1254,mainAssetId:'a_main',materials:[{assetId:'a_ref',label:'金色雕塑'},{assetId:'a_main',label:'人物'}, {assetId:'a_ref2',label:'手套'}],prompt:'给 @点1 换头发，@点2 戴 @图3 的手套',points:[{pointId:'p1',assetId:'a_main',x:627,y:250,text:'粉色头发'},{pointId:'p2',assetId:'a_main',x:950,y:800,text:'在此增加配饰'}],strokes:[],rect:null,hasReference:true};}
test('引用图号按主图在前、标注图第二、参考图第三起编译',()=>{
 const s=sample(),items=M.sourceItems(s);
 assert.deepEqual(items.map(v=>v.assetId),['a_main','a_ref','a_ref2']);
 assert.match(M.expand('@图1 @图2 @图3',s),/Image 1.*Image 3.*Image 4/);
 const prompt=M.compile(s);
 assert.match(prompt,/Point 1 on Image 1 at normalized \[x,y\]=\[500,199\]/);
 assert.match(prompt,/Point 2 on Image 1 at normalized \[x,y\]=\[758,638\]/);
 assert.match(prompt,/Image 4 \(reference 3\)/);
 assert.match(prompt,/Image 2 is always the annotated location guide/);
 assert.match(prompt,/Point 1 at normalized/);
});
test('同一原图的点位不依赖任何额外参考图',()=>{
 const s=sample();s.materials=[{assetId:'a_main',label:'人物'}];s.prompt='';
 s.points[0].text='头发改成金色';s.points[1].text='手表改成白色';
 assert.match(M.compile(s),/Point 2/);
 assert.doesNotMatch(M.compile(s),/Image 3/);
});
test('缺失点、缺失素材、孤立 @ 均拒绝提交',()=>{
 const s=sample();
 for(const ref of ['@点3','@图4','@图0','@点','@9'])assert.throws(()=>M.expand(ref,s),/引用/);
 assert.throws(()=>M.compile({...s,points:[{...s.points[0],assetId:'a_other'}]}),/不属于当前主图/);
});
test('@ 候选点与素材分离，补全查找随光标更新',()=>{
 const s=sample();
 const all=M.suggestions(s);
 assert.deepEqual(all.map(x=>x.token),['@点1','@点2','@图1','@图2','@图3']);
 assert.deepEqual(M.pending('改变 @点',5),{start:3,query:'@点'});
 assert.equal(M.pending('普通文字',4),null);
});
test('常规 AI 任务仍只允许 4 图；可视化编辑允许主图+标注+3 参考图',()=>{
 const input={provider:'gpt',kind:'image-edit',boardId:'b',sourceInstanceId:'s',prompt:'test',inputAssets:[0,1,2,3,4].map(i=>({assetId:'a_'+i,order:i}))};
 assert.throws(()=>AI.createTask(input),/最多处理 4 张图片/);
 const task=AI.createTask({...input,visualEdit:true});
 assert.equal(task.inputAssets.length,5);
 assert.throws(()=>AI.createTask({...input,visualEdit:true,inputAssets:[...input.inputAssets,{assetId:'a_5'}]}),/最多处理 5 张图片/);
});
