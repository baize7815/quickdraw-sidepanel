(() => {
  'use strict';
  const V=globalThis.QDVector, clone=value=>QDCore.clone(value), id=()=>QDCore.newId('e');
  const $=selector=>document.querySelector(selector);
  const svg=body=>`<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
  const button=(name,title,body)=>`<button type="button" class="icon-btn" data-edit="${name}" title="${title}" aria-label="${title}">${svg(body)}</button>`;
  const toBlob=canvas=>new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('图片编码失败。')),'image/png'));
  const makeCanvas=(w,h)=>{
    if(!Number.isFinite(w*h)||w<1||h<1||w>16384||h>16384||w*h>12_000_000)throw new Error('处理范围超过 1200 万像素或单边 16384 像素，请先缩小图片。');
    const canvas=document.createElement('canvas');canvas.width=Math.ceil(w);canvas.height=Math.ceil(h);return canvas;
  };
  const shapeTypes=new Set(['rect','ellipse','triangle','diamond','hexagon','star','cloud','draw','highlight','line','arrow','path']);

  globalThis.QDEditing={
    setupEditingUI(){
      const alignIcons={
        left:'M4 3v18M8 5h10v5H8zM8 14h7v5H8z',hcenter:'M12 2v20M5 5h14v5H5zM8 14h8v5H8z',right:'M20 3v18M6 5h10v5H6zM9 14h7v5H9z',
        top:'M3 4h18M5 8h5v10H5zM14 8h5v7h-5z',vcenter:'M2 12h20M5 5h5v14H5zM14 8h5v8h-5z',bottom:'M3 20h18M5 6h5v10H5zM14 9h5v7h-5z'
      };
      for(const b of document.querySelectorAll('[data-align]')){b.innerHTML=svg(`<path d="${alignIcons[b.dataset.align]}"/>`);b.setAttribute('aria-label',b.title);}
      for(const b of document.querySelectorAll('[data-distribute]')){
        b.innerHTML=svg(`<g${b.dataset.distribute==='y'?' transform="rotate(90 12 12)"':''}><path d="M3 3v18M21 3v18M6 7h3v10H6zM15 7h3v10h-3zM11 12h2"/></g>`);b.title=b.dataset.distribute==='x'?'横向等间距':'纵向等间距';b.setAttribute('aria-label',b.title);b.classList.add('arrange-icon');
      }
      for(const [selector,title,icon] of [['#btn-layout-mind','自动整理分支','M3 10h5v5H3zM16 3h5v5h-5zM16 16h5v5h-5zM8 12h4M12 5v14M12 5h4M12 19h4'],['#btn-collapse-mind','折叠 / 展开分支','M4 4h16v16H4zM8 12h8M12 8v8']]){const b=$(selector);b.innerHTML=svg(`<path d="${icon}"/>`);b.title=title;b.setAttribute('aria-label',title);b.classList.add('arrange-icon');}
      const action=document.createElement('div');action.className='image-extra-actions';
      action.innerHTML=button('grid','宫格切图（列 × 行）','<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/>')+button('trace-menu','透明轮廓转 SVG 形状','<path d="M5 7c-3 5 0 12 5 12 7 0 11-5 8-11-3-6-10-6-13-1z"/><rect x="3" y="5" width="4" height="4"/><rect x="16" y="6" width="4" height="4"/><rect x="8" y="17" width="4" height="4"/>');
      $('.actionbar').append(action);
      const root=document.createElement('div');root.id='editing-ui';root.innerHTML=`
        <div id="selection-toolbar" class="selection-toolbar" role="toolbar" aria-label="对象变换与遮罩" hidden>
          <div class="mask-actions">
            ${button('intersect','相交：保留图片与上层形状重合的部分','<rect x="3" y="3" width="12" height="12" rx="2"/><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M9 9h6v6H9z" fill="currentColor"/>')}
            ${button('subtract','相减：从图片扣除上层形状覆盖的部分','<path d="M3 3h12v6H9v6H3z" fill="currentColor"/><path d="M9 9h12v12H9z"/>')}
            ${button('split-mask','分割：生成图片内部与外部两部分','<path d="M2 3h11v5H7v7H2zM11 11h11v11H11z"/><path d="m8 8 8 8"/>')}
            <span class="bar-divider"></span>
          </div>
          ${button('flip-x','水平镜像','<path d="M12 2v20M3 18l6-12v12zM21 18 15 6v12z"/>')}
          ${button('flip-y','垂直镜像','<path d="M2 12h20M6 3l12 6H6zM6 21l12-6H6z"/>')}
          ${button('rotate','顺时针旋转 90° · 也可拖拽选框四角外侧','<path d="M19 9A8 8 0 1 0 20 15M19 3v6h-6"/>')}
          <div id="vector-style" hidden><label title="矢量填充颜色">填充<input id="vector-fill" type="color" value="#1f1f1f" aria-label="矢量填充颜色"></label><label title="矢量描边颜色">描边<input id="vector-stroke" type="color" value="#1f1f1f" aria-label="矢量描边颜色"></label>${button('edit-nodes','编辑钢笔锚点','<path d="M4 18C4 3 20 21 20 6"/><rect x="2" y="16" width="4" height="4"/><rect x="18" y="4" width="4" height="4"/>')}</div>
        </div>
        <div id="crop-popover" class="popover image-options" hidden aria-label="图片裁剪设置"><strong>裁剪比例</strong><div class="preset-grid">${['自由','1:1','9:16','16:9','3:4','4:3'].map(r=>`<button data-crop-ratio="${r}">${r}</button>`).join('')}</div><form id="crop-custom"><label>宽<input name="width" type="number" min="0.01" step="any" value="1" required aria-label="自定义裁剪宽"></label><span>×</span><label>高<input name="height" type="number" min="0.01" step="any" value="1" required aria-label="自定义裁剪高"></label><button type="submit">开始</button></form><p>拖框保留内容 · Esc 取消</p></div>
        <div id="grid-popover" class="popover image-options" hidden aria-label="宫格切图设置"><strong>宫格切图 · 列 × 行</strong><div class="preset-grid">${['2×1','1×2','2×2','3×3'].map(r=>`<button data-grid="${r}">${r}</button>`).join('')}</div><form id="grid-custom"><label>列<input name="cols" type="number" min="1" max="100" value="2" required aria-label="切图列数"></label><span>×</span><label>行<input name="rows" type="number" min="1" max="100" value="2" required aria-label="切图行数"></label><button type="submit">切割</button></form><p>最多 100 块，每块可独立移动；支持撤销。</p></div>
        <div id="trace-popover" class="popover image-options" hidden aria-label="透明轮廓提取"><strong>透明轮廓 → 矢量形状</strong><label class="trace-threshold">透明度阈值<input id="trace-threshold" type="number" min="1" max="255" value="16" aria-label="透明度阈值"></label><p>保留内部孔洞，原图保留。无透明背景时仅提取外框。</p><button data-edit="trace" class="primary-button">生成 SVG 形状</button></div>
        `;
      this.app.append(root);
      root.addEventListener('pointerdown',e=>e.stopPropagation());action.addEventListener('pointerdown',e=>e.stopPropagation());
      const dispatch=e=>{const b=e.target.closest('[data-edit]');if(b)this.handleEditingAction(b.dataset.edit);};root.addEventListener('click',dispatch);action.addEventListener('click',dispatch);
      for(const b of root.querySelectorAll('[data-crop-ratio]'))b.addEventListener('click',()=>{const parts=b.dataset.cropRatio.split(':').map(Number);this.beginRatioCrop(parts.length===2?parts[0]/parts[1]:0);});
      for(const b of root.querySelectorAll('[data-grid]'))b.addEventListener('click',()=>this.splitImageGrid(...b.dataset.grid.split('×').map(Number)));
      $('#crop-custom').addEventListener('submit',e=>{e.preventDefault();const f=e.target;this.beginRatioCrop(Number(f.elements.width.value)/Number(f.elements.height.value));});
      $('#grid-custom').addEventListener('submit',e=>{e.preventDefault();const f=e.target;this.splitImageGrid(Number(f.elements.cols.value),Number(f.elements.rows.value));});
      for(const [selector,key] of [['#vector-fill','fillColor'],['#vector-stroke','strokeColor']])$(selector).addEventListener('change',e=>{
        for(const el of this.getSelectedElements().filter(el=>el.type==='path')){el[key]=e.target.value;if(key==='fillColor')el.fill='solid';else el.stroke='solid';}this.commit();this.render();
      });
      this.updateEditingUI();
    },

    updateEditingUI(){
      if(typeof document==='undefined'||!$('#selection-toolbar'))return;
      const selected=this.getSelectedElements(),oneImage=selected.length===1&&selected[0].type==='image',busy=!!(this.editingBusy||this.backgroundRemovalInProgress||this.watermarkRemovalInProgress);
      $('.image-extra-actions').hidden=!oneImage;
      $('#selection-toolbar').hidden=!selected.length||!!this.cropTarget||!!this.watermarkTarget;
      const canMask=selected.length===2&&selected.filter(el=>el.type==='image').length===1&&selected.some(el=>shapeTypes.has(el.type));
      $('.mask-actions').hidden=!canMask;
      const paths=selected.filter(el=>el.type==='path');$('#vector-style').hidden=!paths.length;
      for(const [selector,key] of [['#vector-fill','fillColor'],['#vector-stroke','strokeColor']]){const input=$(selector);if(paths.length&&document.activeElement!==input)input.value=paths.at(-1)[key]||paths.at(-1).color||'#1f1f1f';}
      for(const b of document.querySelectorAll('[data-edit]'))b.disabled=busy;
      for(const popover of document.querySelectorAll('.image-options')){if(!oneImage)popover.hidden=true;for(const control of popover.querySelectorAll('button,input'))control.disabled=busy;}
    },

    handleEditingAction(action){
      if(action==='grid')return this.toggleEditingPopover('grid-popover');
      if(action==='trace-menu')return this.toggleEditingPopover('trace-popover');
      if(action==='trace')return this.traceImageOutline();
      if(action==='edit-nodes'){this.setTool('pen');this.render();return;}
      if(action==='flip-x'||action==='flip-y')return this.flipSelection(action==='flip-x'?'x':'y');
      if(action==='rotate')return this.rotateSelection(Math.PI/2);
      if(['intersect','subtract','split-mask'].includes(action))return this.maskImage(action);
    },
    toggleEditingPopover(name){const popover=$(`#${name}`),open=popover.hidden;this.closePopovers();popover.hidden=!open;},
    beginRatioCrop(ratio){if(!Number.isFinite(ratio)||ratio<0||ratio>10000){this.toast('请输入有效的宽高比。');return;}this.cropRatio=ratio;if(this.cropTarget)this.cancelImageCrop();this.startImageCrop();},
    imageLocalPoint(el,p){return V.point(V.inverse(V.matrix(el)),p);},
    mindAnchorPoint(node,side){return V.point(V.matrix(node),this.rawMindAnchorPoint(node,side));},
    mindEdgeSamplePoints(edge){const pts=this.rawMindEdgeSamplePoints(edge);return edge.transform?pts.map(p=>V.point(edge.transform,p)):pts;},
    transformTextEditor(editor,el){
      if(!el.transform)return;const m=el.transform,p=V.point(m,el),screen=this.worldToScreen(p.x,p.y),rect=this.container.getBoundingClientRect();
      editor.style.left=`${rect.left+screen.x}px`;editor.style.top=`${rect.top+screen.y}px`;editor.style.transformOrigin='0 0';editor.style.transform=`matrix(${m[0]},${m[1]},${m[2]},${m[3]},0,0)`;
    },

    transformItems(items,m){
      const selected=new Set(items.map(el=>el.id));
      for(const el of items){if(el.type==='mindedge'&&(selected.has(el.fromId)||selected.has(el.toId)))continue;el.transform=V.multiply(m,V.matrix(el));}
      this.spatialDirty=true;
    },
    rotateSelection(angle){const items=this.getSelectedElements(),b=this.getSelectionBBox();if(!b)return;const c={x:b.x+b.w/2,y:b.y+b.h/2},cos=Math.cos(angle),sin=Math.sin(angle);this.transformItems(items,V.around([cos,sin,-sin,cos,0,0],c));this.commit();this.render();},
    flipSelection(axis){const b=this.getSelectionBBox();if(!b)return;this.transformItems(this.getSelectedElements(),V.around([axis==='x'?-1:1,0,0,axis==='y'?-1:1,0,0],{x:b.x+b.w/2,y:b.y+b.h/2}));this.commit();this.render();},
    rotationHandleAt(p){
      const frame=this.getSelectionFrame();if(!frame)return false;
      const b=frame.box,q=V.point(V.inverse(frame.matrix),p);
      if(q.x>=b.x&&q.x<=b.x+b.w&&q.y>=b.y&&q.y<=b.y+b.h)return false;
      return V.corners(b).map(c=>V.point(frame.matrix,c)).some(c=>{const dx=Math.abs(p.x-c.x)*this.scale,dy=Math.abs(p.y-c.y)*this.scale;return Math.max(dx,dy)>9&&Math.hypot(dx,dy)<25;});
    },

    getSelectionFrame(items=this.getSelectedElements()){
      if(!items.length)return null;
      if(items.length===1&&items[0].type!=='mindedge')return {box:this.getRawElementBBox(items[0]),matrix:V.matrix(items[0])};
      // A group frame uses the first object's orientation, keeping its axes stable while rotating.
      const reference=V.matrix(items.find(el=>el.type!=='mindedge')),angle=Math.atan2(reference[1],reference[0]);
      const matrix=[Math.cos(angle),Math.sin(angle),-Math.sin(angle),Math.cos(angle),0,0],inv=V.inverse(matrix),points=[];
      for(const el of items){const b=el.type==='mindedge'?this.getElementBBox(el):this.getRawElementBBox(el);if(!b)continue;const m=el.type==='mindedge'?inv:V.multiply(inv,V.matrix(el));points.push(...V.corners(b).map(p=>V.point(m,p)));}
      const box=V.bounds(points);return box?{box,matrix}:null;
    },
    selectionFrameHandles(frame=this.getSelectionFrame()){
      return frame?this.selectionHandlesForBBox(frame.box).map(h=>({...h,...V.point(frame.matrix,h)})):[];
    },
    drawSelectionFrame(ctx,frame,handles=true,alpha=1){
      if(!frame?.box)return;const corners=V.corners(frame.box).map(p=>V.point(frame.matrix,p));
      ctx.save();ctx.globalAlpha=alpha;ctx.strokeStyle=getComputedStyle(this.app).getPropertyValue('--sel').trim()||'#2f6fed';ctx.fillStyle=this.theme==='dark'?'#191713':'#F9FAFB';ctx.lineWidth=1.5/this.scale;ctx.setLineDash([]);
      ctx.beginPath();corners.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.stroke();
      if(handles){const size=7/this.scale,angle=Math.atan2(frame.matrix[1],frame.matrix[0]);for(const h of this.selectionFrameHandles(frame)){ctx.save();ctx.translate(h.x,h.y);ctx.rotate(angle);ctx.beginPath();ctx.rect(-size/2,-size/2,size,size);ctx.fill();ctx.stroke();ctx.restore();}}
      ctx.restore();
    },

    drawVectorPath(ctx,el){
      const path=new Path2D(V.pathData(el));ctx.fillStyle=el.fillColor||el.color||this.currentColor;ctx.strokeStyle=el.strokeColor||el.color||this.currentColor;
      if(el.fill&&el.fill!=='none'){
        ctx.save();if(el.fill==='semi')ctx.globalAlpha*=.2;
        if(el.fill==='pattern'){ctx.clip(path,'evenodd');ctx.globalAlpha*=.35;ctx.lineWidth=1.2;const b=V.pathBounds(el);for(let x=b.x-b.h;x<b.x+b.w;x+=10){ctx.beginPath();ctx.moveTo(x,b.y+b.h);ctx.lineTo(x+b.h,b.y);ctx.stroke();}}
        else ctx.fill(path,'evenodd');ctx.restore();
      }
      if(el.stroke!=='none')ctx.stroke(path);
    },
    pointInVectorPath(p,el){const ctx=this.ctx;ctx.save();ctx.setTransform(1,0,0,1,0,0);const path=new Path2D(V.pathData(el));ctx.lineWidth=Math.max(el.size||4,8/this.scale);const hit=(el.fill!=='none'&&ctx.isPointInPath(path,p.x,p.y,'evenodd'))||(el.stroke!=='none'&&ctx.isPointInStroke(path,p.x,p.y));ctx.restore();return hit;},
    svgVectorPath(el){const esc=v=>this.xmlEscape(v),fill=el.fill==='none'?'none':el.fill==='pattern'?`url(#${this.patternId(el.color||this.currentColor)})`:el.fillColor||el.color||this.currentColor;return `<path d="${esc(V.pathData(el))}" fill="${esc(fill)}" fill-rule="evenodd" fill-opacity="${el.fill==='semi'?'.2':'1'}" stroke="${esc(el.stroke==='none'?'none':el.strokeColor||el.color||this.currentColor)}" stroke-width="${this.svgNum(el.size||4)}" stroke-linecap="round" stroke-linejoin="round"${this.svgDash(el)?` stroke-dasharray="${this.svgDash(el)}"`:''}/>`;},

    async runEditingTask(targets,task){
      if(this.editingBusy||this.backgroundRemovalInProgress||this.watermarkRemovalInProgress)return this.toast('请等待当前图片处理完成。');
      const file=this.currentFileId,states=targets.map(el=>JSON.stringify(el));this.editingBusy=true;this.closePopovers();this.updateEditingUI();
      const valid=()=>this.currentFileId===file&&targets.every((el,i)=>this.elements.includes(el)&&JSON.stringify(el)===states[i]);
      try{const result=await task();if(!valid())throw new Error('处理期间对象或画板已改变，结果未写入，请重试。');if(!result?.items?.length)throw new Error('没有可生成的内容，原对象已保留。');
        const removed=new Set(result.remove||[]),index=Math.max(...targets.map(el=>this.elements.indexOf(el)));this.elements.splice(index+1,0,...result.items);this.elements=this.elements.filter(el=>!removed.has(el));this.setSelection(result.items,false);this.commit();this.render();this.toast(result.message||'处理完成，可撤销。');
      }catch(error){console.error('Quickdraw image editing',error);this.toast(error.message||'图片处理失败。');}
      finally{this.editingBusy=false;this.updateEditingUI();}
    },

    async splitImageGrid(cols,rows){
      const selected=this.getSelectedElements(),target=selected.length===1&&selected[0].type==='image'?selected[0]:null;if(!target)return;
      return this.runEditingTask([target],async()=>{
        const snapshot=clone(target),record=await this.store.getAsset(snapshot.assetId);if(!record?.blob)throw new Error('图片资源不存在。');
        const source=await this.loadCropDrawable(record.blob);
        try{
          const cells=V.gridCells(source.width,source.height,cols,rows),items=[];
          for(const cell of cells){const canvas=makeCanvas(cell.w,cell.h);canvas.getContext('2d').drawImage(source.drawable,cell.x,cell.y,cell.w,cell.h,0,0,cell.w,cell.h);const assetId=await this.store.putAsset(await toBlob(canvas),{croppedFrom:snapshot.assetId,name:`切片-${items.length+1}.png`});const el={...snapshot,id:id(),assetId,x:snapshot.x+cell.x/source.width*snapshot.w,y:snapshot.y+cell.y/source.height*snapshot.h,w:cell.w/source.width*snapshot.w,h:cell.h/source.height*snapshot.h};delete el.groupId;items.push(el);}
          return {items,remove:[target],message:`已切成 ${cols} × ${rows}，取消选择后可逐块移动。`};
        }finally{source.dispose();}
      });
    },

    async maskImage(operation){
      const selected=this.getSelectedElements(),target=selected.find(el=>el.type==='image'),mask=selected.find(el=>shapeTypes.has(el.type));if(selected.length!==2||!target||!mask)return;
      return this.runEditingTask(selected,async()=>{
        const image=clone(target),shape=clone(mask),record=await this.store.getAsset(image.assetId);if(!record?.blob)throw new Error('图片资源不存在。');const source=await this.loadCropDrawable(record.blob);
        try{
          // Render both objects in the same world rectangle. Only painted alpha becomes the mask.
          const bounds=this.getElementBBox(image),m=V.matrix(image),density=Math.max(source.width/(Math.abs(image.w)*Math.hypot(m[0],m[1])||1),source.height/(Math.abs(image.h)*Math.hypot(m[2],m[3])||1));
          const base=makeCanvas(Math.ceil(bounds.w*density),Math.ceil(bounds.h*density)),stencil=makeCanvas(base.width,base.height);
          const setup=ctx=>{ctx.scale(base.width/bounds.w,base.height/bounds.h);ctx.translate(-bounds.x,-bounds.y);};
          const ctx=base.getContext('2d');ctx.save();setup(ctx);ctx.transform(...m);ctx.drawImage(source.drawable,image.x,image.y,image.w,image.h);ctx.restore();
          const maskCtx=stencil.getContext('2d',{willReadFrequently:true});maskCtx.save();setup(maskCtx);this.drawElement(maskCtx,shape);maskCtx.restore();
          const pixels=maskCtx.getImageData(0,0,stencil.width,stencil.height);let painted=false;for(let i=3;i<pixels.data.length;i+=4){pixels.data[i]=pixels.data[i]>0?255:0;painted ||= pixels.data[i]>0;}if(!painted)throw new Error('形状在图片范围内没有可见颜色；请检查填充、描边与位置。');maskCtx.putImageData(pixels,0,0);
          const modes=operation==='split-mask'?['destination-in','destination-out']:[operation==='intersect'?'destination-in':'destination-out'],items=[];
          for(const mode of modes){const output=makeCanvas(base.width,base.height),out=output.getContext('2d',{willReadFrequently:true});out.drawImage(base,0,0);out.globalCompositeOperation=mode;out.drawImage(stencil,0,0);const data=out.getImageData(0,0,output.width,output.height).data;let visible=false;for(let i=3;i<data.length;i+=4)if(data[i]){visible=true;break;}if(!visible)continue;const assetId=await this.store.putAsset(await toBlob(output),{croppedFrom:image.assetId,method:operation});items.push({id:id(),type:'image',assetId,...bounds,sourceUrl:image.sourceUrl||''});}
          return {items,remove:[target,mask],message:operation==='split-mask'?`已分割为 ${items.length} 个图片对象，可独立移动。`:'遮罩处理完成，可撤销恢复原图和形状。'};
        }finally{source.dispose();}
      });
    },

    async traceImageOutline(){
      const selected=this.getSelectedElements(),target=selected.length===1&&selected[0].type==='image'?selected[0]:null;if(!target)return;
      const threshold=Number($('#trace-threshold').value);if(!Number.isInteger(threshold)||threshold<1||threshold>255)return this.toast('透明度阈值需为 1–255 的整数。');
      this.toast('正在提取透明轮廓，首次使用需加载本地组件…');
      return this.runEditingTask([target],async()=>{
        const snapshot=clone(target),record=await this.store.getAsset(snapshot.assetId);if(!record?.blob)throw new Error('图片资源不存在。');const source=await this.loadCropDrawable(record.blob);
        try{
          const canvas=makeCanvas(source.width,source.height),ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(source.drawable,0,0);const data=ctx.getImageData(0,0,canvas.width,canvas.height),contours=await this.traceInSandbox(data,threshold);
          if(!contours.length)throw new Error('图片在当前阈值下完全透明，请降低阈值。');
          const paths=contours.map(points=>({closed:true,nodes:points.map(([x,y])=>({x:snapshot.x+x/source.width*snapshot.w,y:snapshot.y+y/source.height*snapshot.h}))}));
          const el={id:id(),type:'path',paths,color:this.currentColor,fillColor:this.currentColor,strokeColor:this.currentColor,fill:'solid',stroke:'none',size:this.currentSize,dash:'solid'};if(snapshot.transform)el.transform=snapshot.transform;
          this.moveElement(el,this.getElementBBox(snapshot).w+24,0);
          return {items:[el],message:'已生成独立矢量形状，原图保留；可改填充色、描边和编辑节点。'};
        }finally{source.dispose();}
      });
    },
    async traceInSandbox(imageData,threshold){
      const frame=await this.ensureOpenCvSandbox(),requestId=id();
      return new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>finish(new Error('轮廓提取超时，请缩小图片。')),60000);
        const onMessage=event=>{const data=event.data;if(event.source!==frame.contentWindow||data?.channel!=='quickdraw-opencv'||data.requestId!==requestId)return;if(data.type==='result')finish(null,data.contours);else if(data.type==='error')finish(new Error(data.message));};
        const finish=(error,contours)=>{clearTimeout(timeout);window.removeEventListener('message',onMessage);error?reject(error):resolve(contours);};
        window.addEventListener('message',onMessage);const pixels=imageData.data.buffer;frame.contentWindow.postMessage({channel:'quickdraw-opencv',type:'trace',requestId,width:imageData.width,height:imageData.height,threshold,pixels},'*',[pixels]);
      });
    },

    penTarget(){const items=this.getSelectedElements();return this.penDraft||(items.length===1&&items[0].type==='path'?items[0]:null);},
    penHandleAt(p){
      const el=this.penTarget();if(!el)return null;const m=V.matrix(el),r=8/this.scale;
      for(let pi=0;pi<el.paths.length;pi++)for(let ni=0;ni<el.paths[pi].nodes.length;ni++){
        const node=el.paths[pi].nodes[ni];for(const kind of ['in','out','anchor']){const q=kind==='anchor'?node:node[kind];if(q&&Math.hypot(V.point(m,q).x-p.x,V.point(m,q).y-p.y)<r)return {el,pi,ni,kind};}
      }return null;
    },
    finishPen(closed=false){
      const el=this.penDraft;if(!el)return;this.penDraft=null;const path=el.paths[0];if(path.nodes.length<2){this.render();return;}path.closed=closed;
      this.elements.push(el);this.setSelection([el],false);this.commit();this.render();
    },
    editingPointerDown(e){
      if(e.button!==0||this.spaceDown||this.currentTool==='hand')return false;
      const p=this.eventPos(e);
      if(this.currentTool==='select'&&!this.cropTarget&&!this.watermarkTarget&&this.rotationHandleAt(p)){
        const frame=this.getSelectionFrame(),b=frame.box,center=V.point(frame.matrix,{x:b.x+b.w/2,y:b.y+b.h/2});this.rotationDrag={center,angle:Math.atan2(p.y-center.y,p.x-center.x),elements:this.getSelectedElements().map(clone)};this.captureInteractionPointer(e.pointerId);this.container.focus({preventScroll:true});return true;
      }
      if(this.currentTool!=='pen'||this.isPanning)return false;
      this.container.focus({preventScroll:true});this.captureInteractionPointer(e.pointerId);
      const hit=this.penHandleAt(p);
      if(this.penDraft&&hit?.ni===0&&hit.pi===0&&hit.kind==='anchor'&&this.penDraft.paths[0].nodes.length>2){this.finishPen(true);this.releaseInteractionPointer(e.pointerId);return true;}
      if(hit&&!this.penDraft){this.penDrag={...hit,before:clone(hit.el),node:clone(hit.el.paths[hit.pi].nodes[hit.ni]),start:this.imageLocalPoint(hit.el,p)};this.penEdit=hit;return true;}
      if(!this.penDraft){this.clearSelection();this.penDraft={id:id(),type:'path',paths:[{closed:false,nodes:[]}],color:this.currentColor,fill:this.currentFill,stroke:'solid',size:this.currentSize,dash:this.currentDash};}
      const q=this.snapWorldPoint(p),nodes=this.penDraft.paths[0].nodes;nodes.push({x:q.x,y:q.y});this.penDrag={el:this.penDraft,pi:0,ni:nodes.length-1,kind:'new',start:q};this.render();return true;
    },
    editingPointerMove(e){
      const p=this.eventPos(e);
      if(this.rotationDrag){const d=this.rotationDrag;let angle=Math.atan2(p.y-d.center.y,p.x-d.center.x)-d.angle;if(e.shiftKey)angle=Math.round(angle/(Math.PI/12))*Math.PI/12;const m=V.around([Math.cos(angle),Math.sin(angle),-Math.sin(angle),Math.cos(angle),0,0],d.center);const items=d.elements.map(src=>{const el=this.elements.find(el=>el.id===src.id);if(el){delete el.transform;Object.assign(el,clone(src));}return el;}).filter(Boolean);this.transformItems(items,m);this.render();return true;}
      if(this.penDrag){const d=this.penDrag,node=d.el.paths[d.pi].nodes[d.ni],q=this.imageLocalPoint(d.el,p);
        if(d.kind==='anchor'){const dx=q.x-d.start.x,dy=q.y-d.start.y;node.x=d.node.x+dx;node.y=d.node.y+dy;for(const kind of ['in','out'])if(d.node[kind])node[kind]={x:d.node[kind].x+dx,y:d.node[kind].y+dy};}
        else{const kind=d.kind==='new'?'out':d.kind;if(d.kind!=='new'||Math.hypot(q.x-node.x,q.y-node.y)>3/this.scale){node[kind]={x:q.x,y:q.y};if(!e.altKey)node[kind==='in'?'out':'in']={x:2*node.x-q.x,y:2*node.y-q.y};}}
        this.spatialDirty=true;this.render();return true;
      }
      if(this.currentTool==='select'&&!this.pointerDown&&!this.cropTarget&&!this.watermarkTarget)this.container.style.cursor=this.rotationHandleAt(p)?'crosshair':'';
      return false;
    },
    editingPointerUp(e){
      if(this.rotationDrag){const d=this.rotationDrag;this.rotationDrag=null;if(e?.type==='pointercancel'){for(const src of d.elements){const el=this.elements.find(el=>el.id===src.id);if(el){delete el.transform;Object.assign(el,src);}}}else this.commit();this.spatialDirty=true;this.releaseInteractionPointer(e?.pointerId);this.pointerDown=false;this.render();return true;}
      if(this.penDrag){const d=this.penDrag;this.penDrag=null;if(e?.type==='pointercancel'){if(d.before)Object.assign(d.el,d.before);else d.el.paths[d.pi].nodes.pop();}else if(d.el!==this.penDraft)this.commit();this.releaseInteractionPointer(e?.pointerId);this.pointerDown=false;this.render();return true;}
      return this.currentTool==='pen'&&!this.isPanning;
    },
    editingKeyDown(e){
      const key=e.key.toLowerCase();
      if(this.rotationDrag&&key==='escape'){this.editingPointerUp({type:'pointercancel'});return true;}
      if(this.currentTool!=='pen')return false;
      if(key==='escape'){if(this.penDrag?.before)Object.assign(this.penDrag.el,this.penDrag.before);this.penDraft=null;this.penDrag=null;this.penEdit=null;this.releaseInteractionPointer();this.spatialDirty=true;this.setTool('select');return true;}
      if(key==='enter'){e.preventDefault();this.finishPen();this.setTool('select');return true;}
      if(key==='delete'||key==='backspace'){
        e.preventDefault();if(this.penDraft)this.penDraft.paths[0].nodes.pop();else if(this.penEdit&&this.elements.includes(this.penEdit.el)){const {el,pi,ni}=this.penEdit;const path=el.paths[pi];if(path.nodes.length>(path.closed?3:2)){path.nodes.splice(ni,1);this.commit();}else this.toast('开放路径至少需要 2 个节点，闭合路径至少需要 3 个节点。');this.penEdit=null;}this.render();return true;
      }
      return false;
    },
    drawEditingOverlay(ctx){
      if(this.penDraft)this.drawElement(ctx,this.penDraft);
      if(this.currentTool==='select'&&this.getSelectedElements().length&&!this.cropTarget&&!this.watermarkTarget){
        const frame=this.getSelectionFrame();if(frame){const b=frame.box,center=V.point(frame.matrix,{x:b.x+b.w/2,y:b.y+b.h/2});ctx.save();ctx.strokeStyle='#2f6fed';ctx.lineWidth=1.2/this.scale;ctx.globalAlpha=.7;const r=14/this.scale;for(const c of V.corners(b).map(p=>V.point(frame.matrix,p))){const angle=Math.atan2(c.y-center.y,c.x-center.x);ctx.beginPath();ctx.arc(c.x,c.y,r,angle-.5,angle+.5);ctx.stroke();}ctx.restore();}
      }
      if(this.currentTool!=='pen')return;const el=this.penTarget();if(!el)return;const m=V.matrix(el),r=3.5/this.scale;ctx.save();ctx.strokeStyle='#2f6fed';ctx.fillStyle='#fff';ctx.lineWidth=1/this.scale;ctx.setLineDash([]);
      for(const path of el.paths)for(const node of path.nodes){const p=V.point(m,node);for(const kind of ['in','out'])if(node[kind]){const q=V.point(m,node[kind]);ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);ctx.stroke();ctx.beginPath();ctx.arc(q.x,q.y,r,0,2*Math.PI);ctx.fill();ctx.stroke();}ctx.beginPath();ctx.rect(p.x-r,p.y-r,2*r,2*r);ctx.fill();ctx.stroke();}ctx.restore();
    }
  };
})();
