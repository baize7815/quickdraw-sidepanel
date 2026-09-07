(() => {
  'use strict';

  const send = (message, transfer = []) => parent.postMessage({ channel: 'quickdraw-opencv', ...message }, '*', transfer);

  const cvReady = new Promise((resolve, reject) => {
    const finish = api => {
      if (!api?.Mat || typeof api.inpaint !== 'function' || api.INPAINT_TELEA !== 1) {
        reject(new Error('当前 OpenCV 构建不支持 Telea 修复。'));
        return;
      }
      resolve({ api });
    };
    try {
      if (globalThis.cv?.Mat) finish(globalThis.cv);
      else if (typeof globalThis.cv?.then === 'function') globalThis.cv.then(finish);
      else reject(new Error('OpenCV 组件未加载。'));
    } catch (error) {
      reject(error);
    }
  });

  cvReady.then(() => send({ type: 'ready' })).catch(error => send({ type: 'startup-error', message: error?.message || 'OpenCV 初始化失败。' }));

  window.addEventListener('message', async event => {
    const request = event.data;
    if (event.source !== parent || request?.channel !== 'quickdraw-opencv' || !['inpaint','trace'].includes(request.type)) return;
    const mats = [];
    try {
      const { api: cv } = await cvReady;
      const width = Number(request.width), height = Number(request.height), region = request.region || {};
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 12_000_000) throw new Error('无效或过大的修复区域。');
      const sourcePixels = new Uint8ClampedArray(request.pixels);
      if (sourcePixels.length !== width * height * 4) throw new Error('图片像素数据不完整。');
      if(request.type==='trace'){
        const threshold=Math.max(1,Math.min(255,Number(request.threshold)||16));
        const mask=cv.Mat.zeros(height+2,width+2,cv.CV_8UC1),contours=new cv.MatVector(),hierarchy=new cv.Mat();
        mats.push(mask,contours,hierarchy);
        for(let y=0;y<height;y++)for(let x=0;x<width;x++)mask.data[(y+1)*(width+2)+x+1]=sourcePixels[(y*width+x)*4+3]>=threshold?255:0;
        cv.findContours(mask,contours,hierarchy,cv.RETR_LIST,cv.CHAIN_APPROX_SIMPLE);
        if(contours.size()>20000)throw new Error('轮廓过于复杂，请提高透明度阈值或缩小图片。');
        const output=[];let vertices=0;
        for(let i=0;i<contours.size();i++){
          const contour=contours.get(i),approx=new cv.Mat();
          try{
            cv.approxPolyDP(contour,approx,.65,true);
            const pts=[];for(let j=0;j<approx.data32S.length;j+=2)pts.push([approx.data32S[j]-.5,approx.data32S[j+1]-.5]);
            if(pts.length<3){const box=cv.boundingRect(contour);pts.splice(0,pts.length,[box.x-1,box.y-1],[box.x+box.width-1,box.y-1],[box.x+box.width-1,box.y+box.height-1],[box.x-1,box.y+box.height-1]);}
            vertices+=pts.length;if(vertices>200000)throw new Error('矢量节点超过 20 万，请缩小图片后重试。');output.push(pts);
          }finally{approx.delete();contour.delete();}
        }
        send({type:'result',requestId:request.requestId,contours:output});return;
      }
      const x0 = Math.max(0, Math.min(width - 1, Math.floor(Number(region.x0) || 0)));
      const y0 = Math.max(0, Math.min(height - 1, Math.floor(Number(region.y0) || 0)));
      const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil(Number(region.x1) || width)));
      const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil(Number(region.y1) || height)));
      const rgba = new cv.Mat(height, width, cv.CV_8UC4), rgb = new cv.Mat(), mask = cv.Mat.zeros(height, width, cv.CV_8UC1), repairedRgb = new cv.Mat(), repairedRgba = new cv.Mat(), alpha = new cv.Mat(height, width, cv.CV_8UC1), repairedAlpha = new cv.Mat();
      mats.push(rgba, rgb, mask, repairedRgb, repairedRgba, alpha, repairedAlpha);rgba.data.set(sourcePixels);cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
      for (let y = y0; y < y1; y += 1) mask.data.fill(255, y * width + x0, y * width + x1);
      for (let index = 0; index < width * height; index += 1) alpha.data[index] = sourcePixels[index * 4 + 3];
      cv.inpaint(rgb, mask, repairedRgb, 3, cv.INPAINT_TELEA);cv.inpaint(alpha, mask, repairedAlpha, 3, cv.INPAINT_TELEA);cv.cvtColor(repairedRgb, repairedRgba, cv.COLOR_RGB2RGBA);
      const output = new Uint8ClampedArray(repairedRgba.data);for (let index = 0; index < width * height; index += 1) output[index * 4 + 3] = repairedAlpha.data[index];
      send({ type: 'result', requestId: request.requestId, pixels: output.buffer }, [output.buffer]);
    } catch (error) {
      send({ type: 'error', requestId: request.requestId, message: error?.message || String(error) });
    } finally {
      for (const mat of mats.reverse()) { try { mat.delete(); } catch {} }
    }
  });
})();
