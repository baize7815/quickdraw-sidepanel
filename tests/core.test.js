'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../core-utils.js');
require('../vector-utils.js');
require('../editing-tools.js');
require('../sidepanel.js');

const Board = globalThis.QuickdrawBoard;

function boardWith(elements, selected = elements) {
  const board = Object.create(Board.prototype);
  board.elements = elements;
  board.selectedElements = selected;
  board.selectedElement = selected.at(-1) || null;
  board.scale = 1;
  board.snapToGrid = true;
  board.currentColor = '#111111';
  board.currentMindStyle = 'rounded';
  board.theme = 'light';
  board.commitCount = 0;
  board.commit = () => { board.commitCount++; };
  board.render = () => {};
  board.toast = message => { board.lastToast = message; };
  return board;
}

test('增量历史补丁可以完整撤销和重做', () => {
  const before = [{ id: 'a', type: 'rect', x: 0 }, { id: 'b', type: 'rect', x: 20 }];
  const after = [{ id: 'b', type: 'rect', x: 30 }, { id: 'c', type: 'note', text: '新建' }];
  const patch = core.buildElementPatch(before, after);
  assert.deepEqual(core.applyElementPatch(after, patch, 'undo'), before);
  assert.deepEqual(core.applyElementPatch(before, patch, 'redo'), after);
});

test('四边对齐按选区外框工作', () => {
  const a = { id: 'a', type: 'rect', x: 10, y: 20, w: 20, h: 30 };
  const b = { id: 'b', type: 'rect', x: 80, y: 60, w: 40, h: 10 };
  const board = boardWith([a, b]);
  board.alignSelected('top');
  assert.equal(a.y, 20);
  assert.equal(b.y, 20);
  board.alignSelected('right');
  assert.equal(a.x + a.w, 120);
  assert.equal(b.x + b.w, 120);
  assert.equal(board.commitCount, 2);
});

