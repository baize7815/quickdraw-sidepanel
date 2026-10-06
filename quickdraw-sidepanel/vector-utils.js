(() => {
  'use strict';
  const identity = () => [1, 0, 0, 1, 0, 0];
  const matrix = el => el?.transform || identity();
  const point = (m, p) => ({ x: m[0]*p.x+m[2]*p.y+m[4], y: m[1]*p.x+m[3]*p.y+m[5] });
  const multiply = (a, b) => [
    a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
    a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
    a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]
  ];
  const inverse = m => {
    const d=m[0]*m[3]-m[1]*m[2];
    if(Math.abs(d)<1e-12)throw new Error('对象变换不可逆。');
    return [m[3]/d,-m[1]/d,-m[2]/d,m[0]/d,(m[2]*m[5]-m[3]*m[4])/d,(m[1]*m[4]-m[0]*m[5])/d];
  };
  const around = (m, c) => multiply([1,0,0,1,c.x,c.y],multiply(m,[1,0,0,1,-c.x,-c.y]));
  const bounds = points => {
    if(!points.length)return null;
    let x=Infinity,y=Infinity,r=-Infinity,b=-Infinity;
    for(const p of points){x=Math.min(x,p.x);y=Math.min(y,p.y);r=Math.max(r,p.x);b=Math.max(b,p.y);}
    return {x,y,w:Math.max(.001,r-x),h:Math.max(.001,b-y)};
  };
  const corners = b => [{x:b.x,y:b.y},{x:b.x+b.w,y:b.y},{x:b.x+b.w,y:b.y+b.h},{x:b.x,y:b.y+b.h}];
  const transformBounds = (b,m) => b && bounds(corners(b).map(p=>point(m,p)));
  const pathData = el => {
    const n = v => String(Math.round(v*10000)/10000);
    return (el.paths||[]).map(path=>{
      const nodes=path.nodes;if(!nodes?.length)return '';
      let d=`M${n(nodes[0].x)} ${n(nodes[0].y)}`;
      const segment=(a,b)=>a.out||b.in?` C${n((a.out||a).x)} ${n((a.out||a).y)} ${n((b.in||b).x)} ${n((b.in||b).y)} ${n(b.x)} ${n(b.y)}`:` L${n(b.x)} ${n(b.y)}`;
      for(let i=1;i<nodes.length;i++)d+=segment(nodes[i-1],nodes[i]);
      if(path.closed){d+=segment(nodes.at(-1),nodes[0]);d+=' Z';}
      return d;
    }).join(' ');
  };
  const cubicValue = (p0,p1,p2,p3,t) => {
    const u=1-t;
    return u*u*u*p0+3*u*u*t*p1+3*u*t*t*p2+t*t*t*p3;
  };
  const cubicExtrema = (p0,p1,p2,p3) => {
    const a=-p0+3*p1-3*p2+p3,b=2*(p0-2*p1+p2),c=p1-p0,eps=1e-12,out=[];
    if(Math.abs(a)<eps){if(Math.abs(b)>=eps){const t=-c/b;if(t>0&&t<1)out.push(t);}return out;}
    const d=b*b-4*a*c;if(d<0)return out;const s=Math.sqrt(Math.max(0,d));
    for(const t of [(-b+s)/(2*a),(-b-s)/(2*a)])if(t>0&&t<1&&!out.some(v=>Math.abs(v-t)<1e-9))out.push(t);
    return out;
  };
  const pathBounds = el => {
    const pts=[];
    const addSegment=(a,b)=>{
      pts.push({x:a.x,y:a.y},{x:b.x,y:b.y});
      if(!a.out&&!b.in)return;
      const c1=a.out||a,c2=b.in||b,times=new Set([0,1,...cubicExtrema(a.x,c1.x,c2.x,b.x),...cubicExtrema(a.y,c1.y,c2.y,b.y)]);
      for(const t of times)pts.push({x:cubicValue(a.x,c1.x,c2.x,b.x,t),y:cubicValue(a.y,c1.y,c2.y,b.y,t)});
    };
    for(const path of el.paths||[]){const nodes=path.nodes||[];if(nodes.length===1)pts.push(nodes[0]);for(let i=1;i<nodes.length;i++)addSegment(nodes[i-1],nodes[i]);if(path.closed&&nodes.length>1)addSegment(nodes.at(-1),nodes[0]);}
    const b=bounds(pts);if(!b)return null;const pad=el.stroke==='none'?0:(el.size||4)/2;
    return {x:b.x-pad,y:b.y-pad,w:b.w+2*pad,h:b.h+2*pad};
  };
  const cropRect = (a,p,b,ratio=0) => {
    let dx=Math.max(b.x,Math.min(b.x+b.w,p.x))-a.x,dy=Math.max(b.y,Math.min(b.y+b.h,p.y))-a.y;
    if(ratio>0){
      const sx=dx<0?-1:1,sy=dy<0?-1:1;
      let w=Math.abs(dx),h=Math.abs(dy);
      if(w/Math.max(h,1e-9)>ratio)h=w/ratio;else w=h*ratio;
      const maxW=sx>0?b.x+b.w-a.x:a.x-b.x,maxH=sy>0?b.y+b.h-a.y:a.y-b.y;
      const factor=Math.min(1,maxW/Math.max(w,1e-9),maxH/Math.max(h,1e-9));dx=sx*w*factor;dy=sy*h*factor;
    }
    return {x:Math.min(a.x,a.x+dx),y:Math.min(a.y,a.y+dy),w:Math.abs(dx),h:Math.abs(dy)};
  };
  const gridCells = (width,height,cols,rows,gap=0) => {
    if(!Number.isInteger(cols)||!Number.isInteger(rows)||cols<1||rows<1||cols*rows>100||cols>width||rows>height)throw new Error('请输入正整数列数和行数，总块数最多 100，且不能超过图片像素尺寸。');
    if(!Number.isInteger(gap))throw new Error('间距需为整数像素，负数表示重叠。');
    const cells=[];
    for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
      const x=Math.max(0,Math.min(width,Math.round(col*width/cols)+(col?Math.ceil(gap/2):0))),y=Math.max(0,Math.min(height,Math.round(row*height/rows)+(row?Math.ceil(gap/2):0)));
      const right=Math.max(0,Math.min(width,Math.round((col+1)*width/cols)-(col<cols-1?Math.floor(gap/2):0))),bottom=Math.max(0,Math.min(height,Math.round((row+1)*height/rows)-(row<rows-1?Math.floor(gap/2):0)));
      if(right<=x||bottom<=y)throw new Error('间距过大，每块切片需至少保留 1 像素。');
      cells.push({x,y,w:right-x,h:bottom-y});
    }
    return cells;
  };
  globalThis.QDVector={identity,matrix,point,multiply,inverse,around,bounds,corners,transformBounds,pathData,pathBounds,cropRect,gridCells};
  if(typeof module!=='undefined')module.exports=globalThis.QDVector;
})();
