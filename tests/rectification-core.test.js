'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const QDGroups=require('../quickdraw-sidepanel/group-utils.js');
const source=fs.readFileSync(path.join(__dirname,'../quickdraw-sidepanel/sidepanel.js'),'utf8');
const pick=(start,end)=>{
  const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,'missing Quickdraw method: '+start);
  return source.slice(a,b).trim();
};
const context={console,Math,Set,Map,Promise,Number,Blob,newId:()=>'test',QDVector:{matrix:()=>[1,0,0,1,0,0]},QDCore:require('../quickdraw-sidepanel/core-utils.js')};
context.globalThis={QDGroups,QDCore:context.QDCore};
const methods=vm.runInNewContext('({'+[
  pick('    groupSelected() {','    ungroupSelected() {'),
  pick('    moveSelectedLayer(direction,toEdge=false) {','    layerEntries(parentId=null){'),
  pick('    layerEntries(parentId=null){','    reorderLayer(sourceKey,destKey){'),
  pick('    reorderLayer(sourceKey,destKey){','    renderLayersPanel(){'),
  pick('    alignmentAnchors(box) {','    calculateGridDrag(origins,dx,dy) {'),
  pick('    calculateGridDrag(origins,dx,dy) {','    drawSmartGuides(ctx){'),
  pick('    async createPNGBlob(','    async exportSelection('),
  pick('    async compositeVisualMaskAsset(','    async importAITask(')
].join(',')+'})',context);

const makeBoard=(elements,selected)=>{
  const board={...methods,elements,groups:[],selected,scale:1,offsetX:0,offsetY:0,width:1000,height:700,snapToGrid:false,
    getSelectedElements(){return this.selected;},
    setSelection(items){this.selected=items;},
    expandGroupedItems(items){return QDGroups.expandSelection(items,this.groups,this.elements);},
    commit(){this.commits=(this.commits||0)+1;},
    render(){},renderLayersPanel(){},toast(){},
    getElementBBox(el){return {x:el.x||0,y:el.y||0,w:el.w||10,h:el.h||10};},
    getElementsBBox(items){if(!items.length)return null;return {x:Math.min(...items.map(el=>el.x||0)),y:Math.min(...items.map(el=>el.y||0)),w:Math.max(...items.map(el=>(el.x||0)+(el.w||10)))-Math.min(...items.map(el=>el.x||0)),h:Math.max(...items.map(el=>(el.y||0)+(el.h||10)))-Math.min(...items.map(el=>el.y||0))};},
    isElementVisible(el){return !el.hidden;},
    rectIntersects(a,b){return a.x<=b.x+b.w&&a.x+a.w>=b.x&&a.y<=b.y+b.h&&a.y+a.h>=b.y;}
  };
  return board;
};

test('编组后图层成员连续，整体上移/下移时保持组内顺序',()=>{
  const a={id:'a'},x={id:'x'},b={id:'b'},y={id:'y'};
  const board=makeBoard([a,x,b,y],[a,b]);
  board.groupSelected();
  assert.deepEqual(Array.from(board.elements,e=>e.id),['x','a','b','y']);
  assert.ok(a.groupId&&a.groupId===b.groupId);
  board.moveSelectedLayer(1);
  assert.deepEqual(Array.from(board.elements,e=>e.id),['x','y','a','b']);
  board.moveSelectedLayer(-1);
  assert.deepEqual(Array.from(board.elements,e=>e.id),['x','a','b','y']);
});

test('图层树拖拽只能在同级重排，不拆散群组',()=>{
  const a={id:'a',groupId:'g1'},b={id:'b',groupId:'g1'},x={id:'x'},y={id:'y'};
  const board=makeBoard([a,b,x,y],[a,b]);
  board.groups=[{id:'g1',parentGroupId:null}];
  assert.deepEqual(Array.from(board.layerEntries(null),unit=>unit.key),['g:g1','e:x','e:y']);
  assert.equal(board.reorderLayer('g:g1','e:y'),true);
  assert.deepEqual(Array.from(board.elements,e=>e.id),['x','a','b','y']);
  assert.equal(board.reorderLayer('e:a','e:x'),false);
});

test('智能对齐吸附到邻近对象左边界并画出参考线',()=>{
  const moving={id:'moving',x:100,y:0,w:30,h:30},other={id:'other',x:108,y:100,w:60,h:40};
  const board=makeBoard([moving,other],[moving]);
  const next=board.calculateGridDrag([moving],7.9,20);
  assert.ok(Math.abs(next.dx-8)<1e-7,JSON.stringify(next));
  assert.equal(board.smartGuides.x,108);
});

test('高清导出以原始图像像素密度为基准，而不固定为 2 倍',async()=>{
  const board=makeBoard([{id:'a',type:'image',assetId:'asset',x:0,y:0,w:300,h:200,naturalWidth:3000,naturalHeight:2000}],[]);
  board.exportElementsFor=()=>board.elements;
  board.getCachedImage=()=>({naturalWidth:3000,naturalHeight:2000});
  board.waitForImages=async()=>{};
  board.drawElement=()=>{};
  board.themePaperColor=()=> '#fff';
  let exported=null;
  context.document={createElement(type){
    assert.equal(type,'canvas');
    const canvas={width:0,height:0};
    canvas.getContext=()=>({fillRect(){},save(){},restore(){},scale(){},translate(){},set fillStyle(_){},set imageSmoothingEnabled(_){},set imageSmoothingQuality(_){}});
    canvas.toBlob=cb=>{exported=[canvas.width,canvas.height];cb(new Blob(['image'],{type:'image/png'}));};
    return canvas;
  }};
  const image=await board.createPNGBlob(true);
  assert.equal(image.type,'image/png');
  assert.deepEqual(exported,[3000,2000]);
});

test('局部蒙版合成拒绝比例错误的 AI 结果，避免把整图错误覆盖回画板',async()=>{
  const board=makeBoard([],[]);
  board.store={getAsset:async id=>({blob:{kind:id}})};
  context.createImageBitmap=async blob=>({
    width:blob.kind==='result'?300:200,height:100,close(){}
  });
  await assert.rejects(board.compositeVisualMaskAsset('original','mask',{assetId:'result'}),/生成图比例与原图不匹配/);
});