test('Alt+T/L/R/B 会触发对应的对象对齐命令', () => {
  const board = boardWith([]);
  const calls = [];
  board.alignSelected = mode => calls.push(mode);
  for (const key of ['t', 'l', 'r', 'b']) {
    let prevented = false;
    board.onKeyDown({ key, altKey: true, ctrlKey: false, metaKey: false, target: { tagName: 'DIV' }, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  }
  assert.deepEqual(calls, ['top', 'left', 'right', 'bottom']);
});

test('Ctrl+C 默认将所选对象作为 PNG 写入剪贴板流程', () => {
  const shape = { id: 'a', type: 'rect', x: 0, y: 0, w: 20, h: 20 };
  const board = boardWith([shape]);
  let copied = null;
  board.copyPNG = items => { copied = items; };
  let prevented = false;
  board.onKeyDown({ key: 'c', altKey: false, ctrlKey: true, metaKey: false, target: { tagName: 'DIV' }, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(copied, [shape]);
});

test('横向等间距分布保留首尾并均分空隙', () => {
  const items = [
    { id: 'a', type: 'rect', x: 0, y: 0, w: 20, h: 20 },
    { id: 'b', type: 'rect', x: 30, y: 0, w: 20, h: 20 },
    { id: 'c', type: 'rect', x: 100, y: 0, w: 20, h: 20 }
  ];
  const board = boardWith(items);
  board.distributeSelected('x');
  assert.equal(items[0].x, 0);
  assert.equal(items[1].x, 50);
  assert.equal(items[2].x, 100);
});

test('拖动对象只吸附网格，不依赖其他对象参考线', () => {
  const selected = { id: 'a', type: 'rect', x: 0, y: 0, w: 20, h: 20 };
  const target = { id: 'b', type: 'rect', x: 55, y: 100, w: 20, h: 20 };
  const board = boardWith([selected, target], [selected]);
  const nearGrid = board.calculateGridDrag([core.clone(selected)], 22, 22);
  assert.deepEqual({ dx: nearGrid.dx, dy: nearGrid.dy }, { dx: 24, dy: 24 });
  const freeDrag = board.calculateGridDrag([core.clone(selected)], 13, 13);
  assert.deepEqual({ dx: freeDrag.dx, dy: freeDrag.dy }, { dx: 13, dy: 13 });
});

test('Shift 拖动角点时保持图片和形状的宽高比', () => {
  const image = { id: 'i', type: 'image', x: 0, y: 0, w: 100, h: 50 };
  const board = boardWith([image]);
  board.resizeStart = { bbox: { x: 0, y: 0, w: 100, h: 50 }, elements: [core.clone(image)] };
  board.resizeSelection('se', { x: 250, y: 80 }, true);
  assert.equal(image.w, 250);
  assert.equal(image.h, 125);
});

test('缩放画笔对象时描边粗细按整体比例同步缩放', () => {
  const draw = { id: 'd', type: 'draw', size: 4, points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] };
  const highlight = { id: 'h', type: 'highlight', size: 3, points: [{ x: 20, y: 20 }, { x: 80, y: 80 }] };
  const board = boardWith([draw, highlight]);
  board.resizeStart = { bbox: { x: 0, y: 0, w: 100, h: 100 }, elements: [core.clone(draw), core.clone(highlight)] };
  board.resizeSelection('se', { x: 200, y: 200 });
  assert.equal(draw.size, 8);
  assert.equal(highlight.size, 6);
  assert.deepEqual(draw.points.at(-1), { x: 200, y: 200 });
});

test('自由画笔首尾在合理容差内时可识别为闭合填充形状', () => {
  const closed = { id: 'd', type: 'draw', size: 4, fill: 'solid', points: [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 80 }, { x: 0, y: 80 }, { x: 14, y: 5 }] };
  const open = { ...closed, id: 'o', points: [...closed.points.slice(0, -1), { x: 55, y: 45 }] };
  const board = boardWith([closed, open]);
  assert.equal(board.isClosedFreehand(closed), true);
  assert.equal(board.isClosedFreehand(open), false);
});

test('图片裁剪会按显示区域映射源像素并更新图片边界', async () => {
  const image = { id: 'i', type: 'image', assetId: 'old', x: 0, y: 0, w: 100, h: 50, sourceUrl: 'source' };
  const board = boardWith([image]);
  board.cropTarget = image;
  board.imageCache = new Map();
  board.store = {
    getAsset: async () => ({ blob: new Blob(['image'], { type: 'image/png' }) }),
    putAsset: async () => 'new'
  };
  let drawArgs = null;
  board.loadCropDrawable = async () => ({ drawable: {}, width: 1000, height: 500, dispose() {} });
  board.cancelImageCrop = () => { board.cropTarget = null; };
  board.setSelection = () => {};
  board.getCachedImage = () => null;
  const oldDocument = globalThis.document;
  globalThis.document = {
    createElement() {
      return {
        width: 0, height: 0,
        getContext() { return { drawImage(...args) { drawArgs = args; } }; },
        toBlob(callback) { callback(new Blob(['cropped'], { type: 'image/png' })); }
      };
    }
  };
  try { await board.applyImageCrop({ x: 10, y: 10, w: 50, h: 25 }); } finally { globalThis.document = oldDocument; }
  assert.deepEqual(drawArgs.slice(1, 5), [100, 100, 500, 250]);
  assert.deepEqual({ assetId: image.assetId, x: image.x, y: image.y, w: image.w, h: image.h }, { assetId: 'new', x: 10, y: 10, w: 50, h: 25 });
});

test('直线命中按线段距离判断，不再误选整个外接矩形', () => {
  const line = { id: 'l', type: 'line', x: 0, y: 0, w: 100, h: 100, size: 2 };
  const board = boardWith([line]);
  assert.equal(board.pointInElement({ x: 50, y: 53 }, line), true);
  assert.equal(board.pointInElement({ x: 20, y: 80 }, line), false);
});

test('形状点选命中会清除画布 DPR 变换后再计算', () => {
  const triangle = { id: 't', type: 'triangle', x: 0, y: 0, w: 100, h: 100, fill: 'solid', size: 4 };
  const board = boardWith([triangle]);
  let identity = false;
  board.ctx = {
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    setTransform(a, b, c, d, e, f) { identity = [a, b, c, d, e, f].join(',') === '1,0,0,1,0,0'; },
    isPointInPath() { return identity; }, isPointInStroke() { return false; }
  };
  assert.equal(board.pointInElement({ x: 50, y: 60 }, triangle), true);
});

test('复制思维导图子节点会保留与原父节点的连线', () => {
  const root = { id: 'r', type: 'mindnode', x: 0, y: 0, w: 100, h: 40, parentId: null };
  const child = { id: 'c', type: 'mindnode', x: 180, y: 0, w: 100, h: 40, parentId: 'r' };
  const edge = { id: 'e', type: 'mindedge', fromId: 'r', toId: 'c' };
  const board = boardWith([edge, root, child], [child]);
  const copied = board.cloneElements([child]);
  const copiedNode = copied.find(item => item.type === 'mindnode');
  const copiedEdge = copied.find(item => item.type === 'mindedge');
  assert.ok(copiedNode && copiedEdge);
  assert.equal(copiedNode.parentId, 'r');
  assert.equal(copiedEdge.fromId, 'r');
  assert.equal(copiedEdge.toId, copiedNode.id);
});

test('复制所选 PNG 时只包含所选对象及其内部思维连线', () => {
  const a = { id: 'a', type: 'mindnode', parentId: null };
  const b = { id: 'b', type: 'mindnode', parentId: 'a' };
  const edge = { id: 'e', type: 'mindedge', fromId: 'a', toId: 'b' };
  const unrelated = { id: 'x', type: 'rect', x: 0, y: 0, w: 10, h: 10 };
  const board = boardWith([edge, a, b, unrelated], [a, b]);
  const exported = board.exportElementsFor([a, b]);
  assert.deepEqual(new Set(exported.map(item => item.id)), new Set(['a', 'b', 'e']));
});

test('折叠思维导图分支会隐藏所有后代及关联边', () => {
  const root = { id: 'r', type: 'mindnode', parentId: null, collapsed: true };
  const child = { id: 'c', type: 'mindnode', parentId: 'r' };
  const grandchild = { id: 'g', type: 'mindnode', parentId: 'c' };
  const edge = { id: 'e', type: 'mindedge', fromId: 'r', toId: 'c' };
  const board = boardWith([edge, root, child, grandchild]);
  assert.equal(board.isElementVisible(root), true);
  assert.equal(board.isElementVisible(child), false);
  assert.equal(board.isElementVisible(grandchild), false);
  assert.equal(board.isElementVisible(edge), false);
});

test('橡皮擦删除思维节点时不会遗留孤立连线', () => {
  const root = { id: 'r', type: 'mindnode', x: 0, y: 0, w: 100, h: 40, parentId: null };
  const child = { id: 'c', type: 'mindnode', x: 180, y: 0, w: 100, h: 40, parentId: 'r' };
  const edge = { id: 'e', type: 'mindedge', fromId: 'r', toId: 'c' };
  const board = boardWith([edge, root, child], []);
  board.pointInElement = (_point, element) => element.id === 'r';
  board.setSelection = () => {};
  board.eraseAt({ x: 10, y: 10 });
  assert.deepEqual(board.elements, []);
});

test('删除当前画板会切换到仍存在的画板且不留下索引孤儿', async () => {
  const files = [{ id: 'a', name: 'A', updatedAt: 1 }, { id: 'b', name: 'B', updatedAt: 2 }];
  const board = boardWith([]);
  board.fileIndex = { current: 'a', files };
  board.currentFileId = 'a';
  board.INDEX_KEY = 'index';
  board.fileKey = id => `file:${id}`;
  board.store = { withLock: async (_name, task) => task(), deleteVersions: async id => { board.deletedVersions = id; } };
  board.storageGet = async () => ({ index: board.fileIndex });
  board.storageRemove = async keys => { board.removedKeys = keys; };
  board.storageSet = async values => { board.savedIndex = values.index; };
  board.openFile = async (id, fit, skipSave) => { board.opened = { id, fit, skipSave }; };
  board.renderFilesMenu = () => {};
  const oldConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  try { await board.deleteFile('a'); } finally { globalThis.confirm = oldConfirm; }
  assert.deepEqual(board.removedKeys, ['file:a']);
  assert.equal(board.savedIndex.files.some(file => file.id === 'a'), false);
  assert.deepEqual(board.opened, { id: 'b', fit: false, skipSave: true });
  assert.equal(board.deletedVersions, 'a');
});

test('Mermaid 可导入为原生对象并序列化回源码', () => {
  const board = boardWith([]);
  board.width = 800;
  board.height = 600;
  board.offsetX = 0;
  board.offsetY = 0;
  board.ctx = { save() {}, restore() {}, measureText(value) { return { width: String(value).length * 8 }; } };
  const parsed = board.parseMermaidFlowchart('flowchart TD\nA([开始]) -->|通过| B{检查}\nB --> C[完成]');
  const layout = board.layoutMermaidFlowchart(parsed);
  board.elements = [...layout.edges, ...layout.nodes];
  const source = board.serializeMermaidFlowchart();
  assert.match(source, /^flowchart LR/m);
  assert.match(source, /A\(\["开始"\]\)/);
  assert.match(source, /-->\|通过\|/);
  assert.equal(layout.nodes.length, 3);
  assert.equal(layout.edges.length, 2);
});

test('界面脚本引用的静态 ID 全部存在且 HTML 没有重复 ID', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'sidepanel.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'sidepanel.js'), 'utf8').replace(/\r\n/g, '\n');
  const opencvSandbox = fs.readFileSync(path.join(__dirname, '..', 'opencv-sandbox.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'sidepanel.css'), 'utf8');
  const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(htmlIds).size, htmlIds.length, 'HTML 中存在重复 ID');
  const referenced = new Set([...script.matchAll(/\$\('#([A-Za-z][\w-]*)'\)/g)].map(match => match[1]));
  const missing = [...referenced].filter(id => !htmlIds.includes(id));
  assert.deepEqual(missing, []);
  assert.equal(/class="app-logo"[^>]*href=/.test(html), false, 'Logo 不应包含超链接');
  assert.ok(html.includes('id="btn-clear-storage"'), '左上角按钮应提供清除本地存储功能');
  assert.equal(/class="watermark"/.test(html), false, '界面不应保留文字水印');
  assert.equal(script.includes('drawAlignmentGuides'), false, '参考线绘制逻辑应彻底移除');
  assert.match(css, /\.style-popover\{[^}]*box-shadow:none;/, '顶部属性面板不应保留投影');
  assert.equal(html.includes('id="minimap"'), false, '画布不应保留小地图');
  assert.equal(html.includes('id="minimap-control"'), false, '菜单不应保留小地图开关');
  assert.equal(script.includes('drawMinimap'), false, '脚本不应保留小地图绘制逻辑');
  assert.equal(script.includes('showMinimap'), false, '偏好设置不应继续保存小地图状态');
  const acceptedMindmap = script.indexOf("this.hideAIDialogAfterSubmit(response.taskId);this.refreshAITasks().catch(()=>{});", script.indexOf('async submitAIMindmap()'));
  const acceptedImage = script.indexOf("this.hideAIDialogAfterSubmit(response.taskId);this.refreshAITasks().catch(()=>{});", script.indexOf('async submitAIImageEdit()'));
  assert.ok(acceptedMindmap >= 0 && acceptedImage >= 0, '后台接受任务后应立即关闭提交弹窗，再异步刷新任务列表');
  assert.ok(css.includes('right:10px;top:50%;bottom:auto;transform:translateY(-50%);width:38px'), '样式工具栏应固定在画布右侧');
  assert.ok(css.includes('flex-direction:column;align-items:center'), '样式工具应纵向排列');
  assert.ok(html.includes('id="btn-crop"'), '左侧操作栏应包含图片裁剪按钮');
  assert.ok(html.includes('id="btn-remove-bg"'), '左侧操作栏应包含 AI 抠图按钮');
  assert.ok(html.includes('id="btn-remove-watermark"'), '左侧操作栏应包含 Telea 去水印按钮');
  assert.match(script, /for\(let index=0;index<targets\.length;index\+=1\)/, 'AI 抠图应逐张顺序处理多选图片');
  assert.ok(opencvSandbox.includes('cv.INPAINT_TELEA'), '去水印应在隔离沙箱中调用 OpenCV Telea 算法');
  assert.ok(script.includes("this.currentDash = 'solid'"), '默认线型应为实线');
  assert.equal(html.includes('data-dash="draw"'), false, '界面不应保留手绘线型');
  assert.match(css, /\.text-editor:focus,.text-editor:focus-visible\{outline:none!important\}/, '文字编辑器不应显示错位的浏览器焦点框');
  assert.match(script, /this\.history\.length > 10/, '撤销历史最多保留 10 步');
  assert.ok(script.includes("this.traceFreehandPath(ctx, el);\n            ctx.stroke();"), '荧光笔应整条路径一次绘制，避免分段透明度叠加');
  assert.ok(script.includes("if(el.type==='highlight')return `<polyline"), 'SVG 导出中的荧光笔也应使用单条等宽路径');
  assert.ok(script.includes("else if(this.currentTool==='highlight')this.currentElement={...base,type:'highlight',points:[{x:q.x,y:q.y}]}"), '荧光笔采样点不应保存压感');
  assert.ok(html.includes('id="btn-export-assets"'), '顶部应包含图片资源打包按钮');
  assert.ok(html.includes('title="下载画布中的当前图片"'), '图片下载入口应说明下载当前画布资源');
  assert.equal(script.includes('getOriginalAsset'), false, '图片下载不应回溯到抠图或裁剪前的资源');
  assert.match(script, /getAsset\(image\.assetId\)/, '图片下载应读取每个画布对象当前绑定的资源');
  assert.match(script, /if\(entries\.length===1\)\{await this\.downloadBlob\(entries\[0\]\.blob,entries\[0\]\.name\)/, '单张图片应直接下载而不生成 ZIP');
  assert.match(script, /QDZip\.createZip\(entries\)/, '多张图片应生成 ZIP');
  assert.ok(html.includes('id="btn-export-directory"'), '菜单应包含默认导出路径设置');
  assert.equal(html.includes('id="btn-export-pdf"'), false, '菜单不应继续显示 PDF 导出入口');
  assert.ok(script.includes('saveAs:false'), '默认下载不应弹出另存为对话框');
});

test('Manifest 仅固定授权抠图服务，并为其他网站保留按需权限', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '3.7.3');
  assert.equal(Number(manifest.minimum_chrome_version) >= 116, true);
  assert.deepEqual(manifest.host_permissions, ['https://www.koukoutu.com/*', 'https://*.koukoutu.com/*']);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  assert.ok(manifest.permissions.includes('activeTab'));
  assert.match(manifest.content_security_policy.extension_pages, /wasm-unsafe-eval/);
  assert.deepEqual(manifest.sandbox.pages, ['opencv-sandbox.html']);
  assert.match(manifest.content_security_policy.sandbox, /unsafe-eval/);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'vendor', 'koukoutu-recaptcha.wasm')), true);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'vendor', 'opencv-4.13.0.js')), true);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'opencv-sandbox.js')), true);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'LICENSE_OPENCV.txt')), true);
});

