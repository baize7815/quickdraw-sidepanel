(() => {
'use strict';
const $=id=>document.getElementById(id),Core=globalThis.QuickdrawVisualEditCore,Mentions=globalThis.QuickdrawVisualMentions;
const canvas=(w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;return c;};
const png=c=>new Promise((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(Error('PNG 导出失败')),'image/png'));
const copy=v=>JSON.parse(JSON.stringify(v));
const imageFile=file=>file&&['image/png','image/jpeg','image/webp'].includes(file.type)&&file.size>0&&file.size<=12*1024*1024;
class VisualEditor{
 constructor(){
  this.store=new QuickdrawStorage();this.query=new URLSearchParams(location.search);
  const ids=String(this.query.get('assets')||this.query.get('asset')||'').split(',').filter(id=>/^[\w-]{2,150}$/.test(id)).slice(0,4);
  this.materials=ids.map((assetId,i)=>({assetId,label:'选中图片 '+(i+1)}));this.assetId=ids[0]||'';this.mainAssetId=this.assetId;
  this.embedded=this.query.get('embedded')==='1';document.body.classList.toggle('embedded',this.embedded);this.pendingSend=false;this.mentionIndex=0;this.expandedPointId=null;
  const rawWindowId=this.query.get('window');this.windowId=rawWindowId&&Number.isInteger(Number(rawWindowId))&&Number(rawWindowId)>0?Number(rawWindowId):null;this.mode='mask';this.strokes=[];this.points=[];this.rect=null;
  this.invert=false;this.feather=0;this.brushSize=36;this.erase=false;this.prompt='';this.referenceAssetId='';
  this.history=[];this.redos=[];this.pointer=null;this.reference=null;this.result=null;this.maskCache=null;this.maskDirty=true;
  this.bind();this.init().catch(e=>this.report(e));
  this.setupMentions();
  document.addEventListener('keydown',e=>{if(this.embedded&&e.key==='Escape'&&$('mention-menu').hidden){e.preventDefault();window.parent.postMessage({type:'qd-visual-close'},location.origin);}});
  window.addEventListener('message',e=>{if(e.origin!==location.origin||e.source!==window.parent||e.data?.type!=='qd-visual-response')return;clearTimeout(this.sendTimer);this.pendingSend=false;$('visual-send').disabled=false;if(!e.data.ok)this.report(e.data.error||'图片任务提交失败。');});
 }
 report(error){$('status').textContent=error instanceof Error?error.message:String(error);}
 snapshot(){return {mode:this.mode,strokes:copy(this.strokes),points:copy(this.points),rect:copy(this.rect),invert:this.invert,feather:this.feather,brushSize:this.brushSize,erase:this.erase,prompt:this.prompt,referenceAssetId:this.referenceAssetId,materials:copy(this.materials)};}
 restore(s){
  const previousReference=this.referenceAssetId;Object.assign(this,copy(s));this.maskDirty=true;
  if(previousReference!==this.referenceAssetId){
   if(!this.referenceAssetId){this.reference=null;$('reference-preview').hidden=true;$('reference-clear').hidden=true;}
   else this.store.getAsset(this.referenceAssetId).then(ref=>ref?.blob&&this.showReference(ref.blob)).catch(e=>this.report(e));
  }
  if(this.expandedPointId&&!this.points.some(pt=>pt.pointId===this.expandedPointId))this.expandedPointId=null;
  this.updateControls();this.renderMaterials();this.render();this.persist();
 }
 push(){this.history.push(this.snapshot());if(this.history.length>40)this.history.shift();this.redos=[];this.updateHistory();}
 undo(){if(!this.history.length)return;this.redos.push(this.snapshot());this.restore(this.history.pop());this.updateHistory();}
 redo(){if(!this.redos.length)return;this.history.push(this.snapshot());this.restore(this.redos.pop());this.updateHistory();}
 updateHistory(){$('undo').disabled=!this.history.length;$('redo').disabled=!this.redos.length;}
 state(){return {mode:this.mode,width:this.w,height:this.h,prompt:this.prompt,strokes:this.strokes,points:this.points,rect:this.rect,invert:this.invert,feather:this.feather,hasReference:this.materials.length>1,materials:this.materials,mainAssetId:this.mainAssetId};}
 persist(){
  if(!this.assetId||!this.w)return;
  try{localStorage.setItem('qd-visual:'+this.assetId,JSON.stringify(this.snapshot()));}catch{this.report('编辑状态超过浏览器暂存容量，请先导出编辑包。');}
 }
 async init(){
  if(!this.assetId||!/^[\w-]{1,150}$/.test(this.assetId))throw Error('缺少有效原图资源，请从 Quickdraw 重新打开。');
  const record=await this.store.getAsset(this.assetId);if(!record?.blob)throw Error('原图资源不存在，请从 Quickdraw 重新打开。');
  this.original?.close?.();this.originalBlob=record.blob;this.original=await createImageBitmap(record.blob);this.w=this.original.width;this.h=this.original.height;
  if(!this.w||!this.h||this.w>16384||this.h>16384||this.w*this.h>18000000)throw Error('原图超过单边 16384 或 1800 万像素限制。');
  this.image=canvas(this.w,this.h);this.image.getContext('2d').drawImage(this.original,0,0);
  $('image').width=this.w;$('image').height=this.h;$('image').getContext('2d').drawImage(this.original,0,0);
  $('overlay').width=this.w;$('overlay').height=this.h;
  $('size-label').textContent=this.w+' × '+this.h+' px';
  try{
   const raw=JSON.parse(localStorage.getItem('qd-visual:'+this.assetId)||'null');
   if(raw&&['mask','point','fusion'].includes(raw.mode)){
    Object.assign(this,{mode:raw.mode,strokes:Array.isArray(raw.strokes)?raw.strokes.slice(0,500):[],points:Array.isArray(raw.points)?raw.points.slice(0,50).map((pt,i)=>({...pt,pointId:pt.pointId||'point-'+(i+1),assetId:this.mainAssetId})):[],rect:raw.rect||null,invert:!!raw.invert,feather:Number(raw.feather)||0,brushSize:Number(raw.brushSize)||36,erase:!!raw.erase,prompt:String(raw.prompt||'').slice(0,3000),referenceAssetId:String(raw.referenceAssetId||'')});
   }
  }catch{}
  if(this.referenceAssetId){
   const ref=await this.store.getAsset(this.referenceAssetId).catch(()=>null);
   if(ref?.blob){
    if(!this.materials.some(item=>item.assetId===this.referenceAssetId)&&this.materials.length<4)this.materials.push({assetId:this.referenceAssetId,label:'恢复的参考图'});
    await this.showReference(ref.blob);
   }else this.referenceAssetId='';
  }
  this.updateControls();this.renderMaterials();this.sizeSurface();this.render();this.updateHistory();
  if(!this.sizeObserver){this.sizeObserver=new ResizeObserver(()=>this.sizeSurface());this.sizeObserver.observe($('stage'));}
  this.report(this.embedded?'准备就绪：绘制标记、输入 @ 引用并发送到所选图片服务。':'编辑器已就绪。');
 }
 bind(){
  for(const b of document.querySelectorAll('[data-mode]'))b.addEventListener('click',()=>{if(this.mode===b.dataset.mode)return;this.push();this.mode=b.dataset.mode;this.updateControls();this.render();this.persist();});
  $('brush').addEventListener('click',()=>{this.erase=false;this.updateControls();this.persist();});
  $('eraser').addEventListener('click',()=>{this.erase=true;this.updateControls();this.persist();});
  $('brush-size').addEventListener('input',e=>{this.brushSize=Number(e.target.value);$('brush-size-value').textContent=this.brushSize;this.persist();});
  $('feather').addEventListener('input',e=>{this.feather=Number(e.target.value);$('feather-value').textContent=this.feather;this.render();this.persist();});
  $('invert').addEventListener('change',e=>{this.push();this.invert=e.target.checked;this.render();this.persist();this.refreshPrompt();});
  $('request').addEventListener('input',e=>{this.prompt=e.target.value;this.persist();this.refreshPrompt();});
  $('undo').addEventListener('click',()=>this.undo());$('redo').addEventListener('click',()=>this.redo());
  $('clear').addEventListener('click',()=>{this.push();if(this.mode==='mask'){this.strokes=[];this.maskDirty=true;}else if(this.mode==='point')this.points=[];else this.rect=null;this.render();this.persist();this.refreshPrompt();});
  $('overlay').addEventListener('pointerdown',e=>this.down(e));$('overlay').addEventListener('pointermove',e=>this.move(e));
  $('overlay').addEventListener('pointerup',e=>this.up(e));$('overlay').addEventListener('pointercancel',e=>this.up(e));
  document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&!['TEXTAREA','INPUT'].includes(document.activeElement?.tagName)){if(e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?this.redo():this.undo();}else if(e.key.toLowerCase()==='y'){e.preventDefault();this.redo();}}});
  $('reference-file').addEventListener('change',e=>this.importReference(e.target.files?.[0]).catch(err=>this.report(err)));
  $('reference-clear').addEventListener('click',()=>{this.push();this.materials=this.materials.filter(item=>item.assetId!==this.referenceAssetId);this.reference=null;this.referenceAssetId='';$('reference-preview').hidden=true;$('reference-clear').hidden=true;$('reference-file').value='';this.renderMaterials();this.persist();this.refreshPrompt();});
  $('generate-prompt').addEventListener('click',()=>this.refreshPrompt(true));
  $('copy-prompt').addEventListener('click',async()=>{try{const s=Mentions.compile(this.state());await navigator.clipboard.writeText(s);this.report('提示词已复制。');}catch(e){this.report(e);}});
  $('export-guide').addEventListener('click',()=>this.action(async()=>this.download(await png(this.guide()),'02-标注图.png')));
  $('export-mask').addEventListener('click',()=>this.action(async()=>{if(this.mode!=='mask')throw Error('当前不是蒙版模式。');await this.download(await png(this.grayscaleMask()),'蒙版-白改黑保.png');}));
  $('export-package').addEventListener('click',()=>this.action(()=>this.exportPackage()));
  $('result-file').addEventListener('change',e=>this.importResult(e.target.files?.[0]).catch(err=>this.report(err)));
  $('export-result').addEventListener('click',()=>this.action(async()=>this.download(await png(this.resultCanvas()),'生成结果-合成.png')));
  $('return-board').addEventListener('click',()=>this.action(()=>this.returnBoard()));
  $('visual-send').addEventListener('click',()=>this.action(()=>this.sendVisualTask()));
 }
 async action(fn){try{const before=$('status').textContent;await fn();if($('status').textContent===before)this.report('操作完成。');}catch(e){this.report(e);}}
 updateControls(){
  for(const b of document.querySelectorAll('[data-mode]'))b.classList.toggle('active',b.dataset.mode===this.mode);
  for(const id of ['mask','point','fusion'])$(id+'-controls').hidden=id!==this.mode;
  $('brush').classList.toggle('active',!this.erase);$('eraser').classList.toggle('active',this.erase);
  $('brush-size').value=this.brushSize;$('brush-size-value').textContent=this.brushSize;
  $('feather').value=this.feather;$('feather-value').textContent=this.feather;
  $('invert').checked=this.invert;$('request').value=this.prompt;
  $('tool-help').textContent={mask:'拖动涂抹，擦除笔迹；反选可改动其余区域',point:'点击放置编号标记，拖动已有点调整位置',fusion:'拖出红框确定新物体/场景的位置'}[this.mode];
  this.renderPoints();this.refreshPrompt();
 }
 sizeSurface(){
  if(!this.w)return;
  const box=$('stage').getBoundingClientRect(),factor=Math.min((box.width-24)/this.w,(box.height-24)/this.h,1);
  const node=$('surface');node.style.width=Math.max(1,Math.floor(this.w*factor))+'px';node.style.height=Math.max(1,Math.floor(this.h*factor))+'px';
 }
 point(e){
  const rect=$('overlay').getBoundingClientRect();
  return {x:Math.max(0,Math.min(this.w,(e.clientX-rect.left)/rect.width*this.w)),y:Math.max(0,Math.min(this.h,(e.clientY-rect.top)/rect.height*this.h))};
 }
 down(e){
  if(e.button!==0||!this.w)return;e.preventDefault();
  const p=this.point(e);this.push();$('overlay').setPointerCapture(e.pointerId);
  if(this.mode==='mask'){
   if(this.strokes.length>=500){this.history.pop();return this.report('笔画数量达到上限，请先导出。');}
   this.strokes.push({erase:this.erase,radius:this.brushSize/2,points:[p]});this.maskDirty=true;this.pointer={id:e.pointerId,type:'stroke'};
  }else if(this.mode==='point'){
   const pixelScale=$('overlay').getBoundingClientRect().width/this.w;
   let idx=this.points.findIndex(v=>Math.hypot(v.x-p.x,v.y-p.y)<18/pixelScale);
   if(idx<0){if(this.points.length>=50){this.history.pop();return this.report('最多支持 50 个编辑点。');}idx=this.points.length;this.points.push({pointId:'point-'+Date.now()+'-'+idx,assetId:this.mainAssetId,x:p.x,y:p.y,text:''});}
   this.pointer={id:e.pointerId,type:'move',index:idx};
  }else{this.rect={x:p.x,y:p.y,w:0,h:0};this.pointer={id:e.pointerId,type:'box',start:p};}
  this.render();
 }
 move(e){
  if(!this.pointer||e.pointerId!==this.pointer.id)return;
  const p=this.point(e);
  if(this.pointer.type==='stroke'){
   const points=this.strokes[this.strokes.length-1].points,last=points[points.length-1];
   if(points.length<15000&&Math.hypot(p.x-last.x,p.y-last.y)>=Math.max(0.5,this.brushSize/10))points.push(p);
   this.maskDirty=true;
  }else if(this.pointer.type==='move'){this.points[this.pointer.index].x=p.x;this.points[this.pointer.index].y=p.y;}
  else{this.rect.w=p.x-this.pointer.start.x;this.rect.h=p.y-this.pointer.start.y;}
  this.render();
 }
 up(e){if(!this.pointer||e.pointerId!==this.pointer.id)return;this.pointer=null;this.renderPoints();this.persist();this.render();this.refreshPrompt();}
 renderPoints(){
  const root=$('point-list');root.replaceChildren();
  this.points.forEach((p,i)=>{
   const pointKey=String(p.pointId||'point-'+i);
   const expanded=this.expandedPointId===pointKey;
   const line=document.createElement('div');line.className='point-row';line.classList.toggle('expanded',expanded);
   const c=this.w?Core.coordinate(p,this.w,this.h):{x:0,y:0};
   const toggle=document.createElement('button');toggle.type='button';toggle.className='point-toggle';
   toggle.textContent='点 '+(i+1)+' · ('+c.x+','+c.y+')';
   toggle.setAttribute('aria-expanded',String(expanded));
   toggle.setAttribute('aria-controls','point-editor-'+i);
   toggle.title=expanded?'收起编辑点指令':'展开编辑点指令';
   toggle.addEventListener('click',()=>{this.expandedPointId=expanded?null:pointKey;this.renderPoints();});
   const remove=document.createElement('button');remove.type='button';remove.className='point-remove';remove.textContent='删除';remove.setAttribute('aria-label','删除点 '+(i+1));
   remove.addEventListener('click',()=>{this.push();this.points.splice(i,1);if(this.expandedPointId===pointKey)this.expandedPointId=null;this.renderPoints();this.render();this.persist();this.refreshPrompt();});
   const text=document.createElement('textarea');text.id='point-editor-'+i;text.rows=2;text.placeholder='例如：将这里的杯子换成玻璃杯';text.value=p.text||'';text.hidden=!expanded;
   text.setAttribute('aria-label','点 '+(i+1)+' 编辑指令');
   text.addEventListener('input',()=>{p.text=text.value.slice(0,500);this.persist();this.refreshPrompt();});
   line.append(toggle,remove,text);root.append(line);
  });
 }
 renderMaterials(){
  const host=$('material-bar');if(!host)return;
  host.replaceChildren();const items=Mentions.sourceItems(this.state());
  items.forEach((item,i)=>{
   const chip=document.createElement('span');chip.className='material-item'+(i===0?' primary':'');
   const select=document.createElement('button');select.type='button';
   select.textContent='@图'+(i+1)+' '+(i===0?'主图':'参考')+' · '+String(item.label||'图片').slice(0,13);
   select.title=i===0?'当前主图':'点击将此图设为主图（点位坐标会重置）';
   select.disabled=i===0;
   select.addEventListener('click',()=>this.chooseMain(item.assetId).catch(err=>this.report(err)));
   chip.append(select);
   if(i!==0){
    const remove=document.createElement('button');remove.type='button';remove.className='material-remove';remove.textContent='×';remove.title='移除参考图';
    remove.addEventListener('click',()=>{
     this.push();this.materials=this.materials.filter(v=>v.assetId!==item.assetId);
     if(this.referenceAssetId===item.assetId){this.referenceAssetId='';$('reference-preview').hidden=true;$('reference-clear').hidden=true;}
     this.renderMaterials();this.refreshPrompt();this.persist();
    });
    chip.append(remove);
   }
   host.append(chip);
  });
 }
 async chooseMain(assetId){
  if(assetId===this.mainAssetId)return;
  const target=this.materials.find(v=>v.assetId===assetId);
  if(!target)throw Error('目标图片不存在。');
  this.persist();
  this.mainAssetId=assetId;this.assetId=assetId;this.expandedPointId=null;
  this.history=[];this.redos=[];this.strokes=[];this.points=[];this.rect=null;
  this.maskCache=null;this.maskDirty=true;this.referenceAssetId='';
  this.prompt='';
  await this.init();
  this.report('主图已更换。坐标与标注属于原主图，已切换到新主图的标记状态。');
 }
 setupMentions(){
  const menu=$('mention-menu');
  const close=()=>{menu.hidden=true;this.mentionInput=null;};
  const update=textarea=>{
   if(!(textarea instanceof HTMLTextAreaElement)||textarea.readOnly||textarea.id==='prompt-output'){close();return;}
   const found=Mentions.pending(textarea.value,textarea.selectionStart);
   if(!found){close();return;}
   const picks=Mentions.suggestions(this.state()).filter(item=>item.token.startsWith(found.query)).slice(0,15);
   if(!picks.length){close();return;}
   this.mentionInput=textarea;this.mentionRange=found;this.mentionIndex=0;
   menu.replaceChildren();
   picks.forEach((item,i)=>{
    const button=document.createElement('button');button.type='button';button.role='option';
    button.textContent=item.token+'  '+item.label;button.classList.toggle('selected',i===0);
    button.addEventListener('mousedown',e=>{e.preventDefault();this.applyMention(i);});
    menu.append(button);
   });
   const rect=textarea.getBoundingClientRect();
   menu.style.left=Math.max(5,Math.min(rect.left,innerWidth-230))+'px';
   menu.style.top=Math.max(6,Math.min(rect.bottom+3,innerHeight-210))+'px';menu.hidden=false;
  };
  document.addEventListener('input',e=>{
   if(e.target instanceof HTMLTextAreaElement)update(e.target);
  });
  document.addEventListener('click',e=>{if(!menu.contains(e.target)&&e.target!==this.mentionInput)close();});
  document.addEventListener('keydown',e=>{
   if(menu.hidden||document.activeElement!==this.mentionInput)return;
   const options=[...menu.querySelectorAll('button')];
   if(['ArrowDown','ArrowUp'].includes(e.key)){
    e.preventDefault();this.mentionIndex=(this.mentionIndex+(e.key==='ArrowDown'?1:-1)+options.length)%options.length;
    options.forEach((node,i)=>node.classList.toggle('selected',i===this.mentionIndex));
   }else if(['Enter','Tab'].includes(e.key)){e.preventDefault();this.applyMention(this.mentionIndex);}
   else if(e.key==='Escape'){e.preventDefault();close();}
  });
  this.dismissMentions=close;
 }
 applyMention(index){
  const input=this.mentionInput,found=this.mentionRange,pick=$('mention-menu').querySelectorAll('button')[index];
  if(!input||!found||!pick)return;
  const token=pick.textContent.split('  ')[0],end=input.selectionStart;
  input.value=input.value.slice(0,found.start)+token+input.value.slice(end);
  input.focus();input.setSelectionRange(found.start+token.length,found.start+token.length);
  input.dispatchEvent(new Event('input',{bubbles:true}));
  this.dismissMentions();
 }
 async sendVisualTask(){
  if(this.pendingSend)return;
  if(!this.embedded||window.parent===window)throw Error('请从 Quickdraw 侧边栏打开编辑弹窗再发送。');
  const providerId=$('visual-provider').value;
  const provider=globalThis.QuickdrawAI?.provider(providerId);
  if(!provider?.enabled||!provider.capabilities?.image)throw Error('该图片服务当前不可用。');
  const origins=[...(provider.origins||[]),...(provider.authOrigins||[])];
  this.pendingSend=true;$('visual-send').disabled=true;
  try{
   // Ask directly from the user's click, before asynchronous image serialization.
   if(chrome.permissions?.request&&!(await chrome.permissions.request({origins})))throw Error('未授予图片服务网站访问权限。');
   const state=this.state(),prompt=Mentions.compile(state),ordered=Mentions.sourceItems(state);
   if(ordered.length+1>5)throw Error('当前素材数量超出本地编辑任务上限。');
   const guide=await png(this.guide());
   if(globalThis.QuickdrawAIImage?.inspectBlob)await QuickdrawAIImage.inspectBlob(guide,{maxBytes:QuickdrawAIImage.MAX_INPUT_BYTES});
   const guideAssetId=await this.store.putAsset(guide,{visualEditorGuide:true,visualSource:this.mainAssetId});
   const inputAssetIds=[ordered[0].assetId,guideAssetId,...ordered.slice(1).map(item=>item.assetId)];
   window.parent.postMessage({type:'qd-visual-submit',provider:providerId,mainAssetId:this.mainAssetId,guideAssetId,inputAssetIds,prompt},location.origin);
   this.report('素材已准备，等待 Quickdraw 确认发送任务…');
   clearTimeout(this.sendTimer);
   this.sendTimer=setTimeout(()=>{if(this.pendingSend){this.report('等待 Quickdraw 响应超时，未再次发送以避免重复请求。');this.pendingSend=false;$('visual-send').disabled=false;}},30000);
  }catch(e){this.pendingSend=false;$('visual-send').disabled=false;throw e;}
 }
 strokeMask(){
  if(!this.maskDirty&&this.maskCache)return this.maskCache;
  const c=canvas(this.w,this.h),ctx=c.getContext('2d');
  for(const s of this.strokes){
   ctx.globalCompositeOperation=s.erase?'destination-out':'source-over';ctx.strokeStyle='#fff';ctx.fillStyle='#fff';ctx.lineCap='round';ctx.lineJoin='round';ctx.lineWidth=Math.max(1,Number(s.radius)*2);
   const pts=s.points||[];if(!pts.length)continue;
   ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);
   for(const p of pts.slice(1))ctx.lineTo(p.x,p.y);
   ctx.stroke();ctx.beginPath();ctx.arc(pts[0].x,pts[0].y,Math.max(0.5,s.radius),0,Math.PI*2);ctx.fill();
   const last=pts[pts.length-1];ctx.beginPath();ctx.arc(last.x,last.y,Math.max(.5,s.radius),0,Math.PI*2);ctx.fill();
  }
  ctx.globalCompositeOperation='source-over';this.maskCache=c;this.maskDirty=false;return c;
 }
 render(){
  if(!this.w)return;const out=$('overlay').getContext('2d');out.clearRect(0,0,this.w,this.h);
  if(this.mode==='mask'){
   const rawMask=this.strokeMask();
   let mask=rawMask;
   if(this.feather>0){const softened=canvas(this.w,this.h),ctx=softened.getContext('2d');ctx.filter='blur('+this.feather+'px)';ctx.drawImage(rawMask,0,0);mask=softened;}
   if(this.invert){out.fillStyle='rgba(235,55,86,.32)';out.fillRect(0,0,this.w,this.h);out.globalCompositeOperation='destination-out';out.drawImage(mask,0,0);out.globalCompositeOperation='source-over';}
   else{const tint=canvas(this.w,this.h),ctx=tint.getContext('2d');ctx.fillStyle='#ed3657';ctx.fillRect(0,0,this.w,this.h);ctx.globalCompositeOperation='destination-in';ctx.drawImage(mask,0,0);out.globalAlpha=.35;out.drawImage(tint,0,0);out.globalAlpha=1;}
  }else if(this.mode==='point'){
   const ratio=this.w/$('overlay').getBoundingClientRect().width||1,r=12*ratio;
   this.points.forEach((p,i)=>{out.fillStyle='#ed424d';out.strokeStyle='white';out.lineWidth=2*ratio;out.beginPath();out.arc(p.x,p.y,r,0,Math.PI*2);out.fill();out.stroke();out.font='bold '+12*ratio+'px sans-serif';out.textAlign='center';out.textBaseline='middle';out.fillStyle='white';out.fillText(String(i+1),p.x,p.y);});
  }else{
   const b=Core.bounds(this.rect,this.w,this.h);
   if(b){const ratio=this.w/$('overlay').getBoundingClientRect().width||1;out.fillStyle='rgba(235,55,86,.12)';out.fillRect(b.x,b.y,b.w,b.h);out.strokeStyle='#e92e4b';out.lineWidth=2*ratio;out.setLineDash([7*ratio,5*ratio]);out.strokeRect(b.x,b.y,b.w,b.h);out.setLineDash([]);}
  }
 }
 guide(){const c=canvas(this.w,this.h),ctx=c.getContext('2d');ctx.drawImage(this.image,0,0);ctx.drawImage($('overlay'),0,0);return c;}
 grayscaleMask(){
  const src=canvas(this.w,this.h),ctx=src.getContext('2d',{willReadFrequently:true});
  ctx.filter='blur('+Math.min(40,Math.max(0,this.feather))+'px)';ctx.drawImage(this.strokeMask(),0,0);ctx.filter='none';
  const pixels=ctx.getImageData(0,0,this.w,this.h),data=pixels.data;
  for(let i=0;i<data.length;i+=4){const v=this.invert?255-data[i+3]:data[i+3];data[i]=data[i+1]=data[i+2]=v;data[i+3]=255;}
  ctx.putImageData(pixels,0,0);return src;
 }
 refreshPrompt(show=false){
  if(!this.w)return;
  try{$('prompt-output').value=Mentions.compile(this.state());if(show)this.report('提示词已生成。');}catch(e){$('prompt-output').value='当前编辑配置尚未完整：'+e.message;if(show)this.report(e);}
 }
 async showReference(blob){
  const url=URL.createObjectURL(blob);try{$('reference-preview').src=url;$('reference-preview').hidden=false;$('reference-clear').hidden=false;this.reference=blob;}finally{$('reference-preview').addEventListener('load',()=>URL.revokeObjectURL(url),{once:true});}
 }
 async importReference(file){
  if(!imageFile(file))throw Error('参考图片仅支持 12MB 内的 PNG/JPG/WebP。');
  const check=await createImageBitmap(file);check.close();
  if(this.materials.length>=4)throw Error('最多选择 4 张素材图（主图和最多 3 张参考图）。');
  this.push();this.referenceAssetId=await this.store.putAsset(file,{visualEditorReference:true});
  this.materials.push({assetId:this.referenceAssetId,label:file.name||'新增参考图'});
  await this.showReference(file);this.renderMaterials();
  this.persist();this.refreshPrompt();this.report('已载入参考图，可用 @图'+this.materials.length+' 引用。');
 }
 async importResult(file){
  if(!imageFile(file))throw Error('结果图片仅支持 12MB 内的 PNG/JPG/WebP。');
  const next=await createImageBitmap(file);const ratio=next.width/next.height,originalRatio=this.w/this.h;
  if(Math.abs(ratio/originalRatio-1)>.02){next.close();throw Error('结果与原图宽高比不一致，无法安全对齐合成。');}
  this.result?.close?.();this.result=next;this.report('已载入生成图。蒙版模式将仅合成蒙版指定区域。');
 }
 resultCanvas(){
  if(!this.result)throw Error('请先导入生成后的图片。');
  const out=canvas(this.w,this.h),ctx=out.getContext('2d');
  if(this.mode!=='mask'){ctx.drawImage(this.result,0,0,this.w,this.h);return out;}
  if(!this.strokes.length)throw Error('请先绘制蒙版。');
  ctx.drawImage(this.image,0,0);
  const layer=canvas(this.w,this.h),lc=layer.getContext('2d');
  lc.drawImage(this.result,0,0,this.w,this.h);
  const gray=this.grayscaleMask(),g=gray.getContext('2d').getImageData(0,0,this.w,this.h);
  for(let i=0;i<g.data.length;i+=4){const a=g.data[i];g.data[i]=g.data[i+1]=g.data[i+2]=255;g.data[i+3]=a;}
  const matte=canvas(this.w,this.h),mc=matte.getContext('2d');mc.putImageData(g,0,0);
  lc.globalCompositeOperation='destination-in';lc.drawImage(matte,0,0);
  ctx.drawImage(layer,0,0);return out;
 }
 async download(blob,name){
  const url=URL.createObjectURL(blob);
  try{if(chrome.downloads?.download)await chrome.downloads.download({url,filename:'Quickdraw-AI-Editor/'+name,saveAs:false});
   else{const a=document.createElement('a');a.href=url;a.download=name;a.click();}}
  finally{setTimeout(()=>URL.revokeObjectURL(url),60000);}
 }
 async exportPackage(){
  const text=Mentions.compile(this.state()),info=Core.manifest({...this.state(),prompt:this.prompt||'Apply the numbered point edits.'});
  await this.download(await png(this.image),'01-原图.png');
  await this.download(await png(this.guide()),'02-标注定位图.png');
  if(this.mode==='mask')await this.download(await png(this.grayscaleMask()),'03-灰度蒙版.png');
  if(this.mode==='fusion'){
   const refId=Mentions.sourceItems(this.state())[1]?.assetId;const ref=await this.store.getAsset(refId);if(!ref?.blob)throw Error('参考图资源丢失');
   const im=await createImageBitmap(ref.blob);try{const c=canvas(im.width,im.height);c.getContext('2d').drawImage(im,0,0);await this.download(await png(c),'03-参考图.png');}finally{im.close();}
  }
  await this.download(new Blob([text],{type:'text/plain;charset=utf-8'}),'04-编辑提示词.txt');
  await this.download(new Blob([JSON.stringify(info,null,2)],{type:'application/json'}),'05-编辑信息.json');
 }
 async returnBoard(){
  const blob=await png(this.resultCanvas()),assetId=await this.store.putAsset(blob,{sourceUrl:'quickdraw-visual-edit',visualEdited:true});
  const reply=await chrome.runtime.sendMessage({type:'qd-visual-editor-import',assetId,windowId:Number.isInteger(this.windowId)&&this.windowId>0?this.windowId:null});
  if(!reply?.ok)throw Error(reply?.error||'结果已保存，但未能通知画板。');
  this.report(reply.needsOpen?'图片已保存到 Quickdraw 待接收区，请手动打开侧边栏。':'图片已交回 Quickdraw。');
 }
}
document.addEventListener('DOMContentLoaded',()=>new VisualEditor());
})();