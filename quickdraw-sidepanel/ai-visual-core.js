(() => {
'use strict';
const clamp=(v,min,max)=>Math.min(max,Math.max(min,Number(v)||0));
const coordinate=(p,w,h)=>({x:Math.round(clamp(p.x,0,w)/w*1000),y:Math.round(clamp(p.y,0,h)/h*1000)});
function bounds(r,w,h){
 if(!r||![r.x,r.y,r.w,r.h].every(v=>Number.isFinite(Number(v))))return null;
 const x1=clamp(Math.min(Number(r.x),Number(r.x)+Number(r.w)),0,w),x2=clamp(Math.max(Number(r.x),Number(r.x)+Number(r.w)),0,w);
 const y1=clamp(Math.min(Number(r.y),Number(r.y)+Number(r.h)),0,h),y2=clamp(Math.max(Number(r.y),Number(r.y)+Number(r.h)),0,h);
 return x2-x1>=1&&y2-y1>=1?{x:x1,y:y1,w:x2-x1,h:y2-y1,normalized:[Math.round(y1/h*1000),Math.round(x1/w*1000),Math.round(y2/h*1000),Math.round(x2/w*1000)]}:null;
}
const safe=v=>String(v||'').trim().slice(0,3000);
function script(s){
 if(!s||!Number.isFinite(s.width)||!Number.isFinite(s.height)||s.width<1||s.height<1)throw Error('图片尺寸无效');
 const request=safe(s.prompt);if(!request)throw Error('请先填写编辑要求。');
 const parts=[
 'Edit Image 1, the clean original image. Desired change: '+request,
 'Keep the original medium, framing, perspective, subject identity and visual style unless the request explicitly changes them.',
 'Match lighting direction, scale, shadows, reflections and materials to the original surroundings.',
 'Image 2 is an annotated location guide, never visible output content. Do not reproduce any annotation marks, boxes or numbers.',
 'Preserve unrequested content as closely as the model permits.'
 ];
 if(s.mode==='mask'){
  if(!s.strokes?.length)throw Error('请先绘制编辑蒙版。');
  parts.splice(1,0,s.invert?'Edit the red tinted area of Image 2 (the inverse of the manually painted selection). Preserve the unmarked selection.':'Edit only the red tinted area of Image 2. Untinted regions are preservation references.');
  parts.push('The separate grayscale mask is an optional visual alignment aid, not an API-level hard mask: white means edit, black means preserve.');
 }else if(s.mode==='point'){
  if(!s.points?.length)throw Error('请先添加编辑点。');
  parts.splice(1,0,'Each numbered circle in Image 2 is a location pointer, not output art. Instructions: '+s.points.map((pt,i)=>{
   const p=coordinate(pt,s.width,s.height);return 'Point '+(i+1)+' at normalized [x,y]=['+p.x+','+p.y+']: '+(safe(pt.text)||'apply the general edit request');
  }).join('; '));
 }else if(s.mode==='fusion'){
  const b=bounds(s.rect,s.width,s.height);
  if(!b)throw Error('请先框选要融合的位置。');
  if(!s.hasReference)throw Error('请先上传物体或场景参考图。');
  parts.splice(1,0,'The red box in Image 2 indicates the destination area, normalized [ymin,xmin,ymax,xmax]=['+b.normalized.join(',')+']. Image 3 is the object or scene reference. Adapt it to Image 1 rather than copying its full composition.');
  parts.push('Integrate the reference with natural edge transitions, perspective, occlusions and environmental lighting. Required environmental effects may extend outside the box.');
 }else throw Error('未知编辑模式。');
 return parts.join('\n\n');
}
const manifest=s=>({format:'quickdraw-visual-image-edit',version:1,mode:s.mode,width:s.width,height:s.height,mask:{strokes:s.strokes||[],invert:!!s.invert,feather:clamp(s.feather,0,50)},points:(s.points||[]).map((p,i)=>({number:i+1,x:p.x,y:p.y,normalized:coordinate(p,s.width,s.height),instruction:p.text||''})),rectangle:bounds(s.rect,s.width,s.height),reference:!!s.hasReference,prompt:script(s)});
const api=Object.freeze({coordinate,bounds,script,manifest});
globalThis.QuickdrawVisualEditCore=api;
if(typeof module!=='undefined'&&module.exports)module.exports=api;
})();