test('图片资源包生成标准 ZIP 并保留 UTF-8 文件名', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const context = { Blob, TextEncoder, Uint8Array, Uint32Array, DataView, Date };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'zip-utils.js'), 'utf8'), context);
  const zip = await context.QDZip.createZip([{ name: '原图.png', blob: new Blob([new Uint8Array([1, 2, 3])]) }]);
  const bytes = new Uint8Array(await zip.arrayBuffer());
  assert.equal(new DataView(bytes.buffer).getUint32(0, true), 0x04034b50);
  assert.equal(new DataView(bytes.buffer).getUint32(bytes.length - 22, true), 0x06054b50);
  assert.ok(new TextDecoder().decode(bytes).includes('原图.png'));
});

test('本地 OpenCV 构建包含可运行的 Telea 修复算法', async () => {
  const path = require('node:path');
  const module = require(path.join(__dirname, '..', 'vendor', 'opencv-4.13.0.js'));
  const { api: cv } = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('OpenCV 初始化超时')), 20_000);
    module.then(api => { clearTimeout(timeout); resolve({ api }); });
  });
  const source = new cv.Mat(7, 7, cv.CV_8UC3, new cv.Scalar(90, 120, 150));
  const mask = cv.Mat.zeros(7, 7, cv.CV_8UC1);
  const output = new cv.Mat();
  try {
    mask.data[3 * 7 + 3] = 255;
    cv.inpaint(source, mask, output, 3, cv.INPAINT_TELEA);
    assert.equal(cv.INPAINT_TELEA, 1);
    assert.equal(output.rows, 7);
    assert.equal(output.cols, 7);
    assert.equal(output.data.length, 147);
  } finally {
    source.delete();
    mask.delete();
    output.delete();
  }
});

test('后台脚本可加载并注册安装、点击和右键菜单事件', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const registered = {};
  const context = {
    console,
    URL,
    crypto,
    importScripts() { context.QuickdrawStorage = class {}; },
    chrome: {
      runtime: { onInstalled: { addListener(fn) { registered.installed = fn; } } },
      sidePanel: {},
      contextMenus: { onClicked: { addListener(fn) { registered.context = fn; } } },
      action: { onClicked: { addListener(fn) { registered.action = fn; } } },
      permissions: {},
      storage: { session: {} },
      tabs: {}
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), context);
  assert.equal(typeof registered.installed, 'function');
  assert.equal(typeof registered.action, 'function');
  assert.equal(typeof registered.context, 'function');
});
