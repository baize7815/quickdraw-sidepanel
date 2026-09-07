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
  const pathBounds = el => {
    const pts=[];
    // The control hull contains the entire Bézier curve, including extreme bends.
    for(const path of el.paths||[])for(const n of path.nodes||[]){pts.push(n);if(n.in)pts.push(n.in);if(n.out)pts.push(n.out);}
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
  const gridCells = (width,height,cols,rows) => {
    if(!Number.isInteger(cols)||!Number.isInteger(rows)||cols<1||rows<1||cols*rows>100||cols>width||rows>height)throw new Error('请输入正整数列数和行数，总块数最多 100，且不能超过图片像素尺寸。');
    const cells=[];
    for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
      const x=Math.round(col*width/cols),y=Math.round(row*height/rows);
      cells.push({x,y,w:Math.round((col+1)*width/cols)-x,h:Math.round((row+1)*height/rows)-y});
    }
    return cells;
  };
  globalThis.QDVector={identity,matrix,point,multiply,inverse,around,bounds,corners,transformBounds,pathData,pathBounds,cropRect,gridCells};
  if(typeof module!=='undefined')module.exports=globalThis.QDVector;
})();
