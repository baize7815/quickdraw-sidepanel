'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {chromium}=require('playwright');

test('扩展目录不包含 Chrome 保留名称，清单入口文件存在',()=>{
  const root=path.resolve(__dirname,'..');
  const reserved=[];
  function inspect(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(entry.name.startsWith('_'))reserved.push(path.relative(root,path.join(dir,entry.name)));if(entry.isDirectory())inspect(path.join(dir,entry.name));}}
  inspect(root);assert.deepEqual(reserved,[],'扩展不能包含 Chrome 保留名称');
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  for(const file of [manifest.background.service_worker,manifest.side_panel.default_path,...manifest.sandbox.pages,...Object.values(manifest.icons)])assert.ok(fs.existsSync(path.join(root,file)),file);
});

// Branded Chrome/Edge no longer support command-line extension loading.
// Use an already-installed Playwright Chromium or Chrome for Testing binary.
const executable=process.env.QD_EXTENSION_CHROMIUM||chromium.executablePath();
test('实际扩展加载及隔离 OpenCV 轮廓提取', {skip:!fs.existsSync(executable)&&'没有安装可命令行加载扩展的 Chromium；不自动安装浏览器'},async()=>{
  const root=path.resolve(__dirname,'..');
  const prefix=path.resolve(os.tmpdir(),'quickdraw-extension-smoke-'),profile=fs.mkdtempSync(prefix);
  let context;
  try{
    context=await chromium.launchPersistentContext(profile,{executablePath:executable,headless:true,args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:15000});
    const extensionId=new URL(worker.url()).host,page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);await page.waitForFunction(()=>window.quickdraw?.fileIndex);
    const result=await page.evaluate(async()=>{
      const data=new ImageData(30,30);for(let y=2;y<28;y++)for(let x=2;x<28;x++){if(x>10&&x<20&&y>10&&y<20)continue;data.data[(y*30+x)*4+3]=255;}
      const contours=await quickdraw.traceInSandbox(data,16);return {version:chrome.runtime.getManifest().version,contours:contours.length,toolbar:!!document.getElementById('selection-toolbar')};
    });
    assert.equal(result.version,'3.7.3');assert.equal(result.contours,2);assert.equal(result.toolbar,true);assert.deepEqual(errors,[]);
  }finally{
    await context?.close();
    const actual=fs.realpathSync(profile);assert.ok(actual.startsWith(prefix));fs.rmSync(actual,{recursive:true,force:true});
  }
});
