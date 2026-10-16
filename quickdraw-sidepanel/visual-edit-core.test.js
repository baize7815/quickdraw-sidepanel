'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('./ai-visual-core.js');
const base={mode:'mask',width:2000,height:1000,prompt:'把椅子换成沙发',strokes:[{erase:false,radius:8,points:[{x:500,y:300}]}],points:[],rect:null,invert:false,feather:8,hasReference:false};
test('真实像素坐标正确归一化，图像尺寸不变',()=>{
 assert.deepEqual(C.coordinate({x:500,y:300},2000,1000),{x:250,y:300});
 assert.deepEqual(C.coordinate({x:-100,y:1500},2000,1000),{x:0,y:1000});
});
test('矩形按上左下右输出并修正反向拖拽',()=>{
 const r=C.bounds({x:1400,y:700,w:-500,h:-400},2000,1000);
 assert.deepEqual(r.normalized,[300,450,700,700]);
 assert.equal(C.bounds({x:2,y:2,w:0,h:0},2000,1000),null);
});
test('蒙版模式必须有笔画与编辑请求',()=>{
 assert.match(C.script(base),/Image 1/);
 assert.match(C.script(base),/Image 2/);
 assert.throws(()=>C.script({...base,strokes:[]}),/蒙版/);
 assert.throws(()=>C.script({...base,prompt:' '}),/编辑要求/);
});
test('反选提示词不会指向原始涂抹区域',()=>{
 const t=C.script({...base,invert:true});
 assert.match(t,/inverse|inverted/i);
 assert.match(t,/preserve the unmarked selection/i);
});
test('编辑点按编号和归一化 [x,y] 注入独立指令',()=>{
 const s={...base,mode:'point',points:[{x:1000,y:200,text:'改成蓝色'},{x:1500,y:800,text:'改成玻璃'}]};
 const t=C.script(s);
 assert.match(t,/Point 1.*500,200.*蓝色/);
 assert.match(t,/Point 2.*750,800.*玻璃/);
 assert.throws(()=>C.script({...s,points:[]}),/编辑点/);
});
test('融合模式要求目标框和参考图，空间框为 [ymin,xmin,ymax,xmax]',()=>{
 const s={...base,mode:'fusion',hasReference:true,rect:{x:400,y:100,w:500,h:300}};
 assert.match(C.script(s),/\[100,200,400,450\]/);
 assert.match(C.script(s),/Image 3/);
 assert.throws(()=>C.script({...s,hasReference:false}),/参考/);
});
test('清单包含源坐标、提示词、羽化及反选，不改写原输入',()=>{
 const original=structuredClone(base),m=C.manifest(base);
 assert.equal(m.format,'quickdraw-visual-image-edit');
 assert.equal(m.mask.feather,8);
 assert.deepEqual(m.mask.strokes,base.strokes);
 assert.deepEqual(base,original);
});
test('异常模式和无效尺寸被阻止',()=>{
 assert.throws(()=>C.script({...base,mode:'unknown'}),/模式/);
 assert.throws(()=>C.script({...base,width:0}),/尺寸/);
});
