'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
require('../core-utils.js');
const V=require('../vector-utils.js');
require('../editing-tools.js');
require('../sidepanel.js');
const Board=globalThis.QuickdrawBoard;
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-8,`${actual} ≠ ${expected}`);

test('旋转镜像后逆变换能还原命中坐标',()=>{
  const m=V.around([0,1,1,0,0,0],{x:35,y:20}),p={x:7,y:13},q=V.point(V.inverse(m),V.point(m,p));near(q.x,p.x);near(q.y,p.y);
});
test('比例裁剪在四个拖拽方向均保持比例且不越界',()=>{
  const box={x:10,y:10,w:160,h:90},start={x:90,y:55};
  for(const p of [{x:-50,y:-90},{x:300,y:-10},{x:300,y:300},{x:-50,y:200}]){
    const b=V.cropRect(start,p,box,16/9);near(b.w/b.h,16/9);assert.ok(b.x>=10&&b.y>=10&&b.x+b.w<=170.00001&&b.y+b.h<=100.00001);
  }
});
test('不能整除的宫格不会遗漏或重复像素',()=>{
  const cells=V.gridCells(101,73,3,2),coverage=new Uint8Array(101*73);
  for(const c of cells)for(let y=c.y;y<c.y+c.h;y++)for(let x=c.x;x<c.x+c.w;x++)coverage[y*101+x]++;
  assert.ok(coverage.every(n=>n===1));assert.throws(()=>V.gridCells(10,10,0,3));assert.throws(()=>V.gridCells(10,10,11,1));assert.throws(()=>V.gridCells(100,100,11,10));
});
test('路径保留贝塞尔控制点和多个闭合孔洞',()=>{
  const el={paths:[{closed:true,nodes:[{x:0,y:0,out:{x:30,y:-20}},{x:100,y:0,in:{x:60,y:20}},{x:50,y:50}]},{closed:true,nodes:[{x:10,y:10},{x:20,y:10},{x:15,y:20}]}],stroke:'none'};
  const d=V.pathData(el);assert.match(d,/C30 -20 60 20 100 0/);assert.equal((d.match(/ Z/g)||[]).length,2);assert.equal(V.pathBounds(el).y,-20);
});
test('旋转后移动、对齐和缩放使用视觉边界',()=>{
  const board=Object.create(Board.prototype),el={id:'i',type:'image',x:0,y:0,w:100,h:50};Object.assign(board,{elements:[el],selectedElements:[el],scale:1,commit(){},render(){}});
  board.rotateSelection(Math.PI/2);let b=board.getElementBBox(el);near(b.w,50);near(b.h,100);
  board.moveElement(el,30,-10);b=board.getElementBBox(el);near(b.x,55);near(b.y,-35);
  board.resizeStart={bbox:b,elements:[structuredClone(el)]};board.resizeSelection('se',{x:b.x+100,y:b.y+200},true);b=board.getElementBBox(el);near(b.w,100);near(b.h,200);
});

function gestureBoard(){
  const board=Object.create(Board.prototype),el={id:'pen',type:'path',paths:[{closed:false,nodes:[{x:100,y:100,out:{x:140,y:80}},{x:200,y:150,in:{x:170,y:180}}]}],fill:'none',stroke:'solid',size:4};
  Object.assign(board,{elements:[el],selectedElements:[el],currentTool:'select',scale:1.31,pointerDown:true,snapToGrid:false,eventPos:e=>e,commit(){},render(){}});
  return {board,el};
}

test('新钢笔路径首次拖拽始终使用按下时快照，不累加前一帧位移',()=>{
  const {board,el}=gestureBoard(),original=structuredClone(el);
  Object.assign(board,{isDragging:true,dragHasMoved:true,dragStart:{x:0,y:0},dragOrigin:[structuredClone(el)]});
  for(const [x,y] of [[10,5],[30,15],[50,25],[10,5],[0,0]]){
    board.onPointerMove({x,y});const point=V.point(V.matrix(el),original.paths[0].nodes[0]);near(point.x,100+x);near(point.y,100+y);assert.deepEqual(el.paths,original.paths);
  }
});

test('首次连续旋转每帧基于原始变换，不累加前一帧旋转',()=>{
  const {board,el}=gestureBoard();board.rotationDrag={center:{x:0,y:0},angle:0,elements:[structuredClone(el)]};
  for(const angle of [.1,.2,.4,.1,0]){
    board.editingPointerMove({x:100*Math.cos(angle),y:100*Math.sin(angle)});const point=V.point(V.matrix(el),{x:100,y:100});near(point.x,100*Math.cos(angle)-100*Math.sin(angle));near(point.y,100*Math.sin(angle)+100*Math.cos(angle));
  }
});
