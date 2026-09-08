'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require('playwright');
let browser,page,server;
const errors=[];
before(async()=>{
  const root=path.resolve(__dirname,'..');
  server=http.createServer((req,res)=>{
    const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
    if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
    const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.wasm':'application/wasm'};
    fs.readFile(file,(error,data)=>{if(error){res.writeHead(404).end();return;}res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');if(path.extname(file)==='.html'){const csp=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8')).content_security_policy;res.setHeader('Content-Security-Policy',path.basename(file)==='opencv-sandbox.html'?csp.sandbox:csp.extension_pages);}res.end(data);});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({channel:process.env.QD_BROWSER_CHANNEL||'chrome',headless:true});
  page=await browser.newPage({viewport:{width:1400,height:1000}});
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/sidepanel.html`);
  await page.waitForFunction(()=>window.quickdraw?.fileIndex);
  await page.evaluate(()=>{
    window.resetBoard=()=>{const b=quickdraw;b.elements=[];b.currentElement=null;b.penDraft=null;b.penEdit=null;b.penDrag=null;b.cancelImageCrop();b.cancelWatermarkRemoval();b.clearSelection();b.setTool('select');b.scale=1;b.offsetX=b.offsetY=0;b.snapToGrid=false;b.resetHistory();b.renderNow();return b;};
    window.testImage=async(w=100,h=80,hole=false)=>{
      const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d');ctx.fillStyle='#ff0000';ctx.fillRect(0,0,w,h);ctx.fillStyle='#0000ff';ctx.fillRect(w/2,0,w/2,h);if(hole)ctx.clearRect(w*.3,h*.3,w*.4,h*.4);
      const blob=await new Promise(resolve=>c.toBlob(resolve,'image/png'));return quickdraw.insertImage(blob,300,300);
    };
    window.assetPixel=async(el,x,y)=>{const record=await quickdraw.store.getAsset(el.assetId),img=await createImageBitmap(record.blob),c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const pixel=Array.from(ctx.getImageData(x,y,1,1).data);img.close();return {pixel,w:c.width,h:c.height};};
  });
});
after(async()=>{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());});

test('UI：启动、图标对齐、固定工具条与裁剪预设',async()=>{
  await page.evaluate(async()=>{resetBoard();await testImage();});
  await page.locator('#btn-arrange').click();
  assert.equal(await page.locator('[data-align="left"] svg').count(),1);
  await page.locator('#btn-crop').click();
  assert.equal(await page.evaluate(()=>quickdraw.cropTarget===quickdraw.selectedElement&&quickdraw.cropRatio===0),true);
  assert.equal(await page.locator('#crop-popover').isVisible(),false);
  await page.keyboard.press('Escape');
  await page.locator('#btn-crop').dblclick();
  assert.equal(await page.evaluate(()=>quickdraw.cropTarget),null);
  assert.equal(await page.locator('#crop-popover').isVisible(),true);
  await page.locator('[data-crop-ratio="16:9"]').click();
  assert.equal(await page.evaluate(()=>quickdraw.cropRatio),16/9);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#selection-toolbar').isVisible(),true);
});

test('浏览器：镜像和旋转改变画面、命中、SVG 输出并支持撤销',async()=>{
  const result=await page.evaluate(async()=>{
    const b=resetBoard(),el=await testImage();b.flipSelection('x');
    const canvas=document.createElement('canvas');canvas.width=600;canvas.height=600;const ctx=canvas.getContext('2d');await b.waitForImages();b.drawElement(ctx,el);
    const pixel=Array.from(ctx.getImageData(310,310,1,1).data);b.rotateSelection(Math.PI/2);const box=b.getElementBBox(el),hit=b.pointInElement({x:350,y:340},el),markup=b.svgElementMarkup(el);b.undo();const afterUndo=b.elements[0].transform;return{pixel,box,hit,markup,afterUndo};
  });
  assert.deepEqual(result.pixel,[0,0,255,255]);assert.ok(Math.abs(result.box.w-80)<.001);assert.equal(result.hit,true);assert.match(result.markup,/transform="matrix/);assert.equal(result.afterUndo[0],-1);
});

test('浏览器：镜像图片宫格切割保留原像素与世界坐标',async()=>{
  const result=await page.evaluate(async()=>{
    const b=resetBoard(),el=await testImage(101,73);b.flipSelection('x');const original=b.getElementBBox(el);await b.splitImageGrid(3,2);const parts=b.elements.filter(el=>el.type==='image');const bounds=b.getElementsBBox(parts),dimensions=[];for(const part of parts)dimensions.push(await assetPixel(part,0,0));b.undo();return{count:parts.length,bounds,original,dimensions,undoCount:b.elements.length};
  });
  assert.equal(result.count,6);assert.deepEqual(result.bounds,result.original);assert.equal(result.undoCount,1);assert.equal(result.dimensions.reduce((sum,d)=>sum+d.w*d.h,0),101*73);
});

test('浏览器：宫格预览与自定义间距在确认前不切割',async()=>{
  await page.evaluate(async()=>{resetBoard();await testImage(64,48);});
  await page.locator('[data-edit="grid"]').click();
  await page.locator('#grid-popover').waitFor({state:'visible'});
  assert.equal(await page.locator('#grid-preview').evaluate(el=>el.tagName),'CANVAS');
  assert.deepEqual(await page.locator('#grid-custom input').evaluateAll(inputs=>inputs.map(input=>input.name)),['cols','rows','gap']);
  await page.waitForFunction(()=>document.querySelector('#grid-apply')&&!document.querySelector('#grid-apply').disabled);
  const before=await page.evaluate(()=>({count:quickdraw.elements.length,preview:document.querySelector('#grid-preview').toDataURL()}));
  await page.locator('#grid-popover [data-grid="2×2"]').click();
  await page.locator('#grid-custom [name="gap"]').fill('4');
  await page.waitForFunction(old=>document.querySelector('#grid-preview').toDataURL()!==old,before.preview);
  const previewState=await page.evaluate(()=>({count:quickdraw.elements.length,cols:document.querySelector('#grid-custom [name="cols"]').value,rows:document.querySelector('#grid-custom [name="rows"]').value,gap:document.querySelector('#grid-custom [name="gap"]').value}));
  assert.equal(previewState.count,before.count);assert.equal(previewState.cols,'2');assert.equal(previewState.rows,'2');assert.equal(previewState.gap,'4');
  await page.waitForFunction(()=>!document.querySelector('#grid-apply').disabled);
  await page.locator('#grid-apply').click();
  await page.waitForFunction(()=>quickdraw.elements.filter(el=>el.type==='image').length===4);
  const pieces=await page.evaluate(()=>quickdraw.elements.filter(el=>el.type==='image').map(el=>({x:el.x,y:el.y,w:el.w,h:el.h})));
  assert.ok(pieces[1].x-(pieces[0].x+pieces[0].w)>=3.9);assert.ok(pieces[2].y-(pieces[0].y+pieces[0].h)>=3.9);
});

test('浏览器：宫格拼图入口只对完整的纯图片群组显示',async()=>{
  const result=await page.evaluate(async()=>{
    const b=resetBoard(),images=[await testImage(24,18),await testImage(24,18)];
    for(const image of images)image.groupId='grid-group';
    b.setSelection(images,false);b.updateEditingUI();
    const valid={group:b.getImageGridGroup().map(el=>el.id),visible:!document.querySelector('[data-edit="stitch-grid"]').hidden};
    const shape={id:QDCore.newId('e'),type:'rect',x:300,y:300,w:24,h:18,fill:'solid',stroke:'none',color:'#000',groupId:'grid-group'};
    b.elements.push(shape);b.setSelection([...images,shape],false);b.updateEditingUI();
    return{valid,invalid:{group:b.getImageGridGroup().length,visible:!document.querySelector('[data-edit="stitch-grid"]').hidden}};
  });
  assert.equal(result.valid.group.length,2);assert.equal(result.valid.visible,true);assert.equal(result.invalid.group,0);assert.equal(result.invalid.visible,false);
});

test('浏览器：宫格拼图保留原群组并支持撤销',async()=>{
  const result=await page.evaluate(async()=>{
    const b=resetBoard(),images=[];
    for(let i=0;i<4;i++){const image=await testImage(20,16);image.x=300+(i%2)*20;image.y=300+Math.floor(i/2)*16;image.groupId='grid-group';images.push(image);}
    b.setSelection(images,false);b.commit();const originalIds=images.map(el=>el.id),originalGroup=images.map(el=>el.groupId);await b.stitchImageGrid(2,2,2);
    const stitched=b.elements.find(el=>!originalIds.includes(el.id)),beforeUndo={count:b.elements.length,stitched:stitched?.type==='image',original:originalIds.every(id=>b.elements.some(el=>el.id===id&&el.groupId==='grid-group')),right:stitched?.x>=Math.max(...images.map(el=>el.x+el.w)),size:stitched&&await assetPixel(stitched,0,0)};
    b.undo();return{beforeUndo,afterUndo:{count:b.elements.length,ids:b.elements.map(el=>el.id),groups:images.map(el=>el.groupId)},originalIds,originalGroup};
  });
  assert.equal(result.beforeUndo.count,5);assert.equal(result.beforeUndo.stitched,true);assert.equal(result.beforeUndo.original,true);assert.equal(result.beforeUndo.right,true);assert.deepEqual([result.beforeUndo.size.w,result.beforeUndo.size.h],[42,34]);
  assert.equal(result.afterUndo.count,4);assert.deepEqual(result.afterUndo.ids,result.originalIds);assert.deepEqual(result.afterUndo.groups,result.originalGroup);
});

test('浏览器：拼图正间距透明，负间距由后一张图片覆盖',async()=>{
  for(const gap of [4,-4]){
    const result=await page.evaluate(async gap=>{
      const b=resetBoard(),left=await testImage(20,16),right=await testImage(20,16);right.x=left.x+30;left.groupId=right.groupId='pair';b.setSelection([left,right],false);b.commit();await b.stitchImageGrid(2,1,gap);
      const output=b.selectedElement;return await assetPixel(output,gap>0?21:18,8);
    },gap);
    assert.equal(result.w,40+gap);assert.deepEqual(result.pixel,gap>0?[0,0,0,0]:[255,0,0,255]);
  }
});

test('浏览器：镜像切图预览跟随画布方向',async()=>{
  const result=await page.evaluate(async()=>{
    const b=resetBoard();await testImage(100,80);b.flipSelection('x');b.openGridEditor('split');await b.refreshGridPreview();const canvas=document.querySelector('#grid-preview');return Array.from(canvas.getContext('2d').getImageData(10,10,1,1).data);
  });
  assert.ok(result[2]>result[0]);
});

test('浏览器：旋转图片的鼠标裁剪使用本地坐标，双击确认并保持固定比例',async()=>{
  await page.evaluate(async()=>{const b=resetBoard();await testImage();b.rotateSelection(Math.PI/2);b.beginRatioCrop(1);});
  const pts=await page.evaluate(()=>{const el=quickdraw.selectedElement;return [{x:310,y:310},{x:350,y:350}].map(p=>QDVector.point(el.transform,p));});
  await page.mouse.move(pts[0].x,pts[0].y);await page.mouse.down();await page.mouse.move(pts[1].x,pts[1].y,{steps:5});await page.mouse.up();
  const pending=await page.evaluate(()=>({active:!!quickdraw.cropTarget,rect:quickdraw.cropRect,w:quickdraw.selectedElement.w,h:quickdraw.selectedElement.h}));
  assert.equal(pending.active,true);assert.equal(pending.rect.w,40);assert.equal(pending.rect.h,40);assert.equal(pending.w,100);assert.equal(pending.h,80);
  const confirm=await page.evaluate(()=>QDVector.point(quickdraw.selectedElement.transform,{x:330,y:330}));
  await page.mouse.dblclick(confirm.x,confirm.y);
  await page.waitForFunction(()=>!quickdraw.cropTarget);
  const result=await page.evaluate(async()=>{const el=quickdraw.selectedElement;return{w:el.w,h:el.h,transform:el.transform,...await assetPixel(el,0,0)};});
  assert.equal(result.w,40);assert.equal(result.h,40);assert.equal(result.transform[1],1);assert.deepEqual(result.pixel,[255,0,0,255]);
});

test('浏览器：裁剪框内部可移动，八个控制点可缩放，比例裁剪保持比例且 Esc 取消',async()=>{
  const handles=[
    ['nw',{x:320,y:315},{x:315,y:310}],['n',{x:340,y:315},{x:340,y:310}],['ne',{x:360,y:315},{x:365,y:310}],['e',{x:360,y:330},{x:365,y:330}],
    ['se',{x:360,y:345},{x:365,y:350}],['s',{x:340,y:345},{x:340,y:350}],['sw',{x:320,y:345},{x:315,y:350}],['w',{x:320,y:330},{x:315,y:330}]
  ];
  for(const [name,start,end] of handles){
    const state=await page.evaluate(async()=>{const b=resetBoard();const el=await testImage(100,80);b.beginRatioCrop(0);return{assetId:el.assetId,original:{x:el.x,y:el.y,w:el.w,h:el.h}};});
    const drag=async(a,b)=>{await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:3});await page.mouse.up();};
    await drag({x:320,y:315},{x:360,y:345});
    const before=await page.evaluate(()=>({...quickdraw.cropRect}));
    await drag(start,end);
    const after=await page.evaluate(()=>({active:!!quickdraw.cropTarget,rect:{...quickdraw.cropRect}}));
    assert.equal(after.active,true,name);assert.ok(after.rect.w>0&&after.rect.h>0,name);assert.ok(after.rect.w!==before.w||after.rect.h!==before.h,name);
    await page.keyboard.press('Escape');
    const cancelled=await page.evaluate(original=>{const el=quickdraw.selectedElement;return{active:!!quickdraw.cropTarget,rect:quickdraw.cropRect,assetId:el.assetId,box:{x:el.x,y:el.y,w:el.w,h:el.h},history:quickdraw.history.length};},state.original);
    assert.equal(cancelled.active,false,name);assert.equal(cancelled.rect,null,name);assert.equal(cancelled.assetId,state.assetId,name);assert.deepEqual(cancelled.box,state.original,name);
  }

  const ratio=await page.evaluate(async()=>{const b=resetBoard();await testImage(100,80);b.beginRatioCrop(1);return true;});
  assert.equal(ratio,true);
  const drag=async(a,b)=>{await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:4});await page.mouse.up();};
  await drag({x:320,y:315},{x:350,y:345});
  await drag({x:350,y:345},{x:370,y:365});
  const resized=await page.evaluate(()=>{const rect={...quickdraw.cropRect},bounds=quickdraw.getRawElementBBox(quickdraw.cropTarget);return{rect,bounds};});
  assert.ok(resized.rect.w>30);assert.ok(Math.abs(resized.rect.w/resized.rect.h-1)<.001);
  assert.ok(resized.rect.x>=resized.bounds.x&&resized.rect.y>=resized.bounds.y);
  assert.ok(resized.rect.x+resized.rect.w<=resized.bounds.x+resized.bounds.w&&resized.rect.y+resized.rect.h<=resized.bounds.y+resized.bounds.h);
  const center={x:resized.rect.x+resized.rect.w/2,y:resized.rect.y+resized.rect.h/2};
  await drag(center,{x:center.x+5,y:center.y+5});
  const moved=await page.evaluate(()=>({...quickdraw.cropRect}));
  assert.deepEqual(moved,{...resized.rect,x:resized.rect.x+5,y:resized.rect.y+5});
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(()=>quickdraw.cropTarget),null);
});

test('浏览器：图层快捷键支持后移、前移、置底、置顶并可撤销且保持多选顺序',async()=>{
  const setup=()=>page.evaluate(()=>{
    const b=resetBoard(),items=['a','b','c','d','e'].map((id,i)=>({id,type:'rect',x:300+i*30,y:300,w:20,h:20,fill:'solid',stroke:'none',color:'#111'}));
    b.elements=items;b.setSelection([items[1],items[3]],false);b.commit();b.container.focus();return items.map(el=>el.id);
  });
  const run=async(key)=>{const original=await setup();await page.keyboard.press(key);const moved=await page.evaluate(()=>({ids:quickdraw.elements.map(el=>el.id),selected:quickdraw.getSelectedElements().map(el=>el.id)}));await page.evaluate(()=>quickdraw.undo());const undone=await page.evaluate(()=>quickdraw.elements.map(el=>el.id));return{original,moved,undone};};
  const backward=await run('Control+[');assert.deepEqual(backward.moved.ids,['b','a','d','c','e']);assert.deepEqual(backward.moved.selected,['b','d']);assert.deepEqual(backward.undone,backward.original);
  const forward=await run('Control+]');assert.deepEqual(forward.moved.ids,['a','c','b','e','d']);assert.deepEqual(forward.moved.selected,['b','d']);assert.deepEqual(forward.undone,forward.original);
  const bottom=await run('Control+Shift+[');assert.deepEqual(bottom.moved.ids,['b','d','a','c','e']);assert.deepEqual(bottom.moved.selected,['b','d']);assert.deepEqual(bottom.undone,bottom.original);
  const top=await run('Control+Shift+]');assert.deepEqual(top.moved.ids,['a','c','e','b','d']);assert.deepEqual(top.moved.selected,['b','d']);assert.deepEqual(top.undone,top.original);
});

for(const operation of ['intersect','subtract','split-mask'])test(`浏览器：${operation} 按形状填充遮罩并能撤销`,async()=>{
  const result=await page.evaluate(async operation=>{
    const b=resetBoard(),image=await testImage(),shape={id:QDCore.newId('e'),type:'rect',x:300,y:300,w:50,h:80,fill:'solid',stroke:'none',color:'#000',size:4};b.elements.push(shape);b.setSelection([image,shape]);b.commit();await b.maskImage(operation);const pixels=[];for(const el of b.elements)pixels.push({left:await assetPixel(el,10,10),right:await assetPixel(el,90,10)});b.undo();return{pixels,undoTypes:b.elements.map(el=>el.type)};
  },operation);
  assert.deepEqual(result.undoTypes,['image','rect']);assert.equal(result.pixels.length,operation==='split-mask'?2:1);
  assert.equal(result.pixels[0].left.pixel[3],operation==='subtract'?0:255);
  assert.equal(result.pixels[0].right.pixel[3],operation==='subtract'?255:0);
});

test('浏览器：笔迹遮罩只使用实际粗细，空白框内不会误裁',async()=>{
  const result=await page.evaluate(async()=>{
    const b=resetBoard(),image=await testImage(),shape={id:QDCore.newId('e'),type:'draw',points:[{x:310,y:310},{x:390,y:370}],fill:'none',color:'#000',size:10};b.elements.push(shape);b.setSelection([image,shape]);b.commit();await b.maskImage('intersect');const el=b.elements[0];return{line:await assetPixel(el,50,40),blank:await assetPixel(el,10,60)};
  });
  assert.equal(result.line.pixel[3],255);assert.equal(result.blank.pixel[3],0);
});

test('浏览器：OpenCV 透明轮廓产生带孔洞的可编辑矢量 SVG',async()=>{
  const result=await page.evaluate(async()=>{
    const b=resetBoard();await testImage(100,80,true);await b.traceImageOutline();const el=b.selectedElement;if(el.type!=='path')throw new Error(document.querySelector('#toast').textContent);const original=JSON.stringify(el.paths);el.fillColor='#00ff00';el.strokeColor='#ff00ff';el.stroke='solid';el.size=2;
    const canvas=document.createElement('canvas');canvas.width=800;canvas.height=600;const ctx=canvas.getContext('2d');b.drawElement(ctx,el);const p=QDVector.point(QDVector.matrix(el),{x:350,y:340}),q=QDVector.point(QDVector.matrix(el),{x:310,y:310});const hole=Array.from(ctx.getImageData(p.x,p.y,1,1).data),fill=Array.from(ctx.getImageData(q.x,q.y,1,1).data);const svg=b.svgElementMarkup(el);b.commit();await b.saveFileNow();await b.openFile(b.currentFileId,false,true);const loaded=b.elements.find(el=>el.type==='path');return {paths:el.paths.length,hole,fill,svg,roundTrip:JSON.stringify(loaded.paths)===original,transform:loaded.transform};
  });
  assert.ok(result.paths>=2);assert.equal(result.hole[3],0);assert.deepEqual(result.fill,[0,255,0,255]);assert.match(result.svg,/fill-rule="evenodd"/);assert.match(result.svg,/stroke="#ff00ff"/);assert.equal(result.roundTrip,true);
});

test('浏览器：描摹路径的边框工具栏与实际 SVG 状态同步且首次启用有效',async()=>{
  const result=await page.evaluate(async()=>{
    const b=resetBoard();await testImage(100,80);await b.traceImageOutline();const el=b.selectedElement;
    const active=()=>Object.fromEntries([...document.querySelectorAll('.stroke-option')].map(button=>[button.dataset.stroke,button.classList.contains('active')]));
    const before={stroke:el.stroke,active:active(),svg:b.svgElementMarkup(el)};
    document.querySelector('.stroke-option[data-stroke="solid"]').click();
    return {before,after:{stroke:el.stroke,active:active(),svg:b.svgElementMarkup(el)}};
  });
  assert.equal(result.before.stroke,'none');assert.equal(result.before.active.none,true);assert.equal(result.before.active.solid,false);assert.match(result.before.svg,/stroke="none"/);
  assert.equal(result.after.stroke,'solid');assert.equal(result.after.active.solid,true);assert.match(result.after.svg,/stroke="#[0-9a-f]+"/i);
});

test('浏览器：钢笔添加曲线、闭合、节点移动及 SVG 导出',async()=>{
  await page.evaluate(()=>resetBoard());await page.locator('[data-tool="pen"]').click();
  assert.equal(await page.locator('#pen-help').count(),0);
  await page.mouse.click(300,300);await page.mouse.move(450,300);await page.mouse.down();await page.mouse.move(490,260,{steps:5});await page.mouse.up();await page.mouse.click(450,450);await page.mouse.click(300,300);
  const first=await page.evaluate(()=>({type:quickdraw.elements[0]?.type,path:quickdraw.elements[0]?.paths[0],svg:quickdraw.svgElementMarkup(quickdraw.elements[0])}));
  assert.equal(first.type,'path');assert.equal(first.path.closed,true);assert.ok(first.path.nodes[1].out);assert.match(first.svg,/ C/);
  await page.mouse.move(300,300);await page.mouse.down();await page.mouse.move(320,320,{steps:4});await page.mouse.up();
  assert.equal(await page.evaluate(()=>quickdraw.elements[0].paths[0].nodes[0].x),320);
  await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>quickdraw.currentTool),'select');
});

test('钢笔在 131% 缩放下首次及旋转后拖动均贴随鼠标，往返不漂移',async()=>{
  await page.evaluate(()=>resetBoard());await page.locator('[data-tool="pen"]').click();
  await page.mouse.click(300,300);await page.mouse.move(450,300);await page.mouse.down();await page.mouse.move(490,260,{steps:4});await page.mouse.up();await page.mouse.click(450,450);await page.keyboard.press('Enter');
  await page.evaluate(()=>{quickdraw.scale=1.31;quickdraw.offsetX=40;quickdraw.offsetY=-30;quickdraw.renderNow();});
  for(const transformed of [false,true]){
    const start=await page.evaluate(transformed=>{
      const b=quickdraw;if(transformed){b.rotateSelection(.4);b.flipSelection('x');}
      const el=b.selectedElement,[a,z]=el.paths[0].nodes,c=a.out||a,d=z.in||z,p={x:(a.x+3*c.x+3*d.x+z.x)/8,y:(a.y+3*c.y+3*d.y+z.y)/8};
      const world=QDVector.point(QDVector.matrix(el),p);return{screen:b.worldToScreen(world.x,world.y),p,paths:JSON.stringify(el.paths),matrix:QDVector.matrix(el)};
    },transformed);
    await page.mouse.move(start.screen.x,start.screen.y);await page.mouse.down();
    for(const [dx,dy] of [[20,10],[70,35],[110,55],[30,15],[0,0],[80,40]]){
      await page.mouse.move(start.screen.x+dx,start.screen.y+dy,{steps:4});
      const actual=await page.evaluate(p=>{const b=quickdraw,el=b.selectedElement,world=QDVector.point(QDVector.matrix(el),p);return{screen:b.worldToScreen(world.x,world.y),paths:JSON.stringify(el.paths),matrix:QDVector.matrix(el)};},start.p);
      assert.ok(Math.abs(actual.screen.x-start.screen.x-dx)<.1);assert.ok(Math.abs(actual.screen.y-start.screen.y-dy)<.1);
      assert.equal(actual.paths,start.paths);assert.deepEqual(actual.matrix.slice(0,4),start.matrix.slice(0,4));
    }
    await page.mouse.up();
    const undone=await page.evaluate(()=>{quickdraw.undo();const el=quickdraw.elements[0];quickdraw.setSelection([el]);return QDVector.matrix(el);});
    for(let i=0;i<6;i++)assert.ok(Math.abs(undone[i]-start.matrix[i])<.001);
  }
});

test('浏览器：四角外侧拖拽旋转、Esc 恢复并且没有脚本异常',async()=>{
  await page.evaluate(async()=>{resetBoard();await testImage();});
  await page.mouse.move(288,288);await page.mouse.down();await page.mouse.move(420,280,{steps:5});
  assert.equal(await page.evaluate(()=>!!quickdraw.rotationDrag),true);
  await page.keyboard.press('Escape');await page.mouse.up();assert.equal(await page.evaluate(()=>quickdraw.elements[0].transform),undefined);
  assert.deepEqual(errors,[]);
});

test('浏览器：窄侧栏与深色主题的工具可见',async()=>{
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{quickdraw.theme='dark';quickdraw.applyTheme();quickdraw.renderNow();});
  await page.locator('[data-edit="grid"]').click();const box=await page.locator('#grid-popover').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=390);
  const duplicates=await page.evaluate(()=>{const ids=[...document.querySelectorAll('[id]')].map(el=>el.id);return ids.filter((id,i)=>ids.indexOf(id)!==i);});assert.deepEqual(duplicates,[]);
  const colors=await page.locator('[data-grid="2×1"]').evaluate(el=>({color:getComputedStyle(el).color,background:getComputedStyle(el).backgroundColor}));assert.notEqual(colors.background,'rgb(255, 255, 255)');
  if(process.env.QD_SCREENSHOT_DIR){fs.mkdirSync(process.env.QD_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.QD_SCREENSHOT_DIR,'sidebar-dark.png')});}
});

test('浏览器：旋转箭头仍可编辑曲率，节点连接锚点跟随旋转',async()=>{
  await page.setViewportSize({width:1400,height:1000});
  const initial=await page.evaluate(()=>{
    const b=resetBoard(),el={id:'arrow',type:'arrow',x:300,y:300,w:120,h:0,bend:0,color:'#111',size:4};b.elements.push(el);b.setSelection([el]);b.commit();b.rotateSelection(Math.PI/2);return {mid:QDVector.point(el.transform,{x:360,y:300}),end:QDVector.point(el.transform,{x:360,y:330})};
  });
  await page.mouse.move(initial.mid.x,initial.mid.y);await page.mouse.down();await page.mouse.move(initial.end.x,initial.end.y,{steps:5});await page.mouse.up();assert.ok(Math.abs(await page.evaluate(()=>quickdraw.elements[0].bend)-60)<.01);
  const result=await page.evaluate(()=>{const b=resetBoard(),node={id:'n',type:'mindnode',x:100,y:100,w:100,h:40,text:'A'};b.elements.push(node);b.setSelection([node]);b.rotateSelection(Math.PI/2);return b.mindAnchorPoint(node,'right');});assert.ok(Math.abs(result.x-150)<.001);assert.ok(Math.abs(result.y-170)<.001);
});

test('浏览器：路径可通过右侧颜色面板改色，导出的 SVG 和 PNG 确实可解码',async()=>{
  const result=await page.evaluate(async()=>{
    const b=resetBoard(),el={id:'p',type:'path',paths:[{closed:true,nodes:[{x:300,y:300},{x:400,y:300},{x:400,y:400},{x:300,y:400}]}],fill:'solid',stroke:'none',color:'#ff0000',fillColor:'#ff0000',size:4};b.elements.push(el);b.setSelection([el]);b.setStyle('color','#00ff00',null,'.color-dot');b.rotateSelection(Math.PI/4);const png=await b.createPNGBlob(true),svg=await b.createSVGDocument(true),decoded=await b.loadCropDrawable(new Blob([svg.svg],{type:'image/svg+xml'}));
    const c=document.createElement('canvas');c.width=decoded.width;c.height=decoded.height;const ctx=c.getContext('2d');ctx.drawImage(decoded.drawable,0,0);const pixels=ctx.getImageData(0,0,c.width,c.height).data;let green=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]===0&&pixels[i+1]===255&&pixels[i+3]===255)green++;decoded.dispose();const bitmap=await createImageBitmap(png);const dimensions=[bitmap.width,bitmap.height];bitmap.close();return{fill:el.fillColor,green,dimensions};
  });assert.equal(result.fill,'#00ff00');assert.ok(result.green>9000);assert.ok(result.dimensions[0]>100);
});

test('浏览器：处理期间删除原图不会写入过时结果',async()=>{
  const result=await page.evaluate(async()=>{
    const b=resetBoard(),image=await testImage();let finish;const pending=b.runEditingTask([image],()=>new Promise(resolve=>{finish=resolve;}));b.deleteSelected();finish({items:[{...image,id:'late'}]});await pending;return{count:b.elements.length,message:document.querySelector('#toast').textContent};
  });assert.equal(result.count,0);assert.match(result.message,/结果未写入/);
});

test('旋转选框贴合图片四角，沿旋转方向缩放且对角固定',async()=>{
  const initial=await page.evaluate(async()=>{
    const b=resetBoard(),el=await testImage();b.rotateSelection(Math.PI/4);
    const corners=QDVector.corners(b.getRawElementBBox(el)).map(p=>QDVector.point(el.transform,p));
    const handles=b.selectionFrameHandles(),frameCorners=['nw','ne','se','sw'].map(name=>handles.find(h=>h.name===name));
    return {corners,frameCorners,hit:frameCorners.map(p=>b.hitHandle(p)),target:QDVector.point(el.transform,{x:500,y:460}),transform:[...el.transform]};
  });
  for(let i=0;i<4;i++){assert.ok(Math.hypot(initial.frameCorners[i].x-initial.corners[i].x,initial.frameCorners[i].y-initial.corners[i].y)<.001);}
  assert.deepEqual(initial.hit,['nw','ne','se','sw']);
  await page.mouse.move(initial.corners[2].x,initial.corners[2].y);await page.mouse.down();await page.keyboard.down('Shift');await page.mouse.move(initial.target.x,initial.target.y,{steps:8});await page.mouse.up();await page.keyboard.up('Shift');
  const result=await page.evaluate(()=>{const b=quickdraw,el=b.selectedElement,corners=QDVector.corners(b.getRawElementBBox(el)).map(p=>QDVector.point(el.transform,p));return{corners,transform:el.transform};});
  assert.ok(Math.hypot(result.corners[0].x-initial.corners[0].x,result.corners[0].y-initial.corners[0].y)<.01);
  assert.ok(Math.hypot(result.corners[2].x-initial.target.x,result.corners[2].y-initial.target.y)<.01);
  assert.ok(Math.abs(Math.atan2(result.transform[1],result.transform[0])-Math.PI/4)<.001);
  if(process.env.QD_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.QD_SCREENSHOT_DIR,'rotated-frame.png')});
});

test('旋转后的四角仍能再次旋转，多选框也跟随旋转',async()=>{
  const result=await page.evaluate(async()=>{
    const b=resetBoard(),el=await testImage();b.rotateSelection(Math.PI/3);const f=b.getSelectionFrame(),c=QDVector.point(f.matrix,{x:300,y:300}),center=QDVector.point(f.matrix,{x:350,y:340}),len=Math.hypot(c.x-center.x,c.y-center.y),probe={x:c.x+(c.x-center.x)/len*14,y:c.y+(c.y-center.y)/len*14};
    const hit=b.rotationHandleAt(probe),other={id:'rect2',type:'rect',x:450,y:300,w:50,h:50,fill:'solid',color:'#111',stroke:'none'};b.elements.push(other);b.setSelection([el,other]);const before=b.selectionFrameHandles();b.rotateSelection(Math.PI/6);const after=b.selectionFrameHandles();return{hit,before,after};
  });assert.equal(result.hit,true);
  const angle=points=>Math.atan2(points[2].y-points[0].y,points[2].x-points[0].x);
  assert.ok(Math.abs(angle(result.after)-angle(result.before)-Math.PI/6)<.001);
});

test('清理画板实际移除图片、历史及缓存，同时保留偏好和目录句柄',async()=>{
  const result=await page.evaluate(async()=>{
    const b=resetBoard(),el=await testImage();b.theme='dark';b.gridType='dots';b.snapToGrid=false;b.currentMindStyle='orthogonal';b.applyTheme();await b.savePreferences();await b.saveFileNow();
    const oldId=b.currentFileId,assetId=el.assetId,root=await navigator.storage.getDirectory(),directory=await root.getDirectoryHandle('saved-export',{create:true});await b.store.putHandle(b.EXPORT_DIRECTORY_KEY,directory);
    await b.store.saveVersion(oldId,{elements:b.elements},'测试版本',true);
    await b.storageSet({quickdraw_elements:'legacy',pending_image:'data:image/png;base64,AA','quickdraw_v2_file:orphan':{elements:[el]}});
    await b.store.set({'quickdraw_pending_capture:test':{kind:'test'}},'session');
    const prefs=(await b.storageGet([b.PREF_KEY]))[b.PREF_KEY];await b.confirmClearStorage();
    const afterPrefs=(await b.storageGet([b.PREF_KEY]))[b.PREF_KEY],handle=await b.store.getHandle(b.EXPORT_DIRECTORY_KEY),deleted=await b.storageGet([b.fileKey(oldId),'quickdraw_v2_file:orphan','quickdraw_elements','pending_image']);
    return{prefs,afterPrefs,directory:handle?.name,sameHandle:await directory.isSameEntry(handle),label:document.querySelector('#export-directory-label').textContent,asset:await b.store.getAsset(assetId),versions:await b.store.listVersions(oldId),deleted,capture:await b.store.get(['quickdraw_pending_capture:test'],'session'),elements:b.elements.length,history:b.history.length,redos:b.redos.length,images:b.imageCache.size,urls:b.store.objectUrls.size,spatial:b.spatialIndex.size,theme:b.theme,grid:b.gridType,snap:b.snapToGrid,files:b.fileIndex.files.length};
  });
  assert.deepEqual(result.prefs,result.afterPrefs);assert.equal(result.directory,'saved-export');assert.equal(result.sameHandle,true);assert.equal(result.label,'saved-export');assert.equal(result.asset,null);assert.deepEqual(result.versions,[]);assert.deepEqual(result.deleted,{});assert.deepEqual(result.capture,{});
  for(const name of ['elements','history','redos','images','urls','spatial'])assert.equal(result[name],0,name);
  assert.equal(result.theme,'dark');assert.equal(result.grid,'dots');assert.equal(result.snap,false);assert.equal(result.files,1);
  await page.reload();await page.waitForFunction(()=>window.quickdraw?.fileIndex);
  const loaded=await page.evaluate(async()=>({theme:quickdraw.theme,grid:quickdraw.gridType,snap:quickdraw.snapToGrid,directory:(await quickdraw.store.getHandle(quickdraw.EXPORT_DIRECTORY_KEY))?.name,elements:quickdraw.elements.length}));
  assert.deepEqual(loaded,{theme:'dark',grid:'dots',snap:false,directory:'saved-export',elements:0});
});

test('Chrome 存储分支按键删除画板数据，不清空设置',async()=>{
  const result=await page.evaluate(async()=>{
    const original=chrome.storage,local={quickdraw_v2_prefs:{theme:'dark'},quickdraw_v2_files:{files:[]},'quickdraw_v2_file:test':{elements:[]},customSetting:42},session={'quickdraw_pending_capture:1':{data:'capture'},sessionSetting:'keep'},removed=[];
    const area=(values,name)=>({get:async()=>({...values}),remove:async keys=>{removed.push({name,keys});for(const key of keys)delete values[key];},clear:async()=>{throw new Error('不应调用 clear');}});
    chrome.storage={local:area(local,'local'),session:area(session,'session')};
    try{await quickdraw.store.clearDrawingData();return{local,session,removed};}finally{if(original)chrome.storage=original;else delete chrome.storage;}
  });
  assert.deepEqual(result.local,{quickdraw_v2_prefs:{theme:'dark'},customSetting:42});assert.deepEqual(result.session,{sessionSetting:'keep'});assert.equal(result.removed.length,2);
});
