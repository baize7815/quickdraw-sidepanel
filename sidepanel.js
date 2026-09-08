(() => {
  'use strict';

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const clone = globalThis.QDCore.clone;
  const newId = () => globalThis.QDCore.newId('e');
  const MAX_AI_OUTPUT_IMAGES = Number(globalThis.QuickdrawAI?.MAX_INPUT_IMAGES || 4);

  class QuickdrawBoard {
    constructor() {
      this.app = $('#app');
      this.container = $('#canvas-container');
      this.gridCanvas = $('#grid-canvas');
      this.paintCanvas = $('#paint-canvas');
      this.gridCtx = this.gridCanvas.getContext('2d');
      this.ctx = this.paintCanvas.getContext('2d');

      this.elements = [];
      this.imageCache = new Map();
      this.currentTool = 'select';
      this.currentShape = 'rect';
      this.currentColor = '#1f1f1f';
      this.currentSize = 4;
      this.currentDash = 'solid';
      this.currentFill = 'none';
      this.currentStroke = 'solid';
      this.currentMindStyle = 'rounded';
      this.gridType = 'lines';
      this.theme = 'light';

      this.scale = 1;
      this.offsetX = 0;
      this.offsetY = 0;
      this.dpr = window.devicePixelRatio || 1;

      this.selectedElement = null;
      this.selectedElements = [];
      this.currentElement = null;
      this.isMarqueeSelecting = false;
      this.marqueeStart = null;
      this.marqueeRect = null;
      this.marqueeBase = [];
      this.marqueeAdditive = false;
      this.pointerDown = false;
      this.isPanning = false;
      this.isDragging = false;
      this.isResizing = false;
      this.resizeHandle = null;
      this.dragStart = null;
      this.dragOrigin = null;
      this.altDuplicatePending = false;
      this.dragHasMoved = false;
      this.panStart = null;
      this.panPointerId = null;
      this.interactionPointerId = null;
      this.cropTarget = null;
      this.cropStart = null;
      this.cropRect = null;
      this.cropSession = 0;
      this.watermarkTarget = null;
      this.watermarkStart = null;
      this.watermarkRect = null;
      this.watermarkSession = 0;
      this.watermarkRemovalInProgress = false;
      this.openCvSandbox = null;
      this.openCvSandboxReadyPromise = null;
      this.resizeStart = null;
      this.eraserChanged = false;
      this.spaceDown = false;
      this.penDraft = null;
      this.penDrag = null;
      this.penEdit = null;
      this.rotationDrag = null;
      this.editingBusy = false;
      this.cropRatio = 0;
      this.mindLinkDraft = null;
      this.arrowCurveDrag = null;
      this.arrowPointDrag = null;
      this.contextMindNode = null;

      this.history = [];
      this.redos = [];
      this.saveTimer = null;
      this.currentFileId = null;
      this.fileIndex = null;
      this.store = new QuickdrawStorage();
      this.aiTaskStore = globalThis.QuickdrawAITaskStore ? new globalThis.QuickdrawAITaskStore() : null;
      this.aiTasks = [];
      this.aiProvider = 'gpt';
      this.aiImporting = new Set();
      this.aiTaskReceipts = new Map();
      this.aiSubmitBusy = false;
      this.aiCurrentTaskId = null;
      this.aiProgressTask = null;
      this.aiDismissedTaskIds = new Set();
      this.aiDialogMode = 'mindmap';
      this.aiImageSelection = null;
      this.aiBoardEpoch = 0;
      this.boardLoading = false;
      this.instanceId = globalThis.QDCore.newId('i');
      this.documentRevision = 0;
      this.saveQueue = Promise.resolve();
      this.dirty = false;
      this.windowId = null;
      this.snapToGrid = true;
      this.exporting = false;
      this.renderFrame = null;
      this.gridRenderKey = '';
      this.spatialIndex = new Map();
      this.spatialDirty = true;
      this.EXPORT_DIRECTORY_KEY = 'quickdraw-export-directory';
      this.koukoutuClient = new globalThis.QuickdrawKoukoutuClient();
      this.backgroundRemovalInProgress = false;

      this.init();
    }

    async init() {
      this.setupUI();
      this.setupAIUI();
      this.setupEditingUI();
      this.setupEvents();
      this.resizeCanvas();
      await this.initPersistence();
      await this.syncExportDirectoryUI();
      await this.initWindowContext();
      this.setupImageHandlers();
      await this.checkPendingCapture();
      this.render();
      this.container.focus({ preventScroll: true });
    }

    // ---------- storage / files ----------
    async storageGet(keys) {
      return this.store.get(keys);
    }

    async storageSet(obj) {
      return this.store.set(obj);
    }

    async storageRemove(keys) {
      return this.store.remove(keys);
    }

    fileKey(id) { return `quickdraw_v2_file:${id}`; }

    async initPersistence() {
      const INDEX_KEY = 'quickdraw_v2_files';
      const PREF_KEY = 'quickdraw_v2_prefs';
      this.INDEX_KEY = INDEX_KEY;
      this.PREF_KEY = PREF_KEY;
      const stored = await this.storageGet([INDEX_KEY, PREF_KEY]);
      const prefs = stored[PREF_KEY] || {};
      this.theme = prefs.theme || 'light';
      this.gridType = prefs.grid || 'lines';
      this.currentMindStyle = prefs.mindStyle || 'rounded';
      this.snapToGrid = prefs.snapToGrid !== false;
      this.aiProvider = globalThis.QuickdrawAI?.provider(prefs.aiProvider)?.id || 'gpt';
      this.applyTheme();
      this.syncGridUI();

      this.fileIndex = stored[INDEX_KEY];
      if (!this.fileIndex?.files?.length) {
        const id = `f${newId().slice(1)}`;
        this.fileIndex = { current: id, files: [{ id, name: 'Untitled', updatedAt: Date.now() }] };

        // Migrate drawings made with the previous extension version instead of
        // silently discarding them during the UI/engine upgrade.
        let initialDoc = this.blankDocument();
        const legacy = await this.storageGet(['quickdraw_elements']);
        if (legacy.quickdraw_elements) {
          try {
            const raw = typeof legacy.quickdraw_elements === 'string'
              ? JSON.parse(legacy.quickdraw_elements)
              : legacy.quickdraw_elements;
            if (Array.isArray(raw)) {
              initialDoc.elements = raw.map(el => ({
                ...el,
                id: el.id || newId(),
                type: el.type === 'pen' ? 'draw' : el.type === 'highlighter' ? 'highlight' : el.type,
                dash: el.dash || 'solid'
              }));
            }
          } catch {}
        }
        await this.storageSet({ [INDEX_KEY]: this.fileIndex, [this.fileKey(id)]: initialDoc });
      }
      const requestedId = new URLSearchParams(location.search).get('file');
      const initialId = this.fileIndex.files.some(file => file.id === requestedId)
        ? requestedId
        : (this.fileIndex.current || this.fileIndex.files[0].id);
      this.currentFileId = null;
      await this.openFile(initialId, false);
      await this.refreshAITasks();
    }

    blankDocument() { return { version: 4, revision: 0, elements: [], camera: { scale: 1, offsetX: 0, offsetY: 0 }, aiTaskReceipts: {} }; }

    serializeDocument() {
      return {
        version: 4,
        revision: this.documentRevision,
        updatedBy: this.instanceId,
        elements: clone(this.elements),
        camera: { scale: this.scale, offsetX: this.offsetX, offsetY: this.offsetY },
        aiTaskReceipts: Object.fromEntries(this.aiTaskReceipts || [])
      };
    }

    async saveFileNow(options = {}) {
      if (!this.currentFileId) return null;
      clearTimeout(this.saveTimer);
      const fileId = this.currentFileId;
      const localFile = this.fileIndex.files.find(file => file.id === fileId);
      const document = this.serializeDocument();
      const updatedAt = Date.now();
      this.saveQueue = this.saveQueue.catch(() => {}).then(() => this.store.withLock('documents', async () => {
        const stored = await this.storageGet([this.INDEX_KEY, this.fileKey(fileId)]);
        const latestIndex = stored[this.INDEX_KEY] || this.fileIndex;
        const remote = stored[this.fileKey(fileId)];
        if (remote?.revision > this.documentRevision && remote.updatedBy && remote.updatedBy !== this.instanceId) {
          const conflictId = `f${newId().slice(1)}`;
          const conflictName = `${localFile?.name || 'Untitled'}（冲突副本）`;
          const conflictDocument = { ...document, revision: 1, updatedBy: this.instanceId };
          latestIndex.files.push({ id: conflictId, name: conflictName, updatedAt });
          latestIndex.current = conflictId;
          await this.storageSet({ [this.fileKey(conflictId)]: conflictDocument, [this.INDEX_KEY]: latestIndex });
          this.currentFileId = conflictId;
          this.documentRevision = 1;
          this.fileIndex = latestIndex;
          $('#file-name').value = conflictName;
          this.sizeFileName();
          this.dirty = false;
          if (options.snapshot !== false) await this.store.saveVersion(conflictId, conflictDocument, conflictName, true);
          this.toast('检测到其他窗口的修改，当前内容已保存为冲突副本。');
          return conflictId;
        }
        document.revision = Math.max(this.documentRevision, remote?.revision || 0) + 1;
        document.updatedBy = this.instanceId;
        const remoteFile = latestIndex.files.find(file => file.id === fileId);
        if (remoteFile) {
          remoteFile.name = localFile?.name || remoteFile.name;
          remoteFile.updatedAt = updatedAt;
        } else latestIndex.files.push({ id: fileId, name: localFile?.name || 'Untitled', updatedAt });
        latestIndex.current = fileId;
        await this.storageSet({ [this.fileKey(fileId)]: document, [this.INDEX_KEY]: latestIndex });
        this.documentRevision = document.revision;
        this.fileIndex = latestIndex;
        this.dirty = false;
        if (options.snapshot !== false) await this.store.saveVersion(fileId, document, localFile?.name || 'Untitled');
        return fileId;
      })).catch(error => {
        console.error('Quickdraw save failed', error);
        this.toast('保存失败：请导出项目文件后重试。');
        throw error;
      });
      return this.saveQueue;
    }

    scheduleSave() {
      clearTimeout(this.saveTimer);
      this.dirty = true;
      this.saveTimer = setTimeout(() => this.saveFileNow().catch(() => {}), 250);
    }

    async openFile(id, fit = true, skipSave = false) {
      const loadEpoch = ++this.aiBoardEpoch;
      this.boardLoading = true;
      try {
        if (!skipSave) await this.saveFileNow();
        if (loadEpoch !== this.aiBoardEpoch) return;
        const file = this.fileIndex.files.find(f => f.id === id);
        if (!file) return;
        this.currentFileId = id;
        this.fileIndex.current = id;
        const data = await this.storageGet([this.fileKey(id)]);
        if (loadEpoch !== this.aiBoardEpoch || this.currentFileId !== id) return;
        const doc = data[this.fileKey(id)] || this.blankDocument();
        this.elements = Array.isArray(doc.elements) ? doc.elements : [];
        this.aiTaskReceipts = new Map(Object.entries(doc.aiTaskReceipts || {}).map(([taskId, receipt]) => [taskId, { ...receipt, taskId, boardId:id }]));
        this.store.releaseObjectUrlsExcept(this.elements.map(el=>el.assetId).filter(Boolean));
        this.imageCache.clear();
        this.documentRevision = Number(doc.revision) || 0;
        const migratedImages = await this.migrateImageAssets();
        if (loadEpoch !== this.aiBoardEpoch || this.currentFileId !== id) return;
        this.migrateMindEdges();
        this.scale = doc.camera?.scale || 1;
        this.offsetX = doc.camera?.offsetX || 0;
        this.offsetY = doc.camera?.offsetY || 0;
        this.clearSelection();
        this.currentElement = null;
        this.penDraft=null;this.penDrag=null;this.penEdit=null;this.rotationDrag=null;
        this.resetHistory();
        $('#file-name').value = file.name;
        this.sizeFileName();
        await this.storageSet({ [this.INDEX_KEY]: this.fileIndex });
        if (loadEpoch !== this.aiBoardEpoch || this.currentFileId !== id) return;
        if (fit && this.elements.length) this.fitContent();
        else this.updateZoomUI();
        this.render();
        await this.preloadImages();
        if (loadEpoch !== this.aiBoardEpoch || this.currentFileId !== id) return;
        if (migratedImages) await this.saveFileNow({ snapshot: false });
      } finally {
        if (loadEpoch === this.aiBoardEpoch) this.boardLoading = false;
      }
    }

    async createFile() {
      await this.saveFileNow();
      const id = `f${newId().slice(1)}`;
      await this.store.withLock('documents', async () => {
        const stored = await this.storageGet([this.INDEX_KEY]);
        this.fileIndex = stored[this.INDEX_KEY] || this.fileIndex;
        let n = this.fileIndex.files.length + 1;
        let name = `Untitled ${n}`;
        const names = new Set(this.fileIndex.files.map(file => file.name));
        while (names.has(name)) name = `Untitled ${++n}`;
        this.fileIndex.files.push({ id, name, updatedAt: Date.now() });
        this.fileIndex.current = id;
        await this.storageSet({ [this.fileKey(id)]: this.blankDocument(), [this.INDEX_KEY]: this.fileIndex });
      });
      this.currentFileId = null;
      await this.openFile(id, false, true);
      this.closePopovers();
      $('#file-name').focus();
      $('#file-name').select();
    }

    async deleteFile(id) {
      if (this.fileIndex.files.length <= 1) return;
      const file = this.fileIndex.files.find(f => f.id === id);
      if (!file || !confirm(`删除“${file.name}”？此操作无法撤销。`)) return;
      let nextId = null;
      await this.store.withLock('documents', async () => {
        const stored = await this.storageGet([this.INDEX_KEY]);
        const latest = stored[this.INDEX_KEY] || this.fileIndex;
        latest.files = latest.files.filter(item => item.id !== id);
        const next = [...latest.files].sort((a,b) => b.updatedAt - a.updatedAt)[0];
        nextId = next?.id || null;
        latest.current = nextId;
        await this.storageRemove([this.fileKey(id)]);
        await this.storageSet({ [this.INDEX_KEY]: latest });
        this.fileIndex = latest;
      });
      if (this.currentFileId === id && nextId) {
        this.currentFileId = null;
        await this.openFile(nextId, false, true);
      }
      await this.store.deleteVersions(id).catch(error=>console.warn('Quickdraw version cleanup failed',error));
      this.renderFilesMenu();
    }

    renderFilesMenu() {
      const menu = $('#files-menu');
      menu.textContent = '';
      for (const file of [...this.fileIndex.files].sort((a,b) => b.updatedAt - a.updatedAt)) {
        const row = document.createElement('div');
        row.className = `file-row${file.id === this.currentFileId ? ' current' : ''}`;
        row.innerHTML = `<span class="dot"></span><span class="name"></span>`;
        $('.name', row).textContent = file.name;
        if (this.fileIndex.files.length > 1) {
          const del = document.createElement('button');
          del.className = 'delete-file'; del.textContent = '×'; del.title = '删除文件';
          del.addEventListener('click', e => { e.stopPropagation(); this.deleteFile(file.id); });
          row.append(del);
        }
        row.addEventListener('click', () => { menu.hidden = true; if (file.id !== this.currentFileId) this.openFile(file.id); });
        menu.append(row);
      }
    }

    sizeFileName() {
      const input = $('#file-name');
      input.style.width = `${clamp(input.value.length + 2, 7, 20)}ch`;
      this.positionOpenTabButton();
    }

    positionOpenTabButton() {
      const buttons = [$('#btn-open-tab'), $('#btn-export-assets')].filter(Boolean);
      const filebar = $('#filebar');
      if (!buttons.length || !filebar) return;
      requestAnimationFrame(() => {
        const gap = 8;
        const totalWidth = buttons.reduce((sum, button) => sum + button.offsetWidth, 0) + gap * (buttons.length - 1);
        const requestedLeft = filebar.getBoundingClientRect().right + gap;
        let left = Math.max(gap, Math.min(requestedLeft, window.innerWidth - totalWidth - gap));
        for (const button of buttons) {
          button.style.left = `${left}px`;
          left += button.offsetWidth + gap;
        }
      });
    }

    async openCanvasTab() {
      try {
        await this.saveFileNow({ snapshot: false });
        const url = new URL(globalThis.chrome?.runtime?.getURL
          ? chrome.runtime.getURL('sidepanel.html')
          : location.href);
        url.searchParams.set('file', this.currentFileId);
        url.searchParams.set('view', 'tab');
        if (globalThis.chrome?.tabs?.create) await chrome.tabs.create({ url: url.href });
        else window.open(url.href, '_blank', 'noopener');
      } catch (error) {
        console.error('Quickdraw open tab failed', error);
        this.toast('无法在新标签页中打开画板。');
      }
    }

    // ---------- history ----------
    resetHistory() {
      this.history = [];
      this.redos = [];
      this.historyBaseline = clone(this.elements);
      this.spatialDirty = true;
      this.updateHistoryUI();
    }

    commit() {
      const next = clone(this.elements);
      const patch = QDCore.buildElementPatch(this.historyBaseline || [], next);
      if (patch) {
        this.history.push(patch);
        if (this.history.length > 10) this.history.shift();
        this.redos = [];
        this.historyBaseline = next;
      }
      this.updateHistoryUI();
      this.spatialDirty = true;
      const activeAssets=this.elements.map(el=>el.assetId).filter(Boolean);this.store.releaseObjectUrlsExcept(activeAssets);const activeImages=new Set(this.elements.filter(el=>el.type==='image').map(el=>el.assetId||el.src));for(const key of this.imageCache.keys())if(!activeImages.has(key))this.imageCache.delete(key);
      this.scheduleSave();
    }

    undo() {
      if (!this.history.length) return;
      const patch = this.history.pop();
      this.elements = QDCore.applyElementPatch(this.elements, patch, 'undo');
      this.redos.push(patch);
      this.historyBaseline = clone(this.elements);
      this.spatialDirty = true;
      this.clearSelection();
      this.updateHistoryUI(); this.scheduleSave(); this.render();
    }

    redo() {
      if (!this.redos.length) return;
      const patch = this.redos.pop();
      this.elements = QDCore.applyElementPatch(this.elements, patch, 'redo');
      this.history.push(patch);
      this.historyBaseline = clone(this.elements);
      this.spatialDirty = true;
      this.clearSelection();
      this.updateHistoryUI(); this.scheduleSave(); this.render();
    }

    updateHistoryUI() {
      $('#btn-undo').disabled = this.history.length === 0;
      $('#btn-redo').disabled = this.redos.length === 0;
      $('#btn-duplicate').disabled = this.getSelectedElements().length === 0;
      const arrange=$('#btn-arrange');if(arrange)arrange.disabled=this.getSelectedElements().filter(el=>el.type!=='mindedge').length===0;
      const selected=this.getSelectedElements();
      const canEditOneImage=selected.length===1&&selected[0].type==='image';
      const canRemoveBackground=selected.length>0&&selected.every(element=>element.type==='image');
      const cropButton=$('#btn-crop'),removeBgButton=$('#btn-remove-bg'),watermarkButton=$('#btn-remove-watermark'),cropDivider=$('#crop-divider');
      const aiEditButton=$('#btn-ai-edit');
      if(aiEditButton)aiEditButton.disabled=this.backgroundRemovalInProgress||this.watermarkRemovalInProgress;
      if(cropButton){cropButton.hidden=!canEditOneImage;cropButton.disabled=this.backgroundRemovalInProgress||this.watermarkRemovalInProgress;cropButton.classList.toggle('active',canEditOneImage&&this.cropTarget===selected[0]);}
      if(removeBgButton){removeBgButton.hidden=!canRemoveBackground;removeBgButton.disabled=this.backgroundRemovalInProgress||this.watermarkRemovalInProgress;removeBgButton.classList.toggle('processing',this.backgroundRemovalInProgress);}
      if(watermarkButton){watermarkButton.hidden=!canEditOneImage;watermarkButton.disabled=this.backgroundRemovalInProgress||this.watermarkRemovalInProgress;watermarkButton.classList.toggle('active',canEditOneImage&&this.watermarkTarget===selected[0]);watermarkButton.classList.toggle('processing',this.watermarkRemovalInProgress);}
      if(cropDivider)cropDivider.hidden=!(canEditOneImage||canRemoveBackground);
      const clearAction = $('#btn-clear-action');
      if (clearAction) clearAction.disabled = this.elements.length === 0;
      this.syncShapeStyleUI(selected);
      this.updateEditingUI?.();
    }

    // ---------- canvas / camera ----------
    resizeCanvas() {
      const r = this.container.getBoundingClientRect();
      this.width = Math.max(1, r.width);
      this.height = Math.max(1, r.height);
      this.dpr = window.devicePixelRatio || 1;
      for (const canvas of [this.gridCanvas, this.paintCanvas]) {
        canvas.width = Math.round(this.width * this.dpr);
        canvas.height = Math.round(this.height * this.dpr);
      }
      this.positionOpenTabButton();
      this.render();
    }

    screenToWorld(x, y) { return { x: (x - this.offsetX) / this.scale, y: (y - this.offsetY) / this.scale }; }
    worldToScreen(x, y) { return { x: x * this.scale + this.offsetX, y: y * this.scale + this.offsetY }; }

    eventPos(e) {
      const r = this.container.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      return { sx, sy, ...this.screenToWorld(sx, sy) };
    }

    zoom(factor, clientX, clientY) {
      const old = this.scale;
      const next = clamp(old * factor, .1, 8);
      if (clientX == null) { clientX = this.width / 2; clientY = this.height / 2; }
      else {
        const r = this.container.getBoundingClientRect();
        clientX -= r.left; clientY -= r.top;
      }
      const wx = (clientX - this.offsetX) / old;
      const wy = (clientY - this.offsetY) / old;
      this.scale = next;
      this.offsetX = clientX - wx * next;
      this.offsetY = clientY - wy * next;
      this.updateZoomUI(); this.scheduleSave(); this.render();
    }

    resetZoom() { this.scale = 1; this.offsetX = 0; this.offsetY = 0; this.updateZoomUI(); this.scheduleSave(); this.render(); }
    updateZoomUI() { $('#zoom-level').textContent = `${Math.round(this.scale * 100)}%`; }

    fitContent() {
      const b = this.contentBounds();
      if (!b) return this.resetZoom();
      const pad = Math.min(100, Math.min(this.width, this.height) * .12);
      const sx = (this.width - pad * 2) / Math.max(1, b.w);
      const sy = (this.height - pad * 2) / Math.max(1, b.h);
      this.scale = clamp(Math.min(sx, sy), .1, 4);
      this.offsetX = this.width / 2 - (b.x + b.w / 2) * this.scale;
      this.offsetY = this.height / 2 - (b.y + b.h / 2) * this.scale;
      this.updateZoomUI(); this.scheduleSave(); this.render();
    }

    // ---------- rendering ----------
    prepareCtx(ctx, clear = true) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      if (clear) ctx.clearRect(0, 0, this.width, this.height);
    }

    drawGrid() {
      const ctx = this.gridCtx;
      const key=[this.gridType,this.theme,this.width,this.height,this.dpr,this.scale.toFixed(4),this.offsetX.toFixed(2),this.offsetY.toFixed(2)].join('|');if(key===this.gridRenderKey)return;this.gridRenderKey=key;
      this.prepareCtx(ctx);
      if (this.gridType === 'none') return;
      let step = 24 * this.scale;
      while (step < 14) step *= 2;
      while (step > 48) step /= 2;
      const ox = ((this.offsetX % step) + step) % step;
      const oy = ((this.offsetY % step) + step) % step;
      ctx.save();
      ctx.strokeStyle = this.theme === 'dark' ? 'rgba(255,255,255,.12)' : 'rgba(72,72,68,.14)';
      ctx.fillStyle = this.theme === 'dark' ? 'rgba(255,255,255,.22)' : 'rgba(72,72,68,.22)';
      ctx.lineWidth = 1;
      if (this.gridType === 'dots') {
        for (let x = ox; x < this.width; x += step) for (let y = oy; y < this.height; y += step) { ctx.beginPath(); ctx.arc(x,y,1,0,Math.PI*2); ctx.fill(); }
      } else if (this.gridType === 'crosses') {
        for (let x = ox; x < this.width; x += step) for (let y = oy; y < this.height; y += step) { ctx.beginPath(); ctx.moveTo(x-2.5,y); ctx.lineTo(x+2.5,y); ctx.moveTo(x,y-2.5); ctx.lineTo(x,y+2.5); ctx.stroke(); }
      } else if (this.gridType === 'ruled') {
        ctx.beginPath(); for (let y = oy; y < this.height; y += step) { ctx.moveTo(0,y); ctx.lineTo(this.width,y); } ctx.stroke();
      } else if (this.gridType === 'iso') {
        const h = step * .866;
        const first = (((this.offsetY - this.offsetX * .577) % h) + h) % h;
        const second = (((this.offsetY + this.offsetX * .577) % h) + h) % h;
        ctx.beginPath();
        for (let y = first - this.width*.58; y < this.height + this.width*.58; y += h) { ctx.moveTo(0,y); ctx.lineTo(this.width,y + this.width*.577); }
        for (let y = second - this.width*.58; y < this.height + this.width*.58; y += h) { ctx.moveTo(0,y); ctx.lineTo(this.width,y - this.width*.577); }
        ctx.stroke();
      } else {
        ctx.beginPath();
        for (let x = ox; x < this.width; x += step) { ctx.moveTo(x,0); ctx.lineTo(x,this.height); }
        for (let y = oy; y < this.height; y += step) { ctx.moveTo(0,y); ctx.lineTo(this.width,y); }
        ctx.stroke();
      }
      ctx.restore();
    }

    render() {
      if(this.renderFrame!=null)return;
      this.renderFrame=requestAnimationFrame(()=>{this.renderFrame=null;this.renderNow();});
    }

    renderNow() {
      if (!this.ctx) return;
      this.drawGrid();
      const ctx = this.ctx;
      this.prepareCtx(ctx);
      ctx.save();
      ctx.translate(this.offsetX, this.offsetY);
      ctx.scale(this.scale, this.scale);
      this.drawMindMapConnections(ctx);
      if (this.mindLinkDraft) this.drawMindLinkDraft(ctx);
      for (const el of this.elements) if(this.isElementVisible(el))this.drawElement(ctx, el);
      if (this.currentElement) this.drawElement(ctx, this.currentElement);
      this.drawEditingOverlay(ctx);
      if(this.cropTarget)this.drawCropOverlay(ctx);
      if(this.watermarkTarget)this.drawWatermarkOverlay(ctx);
      if (this.currentTool === 'select' || this.currentTool === 'mindmap') {
        this.drawCurrentSelection(ctx);
        if (this.isMarqueeSelecting && this.marqueeRect) this.drawMarquee(ctx, this.marqueeRect);
      }
      ctx.restore();
      this.updateHistoryUI();
    }

    applyStrokeStyle(ctx, el) {
      ctx.strokeStyle = el.color || this.currentColor;
      ctx.fillStyle = el.color || this.currentColor;
      ctx.lineWidth = el.size || 4;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (el.dash === 'dashed') ctx.setLineDash([12, 8]);
      else if (el.dash === 'dotted') ctx.setLineDash([2, 8]);
      else ctx.setLineDash([]);
    }

    fillCurrentPath(ctx, el) {
      if (el.fill === 'solid') ctx.fill();
      else if (el.fill === 'semi') { ctx.save(); ctx.globalAlpha *= .20; ctx.fill(); ctx.restore(); }
      else if (el.fill === 'pattern') {
        ctx.save(); ctx.clip(); ctx.globalAlpha *= .35; ctx.lineWidth = 1.2;
        const b = this.getRawElementBBox(el); if (b) for (let x = b.x - b.h; x < b.x + b.w + b.h; x += 10) { ctx.beginPath(); ctx.moveTo(x,b.y+b.h); ctx.lineTo(x+b.h,b.y); ctx.stroke(); }
        ctx.restore();
      }
    }

    freehandClosureTolerance(el) {
      const box=this.getRawElementBBox(el);if(!box)return 0;
      return Math.min(48,Math.max(18,Math.hypot(box.w,box.h)*.12,(el.size||4)*3));
    }

    isClosedFreehand(el) {
      const points=el?.points||[];if(el?.type!=='draw'||points.length<3)return false;
      return Math.hypot(points[0].x-points.at(-1).x,points[0].y-points.at(-1).y)<=this.freehandClosureTolerance(el);
    }

    traceFreehandPath(ctx,el,close=false) {
      const points=el?.points||[];if(!points.length)return false;ctx.beginPath();ctx.moveTo(points[0].x,points[0].y);for(let i=1;i<points.length;i++)ctx.lineTo(points[i].x,points[i].y);if(close)ctx.closePath();return true;
    }

    mindNodePath(ctx, el) {
      const x=el.x,y=el.y,w=el.w||150,h=el.h||44,shape=el.nodeShape||'rounded';
      ctx.beginPath();
      if(shape==='diamond'){ctx.moveTo(x+w/2,y);ctx.lineTo(x+w,y+h/2);ctx.lineTo(x+w/2,y+h);ctx.lineTo(x,y+h/2);ctx.closePath();return;}
      if(shape==='ellipse'){ctx.ellipse(x+w/2,y+h/2,Math.abs(w/2),Math.abs(h/2),0,0,Math.PI*2);return;}
      const r=shape==='pill'?h/2:shape==='rect'?4:Math.min(10,h/2);
      if(ctx.roundRect)ctx.roundRect(x,y,w,h,r);else ctx.rect(x,y,w,h);
    }

    drawElement(ctx, el) {
      ctx.save();
      if(el.transform)ctx.transform(...el.transform);
      this.applyStrokeStyle(ctx, el);
      if(el.type==='path'){
        this.drawVectorPath(ctx,el);
      } else if (el.type === 'draw' || el.type === 'highlight') {
        const pts = el.points || [];
        if (el.type === 'highlight') {
          ctx.globalAlpha = .28;
          ctx.globalCompositeOperation = this.theme === 'dark' ? 'screen' : 'multiply';
          ctx.lineWidth = (el.size || 4) * 4;
        }
        if (pts.length === 1) {
          ctx.beginPath();
          ctx.arc(pts[0].x, pts[0].y, el.type === 'highlight' ? (el.size || 4) * 2 : (el.size || 4) / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        if (pts.length > 1) {
          const closed=el.type==='draw'&&el.fill&&el.fill!=='none'&&this.isClosedFreehand(el);
          if(closed){this.traceFreehandPath(ctx,el,true);this.fillCurrentPath(ctx,el);}
          if (el.type === 'highlight') {
            this.traceFreehandPath(ctx, el);
            ctx.stroke();
          } else {
            for (let i=1;i<pts.length;i++) {
              const a=pts[i-1], b=pts[i];
              const p = b.pressure || a.pressure || .5;
              ctx.lineWidth = (el.size||4) * (.65 + p*.7);
              ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
            }
          }
          if(closed){const first=pts[0],last=pts.at(-1);ctx.beginPath();ctx.moveTo(last.x,last.y);ctx.lineTo(first.x,first.y);ctx.stroke();}
        }
      } else if (el.type === 'line' || el.type === 'arrow') {
        const ex=el.x+(el.w||0), ey=el.y+(el.h||0);
        ctx.beginPath(); ctx.moveTo(el.x,el.y);
        if(el.type==='arrow' && Math.abs(el.bend||0)>.01){const g=this.arrowGeometry(el);ctx.quadraticCurveTo(g.cx,g.cy,ex,ey);}else ctx.lineTo(ex,ey);
        ctx.stroke();
        if (el.type === 'arrow') {
          const g=this.arrowGeometry(el), ang=Math.atan2(ey-g.cy,ex-g.cx), len=12+(el.size||4)*1.5;
          ctx.beginPath(); ctx.moveTo(ex,ey); ctx.lineTo(ex-len*Math.cos(ang-.55), ey-len*Math.sin(ang-.55)); ctx.moveTo(ex,ey); ctx.lineTo(ex-len*Math.cos(ang+.55), ey-len*Math.sin(ang+.55)); ctx.stroke();
        }
      } else if (['rect','ellipse','triangle','diamond','hexagon','star','cloud'].includes(el.type)) {
        const hasStroke = el.stroke !== 'none';
        this.geometryPath(ctx, el); this.fillCurrentPath(ctx, el); if (hasStroke) ctx.stroke();
      } else if (el.type === 'text') {
        const layout=this.measureTextLayout(el,ctx);
        ctx.fillStyle = el.color || this.currentColor; ctx.setLineDash([]); ctx.font = layout.font; ctx.textBaseline='alphabetic';ctx.textAlign='left';
        layout.rows.forEach((row,i)=>{if(row.text)ctx.fillText(row.text,el.x+row.left,el.y+i*layout.lineHeight+row.ascent);});
      } else if (el.type === 'mindnode') {
        const w=el.w||150,h=el.h||44;
        const isRoot=!el.parentId&&!el.mermaid;
        this.mindNodePath(ctx,el);
        const nodeBg=el.bgColor || (this.theme==='dark'?(isRoot?'#34302a':'#24211d'):(isRoot?'#fffdf8':'#ffffff'));
        const nodeBgOpacity=el.bgOpacity==null?1:clamp(Number(el.bgOpacity),0,1);
        ctx.save();
        ctx.fillStyle=nodeBg;
        ctx.globalAlpha*=Number.isFinite(nodeBgOpacity)?nodeBgOpacity:1;
        ctx.fill();
        ctx.restore();
        ctx.strokeStyle=el.color || (this.theme==='dark'?'#d8d3ca':'#5d5952');
        ctx.lineWidth=(isRoot?2:1.35)*(this.exporting?1:1/this.scale);
        ctx.setLineDash([]);
        ctx.stroke();
        ctx.fillStyle=el.textColor || (this.theme==='dark'?'rgba(255,255,255,.94)':'#292722');
        ctx.font=`${isRoot?600:500} ${el.fontSize||15}px ui-sans-serif,system-ui,sans-serif`;
        ctx.textBaseline='middle';
        ctx.textAlign='center';
        const pad=el.nodeShape==='diamond'?42:24;
        const lines=this.getMindNodeLines(ctx,el.text||'',Math.max(36,w-pad));
        const lh=(el.fontSize||15)*1.3;
        const startY=el.y+h/2-(lines.length-1)*lh/2;
        lines.forEach((line,i)=>ctx.fillText(line,el.x+w/2,startY+i*lh));
      } else if (el.type === 'note') {
        const w=el.w||180,h=el.h||130;
        ctx.fillStyle=el.bgColor || (this.theme==='dark'?'#6f5b20':'#fff0a6'); ctx.shadowColor='rgba(0,0,0,.12)'; ctx.shadowBlur=8; ctx.fillRect(el.x,el.y,w,h); ctx.shadowColor='transparent';
        this.drawMarkdownNote(ctx,el);
      } else if (el.type === 'image') {
        const img=this.getCachedImage(el); if (img?.complete && img.naturalWidth) ctx.drawImage(img,el.x,el.y,el.w,el.h); else { ctx.setLineDash([6,5]); ctx.strokeStyle=img?.dataset?.failed==='true'?'#ef4444':'#8b8b8b'; ctx.strokeRect(el.x,el.y,el.w,el.h); }
      }
      ctx.restore();
    }

    geometryPath(ctx, el) {
      const x=el.x,y=el.y,w=el.w,h=el.h,cx=x+w/2,cy=y+h/2;
      ctx.beginPath();
      if (el.type==='rect') ctx.rect(x,y,w,h);
      else if (el.type==='ellipse') ctx.ellipse(cx,cy,Math.abs(w/2),Math.abs(h/2),0,0,Math.PI*2);
      else if (el.type==='triangle') { ctx.moveTo(cx,y); ctx.lineTo(x+w,y+h); ctx.lineTo(x,y+h); ctx.closePath(); }
      else if (el.type==='diamond') { ctx.moveTo(cx,y); ctx.lineTo(x+w,cy); ctx.lineTo(cx,y+h); ctx.lineTo(x,cy); ctx.closePath(); }
      else if (el.type==='hexagon') { ctx.moveTo(x+w*.25,y); ctx.lineTo(x+w*.75,y); ctx.lineTo(x+w,cy); ctx.lineTo(x+w*.75,y+h); ctx.lineTo(x+w*.25,y+h); ctx.lineTo(x,cy); ctx.closePath(); }
      else if (el.type==='star') {
        const rx=Math.abs(w/2),ry=Math.abs(h/2); for(let i=0;i<10;i++){const a=-Math.PI/2+i*Math.PI/5,r=i%2?0.45:1,px=cx+Math.cos(a)*rx*r,py=cy+Math.sin(a)*ry*r;i?ctx.lineTo(px,py):ctx.moveTo(px,py);} ctx.closePath();
      } else if (el.type==='cloud') {
        const ax=Math.min(x,x+w), ay=Math.min(y,y+h), aw=Math.abs(w), ah=Math.abs(h); const X=ax,Y=ay,W=aw,H=ah;
        ctx.moveTo(X+W*.18,Y+H*.78); ctx.bezierCurveTo(X-W*.04,Y+H*.78,X-W*.04,Y+H*.45,X+W*.22,Y+H*.45); ctx.bezierCurveTo(X+W*.25,Y+H*.16,X+W*.60,Y+H*.08,X+W*.72,Y+H*.36); ctx.bezierCurveTo(X+W*1.04,Y+H*.31,X+W*1.10,Y+H*.73,X+W*.82,Y+H*.78); ctx.closePath();
      }
    }

    wrapText(ctx,text,x,y,maxWidth,lineHeight,maxHeight=Infinity){
      const paragraphs=String(text).split('\n'); let yy=y;
      for(const para of paragraphs){ const words=para.split(/\s+/); let line=''; for(const word of words){ const test=line?`${line} ${word}`:word; if(ctx.measureText(test).width>maxWidth && line){ctx.fillText(line,x,yy);yy+=lineHeight;line=word;if(yy>y+maxHeight)return;} else line=test;} ctx.fillText(line,x,yy); yy+=lineHeight; if(yy>y+maxHeight)return; }
    }


    parseMarkdownInline(text){
      const src=String(text||'');const out=[];const re=/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)]+\))/g;let i=0,m;
      while((m=re.exec(src))){if(m.index>i)out.push({text:src.slice(i,m.index)});const tok=m[0];if(tok.startsWith('**'))out.push({text:tok.slice(2,-2),bold:true});else if(tok.startsWith('`'))out.push({text:tok.slice(1,-1),code:true});else if(tok.startsWith('[')){const mm=tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);out.push({text:mm?mm[1]:tok,link:true});}else out.push({text:tok.slice(1,-1),italic:true});i=m.index+tok.length;}if(i<src.length)out.push({text:src.slice(i)});return out;
    }

    drawMarkdownNote(ctx,el){
      const w=el.w||180,h=el.h||130,base=el.fontSize||15,x=el.x+12,maxW=w-24,maxY=el.y+h-12,fg=el.color||(this.theme==='dark'?'#fff8dc':'#2b261d');let y=el.y+12;
      const drawSegments=(segments,size,weight='400',prefix='')=>{let cx=x;const lh=size*1.35;const pieces=[];if(prefix)pieces.push({text:prefix,bold:weight>='600'});pieces.push(...segments);for(const seg of pieces){const styleWeight=seg.bold?'700':weight;const style=seg.italic?'italic ':'normal ';const family=seg.code?'ui-monospace,SFMono-Regular,Menlo,monospace':'ui-sans-serif,system-ui,sans-serif';ctx.font=`${style}${styleWeight} ${size}px ${family}`;const chars=[...String(seg.text||'')];for(const ch of chars){const cw=ctx.measureText(ch).width;if(cx+cw>x+maxW&&cx>x){y+=lh;cx=x;if(y+lh>maxY)return false;}ctx.fillStyle=seg.link?'#2f6fed':fg;if(seg.code){const pad=2;ctx.save();ctx.fillStyle=this.theme==='dark'?'rgba(255,255,255,.10)':'rgba(31,31,31,.07)';ctx.fillRect(cx-pad,y-1,cw+pad*2,size+3);ctx.restore();ctx.fillStyle=fg;}ctx.fillText(ch,cx,y);cx+=cw;}}y+=lh;return y<=maxY;};
      ctx.save();ctx.textBaseline='top';ctx.textAlign='left';
      for(const raw of String(el.text||'').split('\n')){if(y>maxY)break;let line=raw,size=base,weight='400',prefix='';const hm=line.match(/^(#{1,3})\s+(.*)$/);if(hm){size=base*(hm[1].length===1?1.55:hm[1].length===2?1.3:1.12);weight='700';line=hm[2];}else{const lm=line.match(/^\s*[-*+]\s+(.*)$/);if(lm){prefix='• ';line=lm[1];}const nm=line.match(/^\s*(\d+)\.\s+(.*)$/);if(nm){prefix=`${nm[1]}. `;line=nm[2];}}
        if(!line&&!prefix){y+=base*.7;continue;}if(!drawSegments(this.parseMarkdownInline(line),size,weight,prefix))break;
      }
      ctx.restore();
    }

    getCachedImage(element) {
      const key=typeof element==='string'?element:(element?.assetId||element?.src);
      if (!key) return null;
      let img=this.imageCache.get(key);
      if (!img) {
        img=new Image();
        img.onload=()=>this.render();
        img.onerror=()=>{img.dataset.failed='true';this.render();};
        this.imageCache.set(key,img);
        if(typeof element==='object'&&element.assetId)this.store.getAssetUrl(element.assetId).then(url=>{if(url)img.src=url;else img.dataset.failed='true';}).catch(()=>{img.dataset.failed='true';});
        else img.src=typeof element==='string'?element:element.src;
      }
      return img;
    }

    // ---------- selection ----------
    getElementBBox(el) {
      if(el?.type==='mindedge')return this.getRawElementBBox(el);
      return QDVector.transformBounds(this.getRawElementBBox(el),QDVector.matrix(el));
    }

    getRawElementBBox(el) {
      if(el?.type==='path')return QDVector.pathBounds(el);
      if (!el) return null;
      if(el.type==='mindedge'){const pts=this.mindEdgeSamplePoints(el);if(!pts.length)return null;let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;for(const q of pts){minX=Math.min(minX,q.x);minY=Math.min(minY,q.y);maxX=Math.max(maxX,q.x);maxY=Math.max(maxY,q.y);}const pad=8/this.scale;return{x:minX-pad,y:minY-pad,w:Math.max(1,maxX-minX+pad*2),h:Math.max(1,maxY-minY+pad*2)};}
      if(el.type==='arrow'){const g=this.arrowGeometry(el),xs=[el.x,el.x+(el.w||0),g.cx],ys=[el.y,el.y+(el.h||0),g.cy],pad=(el.size||4)*2;return{x:Math.min(...xs)-pad,y:Math.min(...ys)-pad,w:Math.max(...xs)-Math.min(...xs)+pad*2,h:Math.max(...ys)-Math.min(...ys)+pad*2};}
      if(el.type==='line'){const x1=el.x,y1=el.y,x2=el.x+(el.w||0),y2=el.y+(el.h||0),pad=Math.max(8,(el.size||4)*1.5)/this.scale;return{x:Math.min(x1,x2)-pad,y:Math.min(y1,y2)-pad,w:Math.abs(x2-x1)+pad*2,h:Math.abs(y2-y1)+pad*2};}
      if (el.type==='draw'||el.type==='highlight') {
        if (!el.points?.length) return null;
        let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
        for(const p of el.points){minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);} const pad=(el.size||4)*2;
        return {x:minX-pad,y:minY-pad,w:Math.max(1,maxX-minX+pad*2),h:Math.max(1,maxY-minY+pad*2)};
      }
      if (el.type==='text') {
        const layout=this.measureTextLayout(el);
        el.w=layout.width;el.h=layout.height;
        return {x:el.x,y:el.y,w:layout.width,h:layout.height};
      }
      return {x:Math.min(el.x,el.x+(el.w||0)),y:Math.min(el.y,el.y+(el.h||0)),w:Math.abs(el.w||1),h:Math.abs(el.h||1)};
    }

    contentBounds() { return this.getElementsBBox(this.elements.filter(el=>this.isElementVisible(el))); }

    isElementVisible(el) {
      if(!el)return false;
      if(el.type==='mindedge'){
        const from=this.elements.find(node=>node.id===el.fromId),to=this.elements.find(node=>node.id===el.toId);
        return !!from&&!!to&&this.isElementVisible(from)&&this.isElementVisible(to);
      }
      if(el.type!=='mindnode')return true;
      const seen=new Set();let current=el;
      while(current?.parentId&&!seen.has(current.id)){seen.add(current.id);const parent=this.elements.find(node=>node.id===current.parentId&&node.type==='mindnode');if(!parent)break;if(parent.collapsed)return false;current=parent;}
      return true;
    }

    getElementsBBox(items) {
      let out=null;
      for(const el of items||[]){const b=this.getElementBBox(el);if(!b)continue;if(!out)out={...b};else{const x=Math.min(out.x,b.x),y=Math.min(out.y,b.y),r=Math.max(out.x+out.w,b.x+b.w),bt=Math.max(out.y+out.h,b.y+b.h);out={x,y,w:r-x,h:bt-y};}}
      return out;
    }

    getSelectedElements() {
      const list=(this.selectedElements||[]).filter(el=>this.elements.includes(el));
      if(list.length!==this.selectedElements.length)this.selectedElements=list;
      this.selectedElement=list[list.length-1]||null;
      return list;
    }

    expandGroupedItems(items) {
      const out=[];const seen=new Set();const queue=[...(items||[])];
      while(queue.length){
        const el=queue.shift();
        if(!el||!this.elements.includes(el)||seen.has(el.id))continue;
        seen.add(el.id);out.push(el);
        if(el.groupId)for(const peer of this.elements)if(peer.groupId===el.groupId&&!seen.has(peer.id))queue.push(peer);
      }
      return out;
    }

    setSelection(items, expandGroups=true) {
      const source=expandGroups?this.expandGroupedItems(items):items;
      const seen=new Set();
      this.selectedElements=(source||[]).filter(el=>el&&this.elements.includes(el)&&!seen.has(el.id)&&(seen.add(el.id),true));
      this.selectedElement=this.selectedElements[this.selectedElements.length-1]||null;
      if(this.cropTarget&&!this.selectedElements.includes(this.cropTarget)){this.cropTarget=null;this.cropStart=null;this.cropDrag=null;this.cropRect=null;this.container.style.cursor='';this.container.classList.remove('crop-mode');}
      if(this.watermarkTarget&&!this.selectedElements.includes(this.watermarkTarget)){this.watermarkTarget=null;this.watermarkStart=null;this.watermarkRect=null;this.container.classList.remove('watermark-mode');}
      this.updateHistoryUI();this.updateMindStyleUI?.();this.syncSizeLevelUI?.();
    }

    clearSelection() {
      if(this.cropTarget){this.cropTarget=null;this.cropStart=null;this.cropDrag=null;this.cropRect=null;this.container.style.cursor='';this.container.classList.remove('crop-mode');}
      if(this.watermarkTarget){this.watermarkTarget=null;this.watermarkStart=null;this.watermarkRect=null;this.container.classList.remove('watermark-mode');}
      this.selectedElements=[];this.selectedElement=null;this.updateHistoryUI();this.updateMindStyleUI?.();this.syncSizeLevelUI?.();
    }

    getSelectionBBox() { return this.getElementsBBox(this.getSelectedElements()); }
    pointInElement(p, el) {
      if(el?.type==='mindedge')return this.pointNearMindEdge(p,el,9/this.scale);
      return this.pointInRawElement(QDVector.point(QDVector.inverse(QDVector.matrix(el)),p),el);
    }
    pointInRawElement(p, el) {
      if(el?.type==='path')return this.pointInVectorPath(p,el);
      if(el?.type==='arrow')return this.pointNearArrow(p,el,10/this.scale);
      if(el?.type==='line')return QDCore.pointSegmentDistance(p,{x:el.x,y:el.y},{x:el.x+(el.w||0),y:el.y+(el.h||0)})<=Math.max(8,(el.size||4)*1.5)/this.scale;
      if(el?.type==='draw'||el?.type==='highlight'){
        const points=el.points||[],tolerance=Math.max(8,(el.type==='highlight'?(el.size||4)*4:(el.size||4)*1.5))/this.scale;
        if(el.type==='draw'&&el.fill&&el.fill!=='none'&&this.isClosedFreehand(el)){this.ctx.save();this.ctx.setTransform(1,0,0,1,0,0);this.traceFreehandPath(this.ctx,el,true);const inside=this.ctx.isPointInPath(p.x,p.y);this.ctx.restore();if(inside)return true;}
        if(points.length===1)return Math.hypot(p.x-points[0].x,p.y-points[0].y)<=tolerance;
        for(let i=1;i<points.length;i++)if(QDCore.pointSegmentDistance(p,points[i-1],points[i])<=tolerance)return true;
        return false;
      }
      if(['ellipse','triangle','diamond','hexagon','star','cloud'].includes(el?.type)){
        this.ctx.save();this.ctx.setTransform(1,0,0,1,0,0);this.geometryPath(this.ctx,el);if(this.ctx.isPointInPath(p.x,p.y)){this.ctx.restore();return true;}
        if(this.ctx.isPointInStroke){this.ctx.lineWidth=Math.max(10,(el.size||4)*2)/this.scale;const hit=this.ctx.isPointInStroke(p.x,p.y);this.ctx.restore();return hit;}this.ctx.restore();
      }
      const b=this.getRawElementBBox(el); return !!b && p.x>=b.x-8/this.scale&&p.x<=b.x+b.w+8/this.scale&&p.y>=b.y-8/this.scale&&p.y<=b.y+b.h+8/this.scale;
    }
    rectFromPoints(a,b) { return {x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),w:Math.abs(b.x-a.x),h:Math.abs(b.y-a.y)}; }
    rectIntersects(a,b) { return a.x<=b.x+b.w && a.x+a.w>=b.x && a.y<=b.y+b.h && a.y+a.h>=b.y; }
    selectInRect(rect) { return this.elements.filter(el=>this.isElementVisible(el)&&(()=>{const b=this.getElementBBox(el);return b&&this.rectIntersects(rect,b);})()); }

    selectionHandlesForBBox(b) {
      if(!b)return [];
      return [['nw',b.x,b.y],['n',b.x+b.w/2,b.y],['ne',b.x+b.w,b.y],['e',b.x+b.w,b.y+b.h/2],['se',b.x+b.w,b.y+b.h],['s',b.x+b.w/2,b.y+b.h],['sw',b.x,b.y+b.h],['w',b.x,b.y+b.h/2]].map(([name,x,y])=>({name,x,y}));
    }

    hitHandle(p) {
      const items=this.getSelectedElements();if(items.length===1&&['mindedge','arrow'].includes(items[0].type))return null;
      const r=8/this.scale; for(const h of this.selectionFrameHandles()) if(Math.hypot(p.x-h.x,p.y-h.y)<=r)return h.name; return null;
    }

    drawCurrentSelection(ctx) {
      const items=this.getSelectedElements(); if(!items.length)return;
      if(items.length===1){
        const el=items[0];
        if(el.type==='mindedge'){this.drawMindEdge(ctx,el,true);return;}
        if(el.type==='arrow'){ctx.save();if(el.transform)ctx.transform(...el.transform);this.drawArrowSelection(ctx,el);ctx.restore();this.drawSelectionFrame(ctx,this.getSelectionFrame([el]),false);return;}
        this.drawSelectionFrame(ctx,this.getSelectionFrame([el]),true);
        if(el.type==='mindnode')this.drawMindAnchors(ctx,el);
        return;
      }
      for(const el of items){if(el.type==='mindedge')this.drawMindEdge(ctx,el,true);else this.drawSelectionFrame(ctx,this.getSelectionFrame([el]),false,.35);}
      this.drawSelectionFrame(ctx,this.getSelectionFrame(),true,1);
    }

    drawMarquee(ctx,rect) {
      ctx.save();const c=getComputedStyle(this.app).getPropertyValue('--sel').trim()||'#2f6fed';ctx.strokeStyle=c;ctx.fillStyle=c;ctx.globalAlpha=.11;ctx.fillRect(rect.x,rect.y,rect.w,rect.h);ctx.globalAlpha=.9;ctx.lineWidth=1.2/this.scale;ctx.setLineDash([6/this.scale,4/this.scale]);ctx.strokeRect(rect.x,rect.y,rect.w,rect.h);ctx.restore();
    }

    drawCropOverlay(ctx){
      const image=this.cropTarget;if(!image||!this.elements.includes(image))return;const bounds=this.getRawElementBBox(image),crop=this.cropRect;
      ctx.save();if(image.transform)ctx.transform(...image.transform);ctx.fillStyle='rgba(15,18,24,.34)';
      if(crop&&crop.w>0&&crop.h>0){const right=bounds.x+bounds.w,bottom=bounds.y+bounds.h,cropRight=crop.x+crop.w,cropBottom=crop.y+crop.h;ctx.fillRect(bounds.x,bounds.y,bounds.w,Math.max(0,crop.y-bounds.y));ctx.fillRect(bounds.x,cropBottom,bounds.w,Math.max(0,bottom-cropBottom));ctx.fillRect(bounds.x,crop.y,Math.max(0,crop.x-bounds.x),crop.h);ctx.fillRect(cropRight,crop.y,Math.max(0,right-cropRight),crop.h);const color=getComputedStyle(this.app).getPropertyValue('--sel').trim()||'#2f6fed';ctx.strokeStyle='#fff';ctx.lineWidth=3/this.scale;ctx.strokeRect(crop.x,crop.y,crop.w,crop.h);ctx.strokeStyle=color;ctx.lineWidth=1.4/this.scale;ctx.strokeRect(crop.x,crop.y,crop.w,crop.h);ctx.globalAlpha=.48;ctx.strokeStyle='#fff';ctx.lineWidth=.8/this.scale;for(const ratio of [1/3,2/3]){ctx.beginPath();ctx.moveTo(crop.x+crop.w*ratio,crop.y);ctx.lineTo(crop.x+crop.w*ratio,cropBottom);ctx.moveTo(crop.x,crop.y+crop.h*ratio);ctx.lineTo(cropRight,crop.y+crop.h*ratio);ctx.stroke();}}
      else{ctx.globalAlpha=.15;ctx.fillRect(bounds.x,bounds.y,bounds.w,bounds.h);}
      ctx.restore();
      if(crop&&crop.w>0&&crop.h>0){ctx.save();ctx.fillStyle='#fff';ctx.strokeStyle='#2f6fed';ctx.lineWidth=1/this.scale;const size=7/this.scale;for(const h of this.cropHandles()){ctx.fillRect(h.x-size/2,h.y-size/2,size,size);ctx.strokeRect(h.x-size/2,h.y-size/2,size,size);}ctx.restore();}
    }

    drawWatermarkOverlay(ctx){
      const image=this.watermarkTarget;if(!image||!this.elements.includes(image))return;const bounds=this.getRawElementBBox(image),region=this.watermarkRect;
      ctx.save();if(image.transform)ctx.transform(...image.transform);ctx.fillStyle='rgba(239,51,56,.12)';ctx.strokeStyle='#ef3338';ctx.lineWidth=1.5/this.scale;ctx.setLineDash([6/this.scale,4/this.scale]);
      if(region&&region.w>0&&region.h>0){ctx.fillRect(region.x,region.y,region.w,region.h);ctx.strokeRect(region.x,region.y,region.w,region.h);}
      else{ctx.globalAlpha=.75;ctx.strokeRect(bounds.x,bounds.y,bounds.w,bounds.h);}
      ctx.restore();
    }

    rebuildSpatialIndex(){this.spatialIndex.clear();const cell=256;for(const el of this.elements){if(!this.isElementVisible(el))continue;const b=this.getElementBBox(el);if(!b)continue;const x0=Math.floor(b.x/cell),x1=Math.floor((b.x+b.w)/cell),y0=Math.floor(b.y/cell),y1=Math.floor((b.y+b.h)/cell);for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){const key=`${x}:${y}`;if(!this.spatialIndex.has(key))this.spatialIndex.set(key,[]);this.spatialIndex.get(key).push(el);}}this.spatialDirty=false;}
    selectAt(p) { if(this.spatialDirty)this.rebuildSpatialIndex();const candidates=this.spatialIndex.get(`${Math.floor(p.x/256)}:${Math.floor(p.y/256)}`)||[];return [...candidates].reverse().find(el=>this.pointInElement(p,el))||null; }
    moveElement(el,dx,dy) { if(el.type==='mindedge')return;if(el.transform||el.type==='path'){el.transform=QDVector.multiply([1,0,0,1,dx,dy],QDVector.matrix(el));return;}if(el.points) for(const p of el.points){p.x+=dx;p.y+=dy;} else {el.x+=dx;el.y+=dy;} }
    moveSelected(dx,dy) { for(const el of this.getSelectedElements())this.moveElement(el,dx,dy); }

    alignmentAnchors(box) { return {left:box.x,center:box.x+box.w/2,right:box.x+box.w,top:box.y,middle:box.y+box.h/2,bottom:box.y+box.h}; }

    calculateGridDrag(origins,dx,dy) {
      const originalBox=this.getElementsBBox(origins);if(!originalBox||!this.snapToGrid)return{dx,dy};
      const proposedX=originalBox.x+dx,proposedY=originalBox.y+dy,gridX=Math.round(proposedX/24)*24,gridY=Math.round(proposedY/24)*24,threshold=4/this.scale,deltaX=gridX-proposedX,deltaY=gridY-proposedY;
      return{dx:Math.abs(deltaX)<=threshold?dx+deltaX:dx,dy:Math.abs(deltaY)<=threshold?dy+deltaY:dy};
    }

    snapWorldPoint(p){return this.snapToGrid?{...p,x:Math.round(p.x/24)*24,y:Math.round(p.y/24)*24}:p;}

    alignSelected(mode){
      const items=this.getSelectedElements().filter(el=>el.type!=='mindedge');if(items.length<2){this.toast('至少选择两个对象才能对齐。');return;}const outer=this.getElementsBBox(items),target=this.alignmentAnchors(outer);
      for(const el of items){const box=this.getElementBBox(el),a=this.alignmentAnchors(box);let dx=0,dy=0;if(mode==='left')dx=target.left-a.left;if(mode==='right')dx=target.right-a.right;if(mode==='hcenter')dx=target.center-a.center;if(mode==='top')dy=target.top-a.top;if(mode==='bottom')dy=target.bottom-a.bottom;if(mode==='vcenter')dy=target.middle-a.middle;this.moveElement(el,dx,dy);}this.commit();this.render();
    }

    distributeSelected(axis){
      const items=this.getSelectedElements().filter(el=>el.type!=='mindedge');if(items.length<3){this.toast('至少选择三个对象才能等间距分布。');return;}const data=items.map(el=>({el,box:this.getElementBBox(el)})).sort((a,b)=>axis==='x'?a.box.x-b.box.x:a.box.y-b.box.y);const first=data[0].box,last=data.at(-1).box,total=data.reduce((sum,item)=>sum+(axis==='x'?item.box.w:item.box.h),0),span=axis==='x'?last.x+last.w-first.x:last.y+last.h-first.y,gap=(span-total)/(data.length-1);let cursor=axis==='x'?first.x:first.y;for(const item of data){const current=axis==='x'?item.box.x:item.box.y;this.moveElement(item.el,axis==='x'?cursor-current:0,axis==='y'?cursor-current:0);cursor+=(axis==='x'?item.box.w:item.box.h)+gap;}this.commit();this.render();
    }

    resizeSelection(handle,p,keepAspect=false) {
      const st=this.resizeStart;if(!st?.bbox)return;
      if(st.frame)p=QDVector.point(QDVector.inverse(st.frame.matrix),p);
      const ob=st.bbox;let left=ob.x,top=ob.y,right=ob.x+ob.w,bottom=ob.y+ob.h;
      if(handle.includes('w'))left=p.x;if(handle.includes('e'))right=p.x;if(handle.includes('n'))top=p.y;if(handle.includes('s'))bottom=p.y;
      if(handle==='n'||handle==='s'){left=ob.x;right=ob.x+ob.w;}if(handle==='e'||handle==='w'){top=ob.y;bottom=ob.y+ob.h;}
      if(keepAspect&&ob.w>0&&ob.h>0){
        const aspect=ob.w/ob.h,cx=ob.x+ob.w/2,cy=ob.y+ob.h/2;
        if(handle.length===2){const anchorX=handle.includes('w')?ob.x+ob.w:ob.x,anchorY=handle.includes('n')?ob.y+ob.h:ob.y;let width=Math.max(2/this.scale,Math.abs(p.x-anchorX)),height=Math.max(2/this.scale,Math.abs(p.y-anchorY));if(width/ob.w>=height/ob.h)height=width/aspect;else width=height*aspect;if(handle.includes('w')){left=anchorX-width;right=anchorX;}else{left=anchorX;right=anchorX+width;}if(handle.includes('n')){top=anchorY-height;bottom=anchorY;}else{top=anchorY;bottom=anchorY+height;}}
        else if(handle==='e'||handle==='w'){const width=Math.max(2/this.scale,Math.abs((handle==='e'?right:left)-(handle==='e'?ob.x:ob.x+ob.w))),height=width/aspect;top=cy-height/2;bottom=cy+height/2;if(handle==='e'){left=ob.x;right=ob.x+width;}else{left=ob.x+ob.w-width;right=ob.x+ob.w;}}
        else{const height=Math.max(2/this.scale,Math.abs((handle==='s'?bottom:top)-(handle==='s'?ob.y:ob.y+ob.h))),width=height*aspect;left=cx-width/2;right=cx+width/2;if(handle==='s'){top=ob.y;bottom=ob.y+height;}else{top=ob.y+ob.h-height;bottom=ob.y+ob.h;}}
      }
      const nb={x:Math.min(left,right),y:Math.min(top,bottom),w:Math.max(2/this.scale,Math.abs(right-left)),h:Math.max(2/this.scale,Math.abs(bottom-top))};
      const sx=nb.w/Math.max(1e-6,ob.w),sy=nb.h/Math.max(1e-6,ob.h),strokeScale=Math.sqrt(Math.abs(sx*sy));const tx=(x,y)=>({x:nb.x+(x-ob.x)*sx,y:nb.y+(y-ob.y)*sy});
      for(const src of st.elements){
        const el=this.elements.find(e=>e.id===src.id);if(!el)continue;
        if(st.frame){if(src.type==='mindedge'&&st.elements.some(node=>node.id===src.fromId||node.id===src.toId))continue;const local=[sx,0,0,sy,nb.x-ob.x*sx,nb.y-ob.y*sy],world=QDVector.multiply(st.frame.matrix,QDVector.multiply(local,QDVector.inverse(st.frame.matrix)));el.transform=QDVector.multiply(world,QDVector.matrix(src));continue;}
        if(src.transform||src.type==='path'){el.transform=QDVector.multiply([sx,0,0,sy,nb.x-ob.x*sx,nb.y-ob.y*sy],QDVector.matrix(src));continue;}
        if(['draw','highlight','line','arrow','rect','ellipse','triangle','diamond','hexagon','star','cloud'].includes(src.type))el.size=Math.max(.1,(src.size||4)*strokeScale);
        if(src.points){el.points=src.points.map(q=>({...q,...tx(q.x,q.y)}));continue;}
        const a=tx(src.x||0,src.y||0),z=tx((src.x||0)+(src.w||0),(src.y||0)+(src.h||0));el.x=a.x;el.y=a.y;
        if(src.type==='text'){
          el.fontSize=clamp((src.fontSize||18)*Math.sqrt(Math.abs(sx*sy)),10,96);
          this.updateTextMetrics(el);
        }else{el.w=z.x-a.x;el.h=z.y-a.y;}
      }
    }

    cloneElements(items) {
      const source=[...(items||[])],sourceIds=new Set(source.map(el=>el.id));
      for(const edge of this.elements.filter(el=>el.type==='mindedge'))if(!sourceIds.has(edge.id)&&((sourceIds.has(edge.fromId)&&sourceIds.has(edge.toId))||(sourceIds.has(edge.toId)&&this.elements.find(node=>node.id===edge.toId)?.parentId===edge.fromId))){source.push(edge);sourceIds.add(edge.id);}
      const idMap=new Map(source.map(src=>[src.id,newId()]));
      const groupMap=new Map();
      return source.map(src=>{
        const dup=clone(src);dup.id=idMap.get(src.id);
        if(src.groupId){if(!groupMap.has(src.groupId))groupMap.set(src.groupId,`g${newId()}`);dup.groupId=groupMap.get(src.groupId);}
        if(src.parentId&&idMap.has(src.parentId))dup.parentId=idMap.get(src.parentId);
        if(src.fromId&&idMap.has(src.fromId))dup.fromId=idMap.get(src.fromId);
        if(src.toId&&idMap.has(src.toId))dup.toId=idMap.get(src.toId);
        return dup;
      });
    }

    duplicateSelected() {
      const items=this.getSelectedElements();if(!items.length)return;const d=18/this.scale,dups=this.cloneElements(items);for(const dup of dups)this.moveElement(dup,d,d);this.elements.push(...dups);this.setSelection(dups);this.commit();this.render();
    }

    cloneSelectionForDrag() {
      const items=this.getSelectedElements();if(!items.length)return;
      const dups=this.cloneElements(items);
      this.elements.push(...dups);
      this.setSelection(dups);
      this.dragOrigin=dups.map(clone);
      this.altDuplicatePending=false;
    }

    groupSelected() {
      const items=this.getSelectedElements();
      if(items.length<2){this.toast('至少选择两个对象才能打组。');return;}
      const groupId=`g${newId()}`;for(const el of items)el.groupId=groupId;
      this.setSelection(items);this.commit();this.render();this.toast('已打组 · Ctrl/⌘+Shift+G 可取消分组');
    }

    ungroupSelected() {
      const groupIds=new Set(this.getSelectedElements().map(el=>el.groupId).filter(Boolean));
      if(!groupIds.size){this.toast('所选对象没有分组。');return;}
      const affected=this.elements.filter(el=>groupIds.has(el.groupId));
      for(const el of affected)delete el.groupId;
      this.setSelection(affected,false);this.commit();this.render();
    }

    deleteSelected() {
      const selected=this.getSelectedElements(),ids=new Set(selected.map(e=>e.id));if(!ids.size)return;
      for(const edge of selected.filter(e=>e.type==='mindedge')){const child=this.elements.find(e=>e.id===edge.toId&&e.type==='mindnode');if(child?.parentId===edge.fromId)child.parentId=null;}
      let grew=true;while(grew){grew=false;for(const el of this.elements){if(el.type==='mindnode'&&el.parentId&&ids.has(el.parentId)&&!ids.has(el.id)){ids.add(el.id);grew=true;}}}
      const nodeIds=new Set(this.elements.filter(e=>e.type==='mindnode'&&ids.has(e.id)).map(e=>e.id));
      this.elements=this.elements.filter(e=>!ids.has(e.id)&&!(e.type==='mindedge'&&(nodeIds.has(e.fromId)||nodeIds.has(e.toId))));this.clearSelection();this.commit();this.render();
    }

    moveSelectedLayer(direction,toEdge=false) {
      const selected=new Set(this.getSelectedElements().map(el=>el.id));
      if(!selected.size)return;
      if(toEdge){
        const moving=this.elements.filter(el=>selected.has(el.id)),rest=this.elements.filter(el=>!selected.has(el.id)),next=direction>0?[...rest,...moving]:[...moving,...rest];
        if(next.some((el,i)=>el!==this.elements[i])){this.elements=next;this.commit();this.render();}return;
      }
      let changed=false;
      if(direction>0){
        // Walk from front to back so a selected group moves forward exactly one
        // unselected slot while keeping the selected elements' relative order.
        for(let i=this.elements.length-2;i>=0;i--){
          if(selected.has(this.elements[i].id)&&!selected.has(this.elements[i+1].id)){
            [this.elements[i],this.elements[i+1]]=[this.elements[i+1],this.elements[i]];
            changed=true;
          }
        }
      }else{
        for(let i=1;i<this.elements.length;i++){
          if(selected.has(this.elements[i].id)&&!selected.has(this.elements[i-1].id)){
            [this.elements[i-1],this.elements[i]]=[this.elements[i],this.elements[i-1]];
            changed=true;
          }
        }
      }
      if(changed){this.commit();this.render();}
    }

    // ---------- interaction ----------
    setupEvents() {
      window.addEventListener('resize',()=>this.resizeCanvas());
      document.addEventListener('pointerdown',event=>{
        if(event.button!==0||!this.isTextEditingTarget(event.target))return;
        // A side panel may retain an activeElement while browser chrome owns
        // keyboard focus. Reclaim its window only during a direct input click.
        this.focusTextInput(event.target.closest('input,textarea,[contenteditable],[role="textbox"]'));
      },true);
      this.container.addEventListener('pointerdown',e=>this.onPointerDown(e),{passive:false});
      this.container.addEventListener('pointermove',e=>this.onPointerMove(e),{passive:false});
      window.addEventListener('pointerup',e=>this.onPointerUp(e));
      window.addEventListener('pointercancel',e=>this.onPointerUp(e));
      this.container.addEventListener('lostpointercapture',e=>{if(this.isPanning&&e.pointerId===this.panPointerId)this.finishPan(e.pointerId);});
      this.container.addEventListener('mousedown',e=>{if(e.button===1)e.preventDefault();},{passive:false});
      this.container.addEventListener('wheel',e=>{e.preventDefault();this.zoom(e.deltaY<0?1.10:.90,e.clientX,e.clientY);},{passive:false});
      this.container.addEventListener('auxclick',e=>{if(e.button===1)e.preventDefault();});
      this.container.addEventListener('contextmenu',e=>this.onContextMenu(e));
      this.container.addEventListener('dblclick',e=>{ const p=this.eventPos(e);if(this.cropTarget){e.preventDefault();const q=this.imageLocalPoint(this.cropTarget,p),r=this.cropRect;if(r&&r.w>0&&r.h>0&&q.x>=r.x&&q.x<=r.x+r.w&&q.y>=r.y&&q.y<=r.y+r.h)this.applyImageCrop({...r});return;}const hit=this.selectAt(p);if(!hit)return;if(['text','note','mindnode'].includes(hit.type)){this.setSelection([hit]);this.editTextElement(hit);} });

      window.addEventListener('keydown',e=>this.onKeyDown(e));
      window.addEventListener('keyup',e=>{if(e.code==='Space')this.spaceDown=false;});
    }

    finishPan(pointerId=null) {
      if(pointerId!=null&&this.panPointerId!=null&&pointerId!==this.panPointerId)return;
      const captured=this.panPointerId;
      this.isPanning=false;this.pointerDown=false;this.panPointerId=null;
      this.container.classList.remove('dragging');
      if(captured!=null){try{if(this.container.hasPointerCapture?.(captured))this.container.releasePointerCapture(captured);}catch{}}
      this.scheduleSave();
    }

    captureInteractionPointer(pointerId){this.interactionPointerId=pointerId;try{this.container.setPointerCapture?.(pointerId);}catch{}}
    releaseInteractionPointer(pointerId=null){const captured=this.interactionPointerId;if(pointerId!=null&&captured!=null&&pointerId!==captured)return;this.interactionPointerId=null;try{if(captured!=null&&this.container.hasPointerCapture?.(captured))this.container.releasePointerCapture(captured);}catch{}}

    onPointerDown(e) {
      if(this.editingPointerDown(e))return;
      if(e.button!==0&&e.button!==1)return;this.container.focus({preventScroll:true});const p=this.eventPos(e);this.pointerDown=true;
      if(e.button===1||this.currentTool==='hand'||this.spaceDown){e.preventDefault();this.isPanning=true;this.panPointerId=e.pointerId;this.panStart={x:e.clientX-this.offsetX,y:e.clientY-this.offsetY};this.container.classList.add('dragging');try{this.container.setPointerCapture?.(e.pointerId);}catch{}return;}
      if(this.watermarkTarget){const bounds=this.getRawElementBBox(this.watermarkTarget),p=this.imageLocalPoint(this.watermarkTarget,this.eventPos(e));if(p.x<bounds.x||p.x>bounds.x+bounds.w||p.y<bounds.y||p.y>bounds.y+bounds.h){this.pointerDown=false;this.toast('请在图片内部框选水印区域。');return;}this.captureInteractionPointer(e.pointerId);this.watermarkStart={x:clamp(p.x,bounds.x,bounds.x+bounds.w),y:clamp(p.y,bounds.y,bounds.y+bounds.h)};this.watermarkRect={x:this.watermarkStart.x,y:this.watermarkStart.y,w:0,h:0};this.render();return;}
      if(this.cropTarget){this.beginCropDrag(e);return;}
      if(this.currentTool==='select'){
        const mindAnchor=this.hitMindAnchor(p);if(mindAnchor){this.startMindLink(mindAnchor.node,mindAnchor.side,p);return;}
        const arrowControl=this.hitArrowControl(p);if(arrowControl){const el=arrowControl.el,g=this.arrowGeometry(el);if(arrowControl.kind==='curve')this.arrowCurveDrag={id:el.id};else this.arrowPointDrag={id:el.id,kind:arrowControl.kind,fixed:arrowControl.kind==='start'?{x:g.ex,y:g.ey}:{x:g.sx,y:g.sy}};return;}
        const handle=this.hitHandle(p);if(handle){this.captureInteractionPointer(e.pointerId);this.isResizing=true;this.resizeHandle=handle;const frame=this.getSelectionFrame();this.resizeStart={bbox:frame.box,frame,elements:this.getSelectedElements().map(clone)};return;}
        const hit=this.selectAt(p);
        if(hit){
          const selected=this.getSelectedElements();const hitSet=this.expandGroupedItems([hit]);
          if(e.shiftKey){const hitIds=new Set(hitSet.map(x=>x.id));const allSelected=hitSet.every(x=>selected.includes(x));const next=allSelected?selected.filter(x=>!hitIds.has(x.id)):[...selected,...hitSet];this.setSelection(next,false);this.pointerDown=false;this.render();return;}
          if(!selected.includes(hit))this.setSelection([hit]);
          this.captureInteractionPointer(e.pointerId);this.isDragging=true;this.dragStart={x:p.x,y:p.y};this.dragOrigin=this.getSelectedElements().map(clone);this.altDuplicatePending=!!e.altKey;this.dragHasMoved=false;this.render();return;
        }
        this.marqueeBase=e.shiftKey?[...this.getSelectedElements()]:[];if(!e.shiftKey)this.clearSelection();this.isMarqueeSelecting=true;this.marqueeAdditive=e.shiftKey;this.marqueeStart={x:p.x,y:p.y};this.marqueeRect={x:p.x,y:p.y,w:0,h:0};this.render();return;
      }
      if(this.currentTool==='mindmap'){
        const mindAnchor=this.hitMindAnchor(p);if(mindAnchor){this.startMindLink(mindAnchor.node,mindAnchor.side,p);return;}
        const hit=this.selectAt(p);
        if(hit?.type==='mindnode'){this.setSelection([hit]);this.pointerDown=false;this.render();return;}
        const q=this.snapWorldPoint(p),node=this.createMindNode(q.x,q.y,null);this.pointerDown=false;this.editMindNode(node,true);return;
      }
      if(this.currentTool==='eraser'){this.eraserChanged=false;this.eraseAt(p);return;}
      if(this.currentTool==='text'){const q=this.snapWorldPoint(p);this.createTextEditor(q.x,q.y,false);this.pointerDown=false;return;}
      if(this.currentTool==='note'){const q=this.snapWorldPoint(p);this.createTextEditor(q.x,q.y,true);this.pointerDown=false;return;}
      const base={id:newId(),color:this.currentColor,size:this.currentSize,dash:this.currentDash,fill:this.currentFill,stroke:this.currentStroke},q=['draw','highlight'].includes(this.currentTool)?p:this.snapWorldPoint(p);
      if(this.currentTool==='draw')this.currentElement={...base,type:'draw',points:[{x:q.x,y:q.y,pressure:e.pressure||.5}]};
      else if(this.currentTool==='highlight')this.currentElement={...base,type:'highlight',points:[{x:q.x,y:q.y}]};
      else if(this.currentTool==='geo')this.currentElement={...base,type:this.currentShape,x:q.x,y:q.y,w:0,h:0};else this.currentElement={...base,type:this.currentTool,x:q.x,y:q.y,w:0,h:0,...(this.currentTool==='arrow'?{bend:0}:{})};
    }

    onPointerMove(e) {
      if(this.editingPointerMove(e))return;
      const p=this.eventPos(e);
      if(this.watermarkTarget&&this.watermarkStart){const bounds=this.getRawElementBBox(this.watermarkTarget),p=this.imageLocalPoint(this.watermarkTarget,this.eventPos(e)),end={x:clamp(p.x,bounds.x,bounds.x+bounds.w),y:clamp(p.y,bounds.y,bounds.y+bounds.h)};this.watermarkRect=this.rectFromPoints(this.watermarkStart,end);this.render();return;}
      if(this.cropTarget&&!this.isPanning){this.moveCropDrag(e);return;}
      if(this.mindLinkDraft){this.mindLinkDraft.to={x:p.x,y:p.y};this.render();return;}
      if(this.arrowPointDrag){const d=this.arrowPointDrag,el=this.elements.find(x=>x.id===d.id);if(el){const q=this.snapWorldPoint(this.imageLocalPoint(el,p));if(d.kind==='start'){el.x=q.x;el.y=q.y;el.w=d.fixed.x-q.x;el.h=d.fixed.y-q.y;}else{el.w=q.x-el.x;el.h=q.y-el.y;}this.render();}return;}
      if(this.arrowCurveDrag){const el=this.elements.find(x=>x.id===this.arrowCurveDrag.id);if(el){const q=this.imageLocalPoint(el,p),mx=el.x+(el.w||0)/2,my=el.y+(el.h||0)/2,dx=el.w||0,dy=el.h||0,len=Math.hypot(dx,dy)||1,nx=-dy/len,ny=dx/len;el.bend=2*((q.x-mx)*nx+(q.y-my)*ny);this.render();}return;}
      if(this.isPanning){if(this.panPointerId!=null&&e.pointerId!==this.panPointerId)return;if(e.pointerType==='mouse'&&(e.buttons&4)===0&&this.currentTool!=='hand'&&!this.spaceDown){this.finishPan(e.pointerId);return;}e.preventDefault();this.offsetX=e.clientX-this.panStart.x;this.offsetY=e.clientY-this.panStart.y;this.updateZoomUI();this.render();return;}if(!this.pointerDown)return;
      if(this.currentTool==='select'&&this.isDragging&&this.getSelectedElements().length){
        let dx=p.x-this.dragStart.x,dy=p.y-this.dragStart.y;
        if(!this.dragHasMoved&&Math.hypot(dx,dy)>1/this.scale){if(this.altDuplicatePending)this.cloneSelectionForDrag();this.dragHasMoved=true;}
        if(this.dragHasMoved){
          const selected=this.getSelectedElements();const origins=this.dragOrigin||selected.map(clone),snapped=this.calculateGridDrag(origins,dx,dy);dx=snapped.dx;dy=snapped.dy;
          // A first drag may create a transform absent from the starting snapshot.
          // Remove it before restoring, so every frame uses the same starting position.
          for(let i=0;i<selected.length;i++){const el=selected[i],src=origins[i];if(!src)continue;delete el.transform;Object.assign(el,clone(src));this.moveElement(el,dx,dy);}
          this.render();
        }
        return;
      }
      if(this.currentTool==='select'&&this.isResizing&&this.getSelectedElements().length){this.resizeSelection(this.resizeHandle,this.snapWorldPoint(p),e.shiftKey);this.render();return;}
      if(this.currentTool==='select'&&this.isMarqueeSelecting){this.marqueeRect=this.rectFromPoints(this.marqueeStart,p);this.render();return;}
      if(this.currentTool==='eraser'){this.eraseAt(p);return;}if(!this.currentElement)return;
      if(this.currentElement.points){const pts=this.currentElement.points,last=pts[pts.length-1];if(!last||Math.hypot(p.x-last.x,p.y-last.y)>1/this.scale){const point={x:p.x,y:p.y};if(this.currentElement.type==='draw')point.pressure=e.pressure||.5;pts.push(point);}}else{const q=this.snapWorldPoint(p);this.currentElement.w=q.x-this.currentElement.x;this.currentElement.h=q.y-this.currentElement.y;}this.render();
    }

    onPointerUp(e) {
      if(this.editingPointerUp(e))return;
      if(!this.isPanning)this.releaseInteractionPointer(e?.pointerId);
      if(this.watermarkTarget&&this.watermarkStart){const rect=this.watermarkRect;this.watermarkStart=null;this.pointerDown=false;if(e?.type==='pointercancel'){this.watermarkRect=null;this.render();return;}if(rect&&rect.w>=8/this.scale&&rect.h>=8/this.scale)this.applyWatermarkRemoval(rect);else{this.watermarkRect=null;this.toast('水印区域太小，请重新框选。');this.render();}return;}
      if(this.cropTarget&&this.cropDrag){this.endCropDrag(e);return;}
      if(this.mindLinkDraft){const p=e?this.eventPos(e):this.mindLinkDraft.to;this.finishMindLink(p);this.pointerDown=false;return;}
      if(this.arrowPointDrag){this.arrowPointDrag=null;this.pointerDown=false;this.commit();this.render();return;}
      if(this.arrowCurveDrag){this.arrowCurveDrag=null;this.pointerDown=false;this.commit();this.render();return;}
      if(this.isPanning){this.finishPan(e?.pointerId);return;}
      if(this.currentTool==='select'&&this.isMarqueeSelecting){const rect=this.marqueeRect,moved=rect&&(rect.w>3/this.scale||rect.h>3/this.scale);if(moved){const hits=this.selectInRect(rect),merged=this.marqueeAdditive?[...this.marqueeBase,...hits]:hits;this.setSelection(merged);}else if(!this.marqueeAdditive)this.clearSelection();this.isMarqueeSelecting=false;this.marqueeStart=null;this.marqueeRect=null;this.marqueeBase=[];this.pointerDown=false;this.render();return;}
      if(this.currentTool==='select'&&(this.isDragging||this.isResizing)){this.isDragging=false;this.isResizing=false;this.resizeHandle=null;this.resizeStart=null;this.dragOrigin=null;this.altDuplicatePending=false;this.dragHasMoved=false;this.pointerDown=false;this.commit();this.render();return;}
      if(this.currentTool==='eraser'){this.pointerDown=false;if(this.eraserChanged)this.commit();return;}
      if(this.currentElement){const created=this.currentElement;const tool=this.currentTool;const b=this.getElementBBox(created);const valid=(created.points?.length>1)||(!created.points&&b&&(b.w>1||b.h>1));this.currentElement=null;if(valid){this.elements.push(created);const oneShot=['line','arrow','geo'].includes(tool);if(oneShot){this.setSelection([created]);this.commit();this.setTool('select');}else{this.clearSelection();this.commit();this.render();}}else this.render();}this.pointerDown=false;
    }

    eraseAt(p) {
      const ids=new Set(this.elements.filter(el=>this.pointInElement(p,el)).map(el=>el.id));
      let grew=true;while(grew){grew=false;for(const el of this.elements)if(el.type==='mindnode'&&el.parentId&&ids.has(el.parentId)&&!ids.has(el.id)){ids.add(el.id);grew=true;}}
      if(!ids.size)return;
      this.elements=this.elements.filter(el=>!ids.has(el.id)&&!(el.type==='mindedge'&&(ids.has(el.fromId)||ids.has(el.toId))));this.eraserChanged=true;this.spatialDirty=true;this.setSelection(this.getSelectedElements().filter(el=>this.elements.includes(el)));this.render();
    }

    isTextEditingTarget(target){
      return !!(target?.isContentEditable||target?.closest?.('input,textarea,select,[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"],[role="textbox"]'));
    }

    focusTextInput(input){
      if(!input||input.disabled||!input.isConnected||!input.getClientRects().length)return;
      if(!document.hasFocus())window.focus();
      if(document.activeElement!==input)input.focus({preventScroll:true});
    }

    onKeyDown(e) {
      if(this.isTextEditingTarget(e.target)||e.isComposing)return;const mod=e.ctrlKey||e.metaKey,key=e.key.toLowerCase();
      if(this.editingKeyDown(e))return;
      if(this.watermarkTarget){if(key==='escape'){e.preventDefault();this.cancelWatermarkRemoval(true);}return;}
      if(this.cropTarget){if(key==='escape'){e.preventDefault();this.cancelImageCrop(true);}return;}
      if(mod&&key==='c'){e.preventDefault();const selected=this.getSelectedElements();if(selected.length)this.copyPNG(selected);else this.toast('请先选择要复制的对象。');return;}
      if(e.altKey&&!mod&&['t','l','r','b'].includes(key)){e.preventDefault();this.alignSelected(({t:'top',l:'left',r:'right',b:'bottom'})[key]);return;}
      if(mod&&key==='f'){e.preventDefault();this.openSearchDialog();return;}
      if(!$('#storage-dialog').hidden&&key==='escape'){e.preventDefault();this.closeStorageDialog();return;}if(!$('#clear-dialog').hidden&&key==='escape'){e.preventDefault();this.closeClearDialog();return;}if(e.code==='Space'){this.spaceDown=true;e.preventDefault();return;}if(mod&&key==='z'){e.preventDefault();e.shiftKey?this.redo():this.undo();return;}if(mod&&key==='y'){e.preventDefault();this.redo();return;}if(mod&&key==='d'){e.preventDefault();this.duplicateSelected();return;}if(mod&&key==='g'){e.preventDefault();e.shiftKey?this.ungroupSelected():this.groupSelected();return;}if(key==='tab'&&this.getMindFocus()){e.preventDefault();const node=this.getMindFocus();this.createMindRelative(node,e.shiftKey?'sibling':'child');return;}if(mod&&(e.code==='BracketLeft'||key==='[')){e.preventDefault();this.moveSelectedLayer(-1,e.shiftKey);return;}if(mod&&(e.code==='BracketRight'||key===']')){e.preventDefault();this.moveSelectedLayer(1,e.shiftKey);return;}if(key==='delete'||key==='backspace'){e.preventDefault();this.deleteSelected();return;}if(key==='escape'){this.closePopovers();this.clearSelection();this.render();return;}if(key==='f'){this.fitContent();return;}
      if(e.shiftKey&&key==='e'){e.preventDefault();this.exportPNG(false);return;}const map={v:'select','1':'select',h:'hand','2':'hand',d:'draw','3':'draw',i:'highlight','4':'highlight',e:'eraser','5':'eraser',k:'pen','6':'pen',l:'line','7':'line',a:'arrow','8':'arrow',g:'geo','9':'geo',t:'text',n:'note',m:'mindmap'};if(map[key]){this.setTool(map[key]);return;}
      if(this.getSelectedElements().length&&['arrowup','arrowdown','arrowleft','arrowright'].includes(key)){e.preventDefault();const d=e.shiftKey?10:1,dx=key==='arrowleft'?-d:key==='arrowright'?d:0,dy=key==='arrowup'?-d:key==='arrowdown'?d:0;this.moveSelected(dx/this.scale,dy/this.scale);this.commit();this.render();}
    }

    setTool(tool) { if(this.penDraft&&tool!=='pen')this.finishPen();this.penEdit=null;this.currentTool=tool;$$('.tool-btn[data-tool]').forEach(b=>b.classList.toggle('active',b.dataset.tool===tool));this.container.className=`canvas-container tool-${tool}`;if(tool!=='select'&&tool!=='mindmap'&&tool!=='pen')this.clearSelection();this.updateMindStyleUI();this.render(); }

    // ---------- mind map ----------
    getMindFocus() {
      const items=this.getSelectedElements();
      return items.length===1&&items[0].type==='mindnode'?items[0]:null;
    }

    getMindNodeLines(ctx,text,maxWidth) {
      const out=[];
      const paragraphs=String(text||'').split('\n');
      for(const para of paragraphs){
        if(!para){out.push('');continue;}
        let line='';
        for(const ch of [...para]){
          const test=line+ch;
          if(line&&ctx.measureText(test).width>maxWidth){out.push(line);line=ch;}else line=test;
        }
        out.push(line);
      }
      return out.length?out:[''];
    }

    updateMindNodeMetrics(el) {
      const fs=el.fontSize||15;
      this.ctx.save();
      this.ctx.font=`${el.parentId?500:600} ${fs}px ui-sans-serif,system-ui,sans-serif`;
      const raw=String(el.text||'');
      const natural=Math.max(70,...raw.split('\n').map(line=>this.ctx.measureText(line||' ').width+30));
      el.w=clamp(natural,110,260);
      const lines=this.getMindNodeLines(this.ctx,raw,Math.max(40,el.w-24));
      el.h=Math.max(42,lines.length*fs*1.3+22);
      this.ctx.restore();
    }

    createMindNode(x,y,parentId=null) {
      const parent=parentId?this.elements.find(el=>el.id===parentId):null;
      const node={id:newId(),type:'mindnode',x,y,w:150,h:44,text:'',parentId:parentId||null,fontSize:15,color:this.theme==='dark'?'#d8d3ca':'#5d5952',textColor:this.theme==='dark'?'#ffffff':'#1f1f1f'};
      if(parent){
        node.x=parent.x+(parent.w||150)+82;
        const siblings=this.elements.filter(el=>el.type==='mindnode'&&el.parentId===parent.id);
        node.y=parent.y+(siblings.length? siblings.length*58 : 0);
      }
      this.elements.push(node);
      if(parent)this.createMindEdge(parent,node,'right','left',this.currentMindStyle,false);
      this.setSelection([node],false);
      this.render();
      return node;
    }

    createMindRelative(node,relation='child') {
      if(!node||node.type!=='mindnode')return null;
      let parentId;
      let x=node.x,y=node.y;
      if(relation==='child'){
        parentId=node.id;
      }else{
        parentId=node.parentId||null;
        if(parentId){
          const parent=this.elements.find(el=>el.id===parentId);
          if(parent){x=parent.x+(parent.w||150)+82;y=node.y+58;}
        }else y=node.y+(node.h||44)+18;
      }
      const next=this.createMindNode(x,y,parentId);
      if(relation==='sibling'&&!parentId){next.x=node.x;next.y=y;}
      this.editMindNode(next,true);
      return next;
    }

    rawMindAnchorPoint(node,side) {
      const w=node.w||150,h=node.h||44;
      if(side==='top')return{x:node.x+w/2,y:node.y};
      if(side==='bottom')return{x:node.x+w/2,y:node.y+h};
      if(side==='left')return{x:node.x,y:node.y+h/2};
      return{x:node.x+w,y:node.y+h/2};
    }

    nearestMindSide(node,p) {
      const sides=['top','right','bottom','left'];let best='left',dist=Infinity;
      for(const side of sides){const q=this.mindAnchorPoint(node,side),d=Math.hypot(p.x-q.x,p.y-q.y);if(d<dist){dist=d;best=side;}}
      return best;
    }

    migrateMindEdges() {
      const nodes=this.elements.filter(el=>el.type==='mindnode');
      const nodeIds=new Set(nodes.map(n=>n.id));
      this.elements=this.elements.filter(el=>el.type!=='mindedge'||(nodeIds.has(el.fromId)&&nodeIds.has(el.toId)));
      const edges=this.elements.filter(el=>el.type==='mindedge');
      for(const edge of edges){edge.style=edge.style||'rounded';edge.color=edge.color||(this.theme==='dark'?'#b9b4ac':'#77736c');}
      const pair=new Set(edges.map(e=>`${e.fromId}>${e.toId}`));
      const add=[];
      for(const child of nodes){
        if(!child.parentId||!nodeIds.has(child.parentId)||pair.has(`${child.parentId}>${child.id}`))continue;
        const parent=nodes.find(n=>n.id===child.parentId);if(!parent)continue;
        const right=child.x>=parent.x;
        add.push({id:newId(),type:'mindedge',fromId:parent.id,toId:child.id,fromSide:right?'right':'left',toSide:right?'left':'right',style:'rounded',color:this.theme==='dark'?'#b9b4ac':'#77736c',size:1.5});
      }
      if(add.length)this.elements.unshift(...add);
    }

    createMindEdge(from,to,fromSide='right',toSide='left',style=this.currentMindStyle,commit=true) {
      if(!from||!to||from.id===to.id)return null;
      const edge={id:newId(),type:'mindedge',fromId:from.id,toId:to.id,fromSide,toSide,style:style||'rounded',color:this.theme==='dark'?'#777c86':'#7d8794',size:1.6};
      this.elements.unshift(edge);
      if(commit)this.commit();
      return edge;
    }

    mindEdgeGeometry(edge) {
      const from=this.elements.find(el=>el.id===edge.fromId&&el.type==='mindnode');
      const to=this.elements.find(el=>el.id===edge.toId&&el.type==='mindnode');
      if(!from||!to)return null;
      return{from,to,a:this.mindAnchorPoint(from,edge.fromSide||'right'),b:this.mindAnchorPoint(to,edge.toSide||'left')};
    }

    rawMindEdgeSamplePoints(edge) {
      const g=this.mindEdgeGeometry(edge);if(!g)return[];const {a,b}=g;
      if(edge.style==='orthogonal'){
        const gap=18;
        const out=(p,side)=>({x:p.x+(side==='left'?-gap:side==='right'?gap:0),y:p.y+(side==='top'?-gap:side==='bottom'?gap:0)});
        const a1=out(a,edge.fromSide||'right'),b1=out(b,edge.toSide||'left');
        const fromH=['left','right'].includes(edge.fromSide||'right'),toH=['left','right'].includes(edge.toSide||'left');
        let pts=[a,a1];
        if(fromH&&toH){const mx=(a1.x+b1.x)/2;pts.push({x:mx,y:a1.y},{x:mx,y:b1.y});}
        else if(!fromH&&!toH){const my=(a1.y+b1.y)/2;pts.push({x:a1.x,y:my},{x:b1.x,y:my});}
        else if(fromH)pts.push({x:b1.x,y:a1.y});
        else pts.push({x:a1.x,y:b1.y});
        pts.push(b1,b);
        const clean=[];
        for(const p of pts){const q=clean[clean.length-1];if(!q||Math.abs(q.x-p.x)>.001||Math.abs(q.y-p.y)>.001)clean.push(p);}
        for(let i=clean.length-2;i>0;i--){const p0=clean[i-1],p1=clean[i],p2=clean[i+1];if((Math.abs(p0.x-p1.x)<.001&&Math.abs(p1.x-p2.x)<.001)||(Math.abs(p0.y-p1.y)<.001&&Math.abs(p1.y-p2.y)<.001))clean.splice(i,1);}
        return clean;
      }
      const dx=b.x-a.x,dy=b.y-a.y;
      const horizontal=(edge.fromSide==='left'||edge.fromSide==='right');
      let c1,c2;
      if(horizontal){const dir=edge.fromSide==='left'?-1:1,dist=Math.max(26,Math.abs(dx)*.48);c1={x:a.x+dir*dist,y:a.y};const dir2=edge.toSide==='left'?-1:1;c2={x:b.x+dir2*dist,y:b.y};}
      else{const dir=edge.fromSide==='top'?-1:1,dist=Math.max(26,Math.abs(dy)*.48);c1={x:a.x,y:a.y+dir*dist};const dir2=edge.toSide==='top'?-1:1;c2={x:b.x,y:b.y+dir2*dist};}
      const pts=[];for(let i=0;i<=24;i++){const t=i/24,u=1-t;pts.push({x:u*u*u*a.x+3*u*u*t*c1.x+3*u*t*t*c2.x+t*t*t*b.x,y:u*u*u*a.y+3*u*u*t*c1.y+3*u*t*t*c2.y+t*t*t*b.y});}return pts;
    }

    mindEdgeLabelPoint(edge,pts=null){const list=pts||this.mindEdgeSamplePoints(edge);if(!list.length)return null;let total=0;const lens=[];for(let i=1;i<list.length;i++){const l=Math.hypot(list[i].x-list[i-1].x,list[i].y-list[i-1].y);lens.push(l);total+=l;}let target=total/2;for(let i=1;i<list.length;i++){const l=lens[i-1];if(target<=l||i===list.length-1){const t=l?target/l:0;return{x:list[i-1].x+(list[i].x-list[i-1].x)*t,y:list[i-1].y+(list[i].y-list[i-1].y)*t};}target-=l;}return list[Math.floor(list.length/2)];}

    drawMindEdge(ctx,edge,selected=false) {
      const pts=this.mindEdgeSamplePoints(edge);if(pts.length<2)return;
      const stroke=selected?(getComputedStyle(this.app).getPropertyValue('--sel').trim()||'#2f6fed'):(edge.color||(this.theme==='dark'?'#9aa3ad':'#7d8794'));
      const unit=this.exporting?1:1/this.scale;ctx.save();ctx.strokeStyle=stroke;ctx.fillStyle=stroke;ctx.lineWidth=(selected?3.2:(edge.size||1.6))*unit;ctx.lineCap='round';ctx.lineJoin='round';ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i].x,pts[i].y);ctx.stroke();
      if(edge.arrow){let i=pts.length-2;while(i>0&&Math.hypot(pts.at(-1).x-pts[i].x,pts.at(-1).y-pts[i].y)<.01)i--;const a=pts[i],b=pts.at(-1),ang=Math.atan2(b.y-a.y,b.x-a.x),len=10*unit;ctx.beginPath();ctx.moveTo(b.x,b.y);ctx.lineTo(b.x-len*Math.cos(ang-.55),b.y-len*Math.sin(ang-.55));ctx.moveTo(b.x,b.y);ctx.lineTo(b.x-len*Math.cos(ang+.55),b.y-len*Math.sin(ang+.55));ctx.stroke();}
      if(edge.label){const q=this.mindEdgeLabelPoint(edge,pts),text=String(edge.label);ctx.font=`500 ${12*unit}px ui-sans-serif,system-ui,sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';const w=ctx.measureText(text).width+10*unit,h=18*unit;ctx.fillStyle=this.theme==='dark'?'#191713':'#F9FAFB';if(ctx.roundRect){ctx.beginPath();ctx.roundRect(q.x-w/2,q.y-h/2,w,h,4*unit);ctx.fill();}else ctx.fillRect(q.x-w/2,q.y-h/2,w,h);ctx.fillStyle=selected?(getComputedStyle(this.app).getPropertyValue('--sel').trim()||'#2f6fed'):(this.theme==='dark'?'#e5e7eb':'#4b5563');ctx.fillText(text,q.x,q.y);}
      ctx.restore();
    }

    drawMindMapConnections(ctx) { for(const edge of this.elements)if(edge.type==='mindedge'&&this.isElementVisible(edge))this.drawMindEdge(ctx,edge,false); }

    drawMindAnchors(ctx,node) {
      ctx.save();const sel=getComputedStyle(this.app).getPropertyValue('--sel').trim()||'#2f6fed';const r=5/this.scale,off=10/this.scale;ctx.fillStyle=this.theme==='dark'?'#191713':'#F9FAFB';ctx.strokeStyle=sel;ctx.lineWidth=1.7/this.scale;
      for(const side of ['top','right','bottom','left']){const q=this.mindAnchorPoint(node,side),x=q.x+(side==='left'?-off:side==='right'?off:0),y=q.y+(side==='top'?-off:side==='bottom'?off:0);ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();ctx.stroke();}
      ctx.restore();
    }

    hitMindAnchor(p) {
      const node=this.getMindFocus();if(!node)return null;const r=10/this.scale,off=10/this.scale;
      for(const side of ['top','right','bottom','left']){const q=this.mindAnchorPoint(node,side),x=q.x+(side==='left'?-off:side==='right'?off:0),y=q.y+(side==='top'?-off:side==='bottom'?off:0);if(Math.hypot(p.x-x,p.y-y)<=r)return{node,side};}
      return null;
    }

    startMindLink(node,side,p) { const a=this.mindAnchorPoint(node,side);this.mindLinkDraft={fromId:node.id,fromSide:side,from:a,to:{x:p.x,y:p.y}};this.pointerDown=true; }
    drawMindLinkDraft(ctx) { const d=this.mindLinkDraft;if(!d)return;ctx.save();ctx.strokeStyle=getComputedStyle(this.app).getPropertyValue('--sel').trim()||'#2f6fed';ctx.lineWidth=1.8/this.scale;ctx.setLineDash([5/this.scale,4/this.scale]);ctx.beginPath();ctx.moveTo(d.from.x,d.from.y);ctx.lineTo(d.to.x,d.to.y);ctx.stroke();ctx.restore(); }
    finishMindLink(p) { const d=this.mindLinkDraft;this.mindLinkDraft=null;if(!d)return;const from=this.elements.find(el=>el.id===d.fromId&&el.type==='mindnode');const to=[...this.elements].reverse().find(el=>el.type==='mindnode'&&el.id!==d.fromId&&this.pointInElement(p,el));if(!from||!to){this.render();return;}const side=this.nearestMindSide(to,p);const edge=this.createMindEdge(from,to,d.fromSide,side,this.currentMindStyle,false);this.setSelection([edge],false);this.commit();this.render(); }

    pointSegmentDistance(p,a,b){const dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;if(!l2)return Math.hypot(p.x-a.x,p.y-a.y);const t=clamp(((p.x-a.x)*dx+(p.y-a.y)*dy)/l2,0,1),x=a.x+t*dx,y=a.y+t*dy;return Math.hypot(p.x-x,p.y-y);}
    pointNearMindEdge(p,edge,tol){const pts=this.mindEdgeSamplePoints(edge);for(let i=1;i<pts.length;i++)if(this.pointSegmentDistance(p,pts[i-1],pts[i])<=tol)return true;return false;}

    arrowGeometry(el){const sx=el.x,sy=el.y,ex=el.x+(el.w||0),ey=el.y+(el.h||0),dx=ex-sx,dy=ey-sy,len=Math.hypot(dx,dy)||1,nx=-dy/len,ny=dx/len,mx=(sx+ex)/2,my=(sy+ey)/2,b=el.bend||0;return{sx,sy,ex,ey,cx:mx+nx*b,cy:my+ny*b,mx,my,nx,ny};}
    arrowSamplePoints(el){const g=this.arrowGeometry(el),pts=[];for(let i=0;i<=28;i++){const t=i/28,u=1-t;pts.push({x:u*u*g.sx+2*u*t*g.cx+t*t*g.ex,y:u*u*g.sy+2*u*t*g.cy+t*t*g.ey});}return pts;}
    pointNearArrow(p,el,tol){const pts=this.arrowSamplePoints(el);for(let i=1;i<pts.length;i++)if(this.pointSegmentDistance(p,pts[i-1],pts[i])<=tol)return true;return false;}
    drawArrowSelection(ctx,el){const g=this.arrowGeometry(el),pts=this.arrowSamplePoints(el),mid={x:g.mx+g.nx*(el.bend||0)/2,y:g.my+g.ny*(el.bend||0)/2};ctx.save();const sel=getComputedStyle(this.app).getPropertyValue('--sel').trim()||'#2f6fed';ctx.strokeStyle=sel;ctx.lineWidth=2.4/this.scale;ctx.lineCap='round';ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i].x,pts[i].y);ctx.stroke();ctx.fillStyle=this.theme==='dark'?'#191713':'#F9FAFB';ctx.lineWidth=1.8/this.scale;for(const q of [{x:g.sx,y:g.sy},mid,{x:g.ex,y:g.ey}]){ctx.beginPath();ctx.arc(q.x,q.y,5/this.scale,0,Math.PI*2);ctx.fill();ctx.stroke();}ctx.restore();}
    hitArrowControl(p){const items=this.getSelectedElements();if(items.length!==1||items[0].type!=='arrow')return null;const el=items[0];p=this.imageLocalPoint(el,p);const g=this.arrowGeometry(el),mid={x:g.mx+g.nx*(el.bend||0)/2,y:g.my+g.ny*(el.bend||0)/2},r=10/this.scale;if(Math.hypot(p.x-mid.x,p.y-mid.y)<=r)return{el,kind:'curve'};if(Math.hypot(p.x-g.sx,p.y-g.sy)<=r)return{el,kind:'start'};if(Math.hypot(p.x-g.ex,p.y-g.ey)<=r)return{el,kind:'end'};return null;}

    onContextMenu(e){ /* Right-click is no longer used for node text color. */ }
    showMindTextColorMenu(x,y){const menu=$('#mind-text-color-menu');if(!menu)return;menu.hidden=false;const w=168,h=132;menu.style.left=`${clamp(x,8,window.innerWidth-w-8)}px`;menu.style.top=`${clamp(y,8,window.innerHeight-h-8)}px`;}
    setMindTextColor(color){const targets=this.getSelectedElements().filter(el=>el.type==='mindnode');const nodes=targets.length?targets:(this.getMindFocus()?[this.getMindFocus()]:[]);if(!nodes.length)return;for(const node of nodes)node.textColor=color;this.commit();this.render();const menu=$('#mind-text-color-menu');if(menu)menu.hidden=true;}
    setMindFillColor(color){
      const targets=this.getSelectedElements().filter(el=>el.type==='mindnode');
      if(!targets.length)return;
      for(const node of targets){node.bgColor=color;node.bgOpacity=.18;}
      this.commit();this.render();
    }

    mindFontSizeForLevel(level){return ({2:12,4:15,8:20,14:28})[Number(level)]||15;}
    mindLevelForFontSize(fontSize){const levels=[2,4,8,14],fs=Number(fontSize)||15;return levels.reduce((best,l)=>Math.abs(this.mindFontSizeForLevel(l)-fs)<Math.abs(this.mindFontSizeForLevel(best)-fs)?l:best,4);}
    setMindFontSizeLevel(level,button=null){
      const targets=this.getSelectedElements().filter(el=>el.type==='mindnode');if(!targets.length)return false;const fs=this.mindFontSizeForLevel(level);
      for(const node of targets){node.fontSize=fs;this.updateMindNodeMetrics(node);}this.syncSizeLevelUI(level);this.commit();this.render();return true;
    }
    syncSizeLevelUI(forceLevel=null){
      const nodes=this.getSelectedElements().filter(el=>el.type==='mindnode');let level=forceLevel;
      if(level==null)level=nodes.length?this.mindLevelForFontSize(nodes[nodes.length-1].fontSize):this.currentSize;
      $$('.size-option').forEach(b=>b.classList.toggle('active',Number(b.dataset.size)===Number(level)));
    }
    syncShapeStyleUI(selected=this.getSelectedElements()){
      const shapeTypes=new Set(['path','rect','ellipse','triangle','diamond','hexagon','star','cloud']);
      const shape=[...selected].reverse().find(el=>shapeTypes.has(el.type));
      const fill=shape?.fill??this.currentFill,stroke=shape?.stroke??this.currentStroke;
      $$('.fill-option').forEach(b=>b.classList.toggle('active',b.dataset.fill===fill));
      $$('.stroke-option').forEach(b=>b.classList.toggle('active',b.dataset.stroke===stroke));
    }
    setMindStyle(style){
      this.currentMindStyle=style;
      const selected=this.getSelectedElements(),nodeIds=new Set(selected.filter(el=>el.type==='mindnode').map(el=>el.id));
      const targets=this.elements.filter(el=>el.type==='mindedge'&&(selected.includes(el)||nodeIds.has(el.fromId)||nodeIds.has(el.toId)));
      for(const edge of targets)edge.style=style;
      this.savePreferences();
      if(targets.length)this.commit();this.updateMindStyleUI();this.render();
    }
    updateMindStyleUI(){
      const card=$('#mind-style-card');if(!card)return;
      const selected=this.getSelectedElements(),show=this.currentTool==='mindmap'||selected.some(el=>el.type==='mindnode'||el.type==='mindedge');
      card.hidden=!show;
      const selectedEdge=[...selected].reverse().find(el=>el.type==='mindedge');
      const displayedStyle=selectedEdge?.style||this.currentMindStyle;
      $$('#mind-style-control button').forEach(b=>b.classList.toggle('active',b.dataset.mindStyle===displayedStyle));
    }

    editMindNode(node,isNew=false) {
      if(!node||node.type!=='mindnode')return;
      const before=clone(node);
      const ta=document.createElement('textarea');
      ta.className='mind-node-editor';
      ta.value=node.text||'';
      ta.placeholder=node.parentId?'节点':'主题';
      ta.spellcheck=false;
      document.body.append(ta);

      const syncPosition=()=>{
        const screen=this.worldToScreen(node.x,node.y),rect=this.container.getBoundingClientRect();
        ta.style.left=`${rect.left+screen.x}px`;
        ta.style.top=`${rect.top+screen.y}px`;
        ta.style.width=`${Math.max(110,(node.w||150)*this.scale)}px`;
        ta.style.height=`${Math.max(42,(node.h||44)*this.scale)}px`;
        ta.style.fontSize=`${(node.fontSize||15)*this.scale}px`;
        this.transformTextEditor(ta,node);
      };
      const sync=()=>{node.text=ta.value;this.updateMindNodeMetrics(node);syncPosition();this.render();};
      let done=false;
      const finish=(cancel=false,relation=null)=>{
        if(done)return;done=true;
        const value=ta.value.trim();
        if(cancel){
          if(isNew)this.elements=this.elements.filter(el=>el!==node&&!(el.type==='mindedge'&&(el.fromId===node.id||el.toId===node.id)));else Object.assign(node,before);
        }else if(!value){
          if(isNew)this.elements=this.elements.filter(el=>el!==node&&!(el.type==='mindedge'&&(el.fromId===node.id||el.toId===node.id)));else Object.assign(node,before);
        }else{
          node.text=value;this.updateMindNodeMetrics(node);this.setSelection([node],false);this.commit();
        }
        ta.remove();this.render();
        if(!cancel&&value&&relation)this.createMindRelative(node,relation);
        else if(!cancel&&value)this.setTool('select');
      };
      ta.addEventListener('input',sync);
      ta.addEventListener('blur',()=>finish(false));
      ta.addEventListener('keydown',e=>{
        if(e.key==='Escape'){e.preventDefault();finish(true);}
        else if(e.key==='Tab'){e.preventDefault();finish(false,e.shiftKey?'sibling':'child');}
        else if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();finish(false);}
      });
      this.updateMindNodeMetrics(node);syncPosition();this.render();
      setTimeout(()=>{ta.focus();ta.setSelectionRange(ta.value.length,ta.value.length);},0);
    }

    // ---------- Mermaid flowchart import ----------
    cleanMermaidLabel(value){
      let s=String(value??'').trim();
      if((s.startsWith('"')&&s.endsWith('"'))||(s.startsWith("'")&&s.endsWith("'")))s=s.slice(1,-1);
      return s.replace(/<br\s*\/?>/gi,'\n').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
    }

    parseMermaidNodeToken(token){
      const raw=String(token||'').trim().replace(/;\s*$/,'');
      const m=raw.match(/^([A-Za-z_][\w-]*)([\s\S]*)$/);if(!m)return null;
      const id=m[1],tail=m[2].trim();let text=id,shape='rect';
      let q;
      if((q=tail.match(/^\(\[([\s\S]*)\]\)$/))){text=q[1];shape='pill';}
      else if((q=tail.match(/^\{([\s\S]*)\}$/))){text=q[1];shape='diamond';}
      else if((q=tail.match(/^\(\(([\s\S]*)\)\)$/))){text=q[1];shape='ellipse';}
      else if((q=tail.match(/^\[([\s\S]*)\]$/))){text=q[1];shape='rect';}
      else if((q=tail.match(/^\(([\s\S]*)\)$/))){text=q[1];shape='rounded';}
      else if(tail)return null;
      return{id,text:this.cleanMermaidLabel(text),shape};
    }

    parseMermaidFlowchart(source){
      const lines=String(source||'').replace(/\r/g,'').split('\n').map(x=>x.trim()).filter(Boolean);
      let direction='TD',start=0;
      if(lines[0]){const h=lines[0].match(/^(?:flowchart|graph)\s+(TD|TB|BT|LR|RL)\b/i);if(h){direction=h[1].toUpperCase();start=1;}}
      const nodes=new Map(),edges=[];
      const upsert=(token)=>{const parsed=this.parseMermaidNodeToken(token);if(!parsed)return null;const prev=nodes.get(parsed.id);if(prev){if(parsed.text!==parsed.id||parsed.shape!=='rect')Object.assign(prev,parsed);return prev;}nodes.set(parsed.id,parsed);return parsed;};
      for(let i=start;i<lines.length;i++){
        let line=lines[i].replace(/%%.*$/,'').trim();if(!line)continue;
        if(/^(subgraph|end\b|classDef\b|class\b|style\b|linkStyle\b|click\b)/i.test(line))continue;
        const edge=line.match(/^([\s\S]*?)\s*-->\s*(?:\|([^|]*)\|\s*)?([\s\S]*?)\s*;?$/);
        if(edge){const a=upsert(edge[1]),b=upsert(edge[3]);if(a&&b)edges.push({from:a.id,to:b.id,label:this.cleanMermaidLabel(edge[2]||'')});continue;}
        upsert(line);
      }
      return{direction,nodes:[...nodes.values()],edges};
    }

    layoutMermaidFlowchart(parsed){
      const defs=parsed.nodes||[],links=parsed.edges||[];if(!defs.length)return null;
      const byId=new Map(defs.map(n=>[n.id,n])),adj=new Map(defs.map(n=>[n.id,[]])),indegree=new Map(defs.map(n=>[n.id,0]));
      for(const e of links){if(!byId.has(e.from)||!byId.has(e.to))continue;adj.get(e.from).push(e.to);indegree.set(e.to,(indegree.get(e.to)||0)+1);}
      let roots=defs.filter(n=>(indegree.get(n.id)||0)===0).map(n=>n.id);if(!roots.length)roots=[defs[0].id];
      const level=new Map(),queue=[];for(const id of roots){level.set(id,0);queue.push(id);}for(let qi=0;qi<queue.length;qi++){const id=queue[qi],lv=level.get(id)||0;for(const to of adj.get(id)||[]){if(!level.has(to)){level.set(to,lv+1);queue.push(to);}}}
      let fallback=Math.max(0,...level.values());for(const d of defs)if(!level.has(d.id))level.set(d.id,++fallback);
      const maxLevel=Math.max(0,...level.values()),dir=parsed.direction||'TD',reverse=dir==='BT'||dir==='RL',horizontal=dir==='LR'||dir==='RL';
      const groups=new Map();for(const d of defs){let lv=level.get(d.id)||0;if(reverse)lv=maxLevel-lv;if(!groups.has(lv))groups.set(lv,[]);groups.get(lv).push(d);}
      const cx=(this.width/2-this.offsetX)/this.scale,cy=(this.height/2-this.offsetY)/this.scale;
      const nodeMap=new Map(),created=[];
      for(const d of defs){const node={id:newId(),type:'mindnode',mermaid:true,mermaidId:d.id,nodeShape:d.shape||'rect',x:0,y:0,w:150,h:44,text:d.text||d.id,parentId:null,fontSize:15,color:this.theme==='dark'?'#d8d3ca':'#5d5952',textColor:this.theme==='dark'?'#ffffff':'#1f1f1f',bgColor:this.theme==='dark'?'#24211d':'#ffffff'};this.updateMindNodeMetrics(node);if(node.nodeShape==='diamond'){node.w=Math.max(160,node.w+26);node.h=Math.max(76,node.h+22);}else if(node.nodeShape==='ellipse'||node.nodeShape==='pill')node.h=Math.max(48,node.h);nodeMap.set(d.id,node);created.push(node);}
      if(horizontal){
        const levelGap=220,rowGap=34,baseX=cx-maxLevel*levelGap/2;
        for(const [lv,items] of [...groups].sort((a,b)=>a[0]-b[0])){const nodes=items.map(d=>nodeMap.get(d.id)),total=nodes.reduce((a,n)=>a+n.h,0)+rowGap*Math.max(0,nodes.length-1);let y=cy-total/2;for(const n of nodes){n.x=baseX+lv*levelGap-n.w/2;n.y=y;y+=n.h+rowGap;}}
      }else{
        const levelGap=120,colGap=42,baseY=cy-maxLevel*levelGap/2;
        for(const [lv,items] of [...groups].sort((a,b)=>a[0]-b[0])){const nodes=items.map(d=>nodeMap.get(d.id)),total=nodes.reduce((a,n)=>a+n.w,0)+colGap*Math.max(0,nodes.length-1);let x=cx-total/2;for(const n of nodes){n.x=x;n.y=baseY+lv*levelGap-n.h/2;x+=n.w+colGap;}}
      }
      const edgeEls=[];for(const e of links){const from=nodeMap.get(e.from),to=nodeMap.get(e.to);if(!from||!to)continue;let fromSide='bottom',toSide='top';if(dir==='BT'){fromSide='top';toSide='bottom';}else if(dir==='LR'){fromSide='right';toSide='left';}else if(dir==='RL'){fromSide='left';toSide='right';}edgeEls.push({id:newId(),type:'mindedge',fromId:from.id,toId:to.id,fromSide,toSide,style:this.currentMindStyle,color:this.theme==='dark'?'#9aa3ad':'#7d8794',size:1.6,arrow:true,label:e.label||''});}
      return{nodes:created,edges:edgeEls};
    }

    mermaidNodeToken(node,index){const id=node.mermaidId&&/^[A-Za-z_]\w*$/.test(node.mermaidId)?node.mermaidId:`node_${index+1}`,label=String(node.text||id).replace(/"/g,'&quot;').replace(/\n/g,'<br/>');if(node.nodeShape==='pill')return`${id}(["${label}"])`;if(node.nodeShape==='diamond')return`${id}{"${label}"}`;if(node.nodeShape==='ellipse')return`${id}(("${label}"))`;if(node.nodeShape==='rounded')return`${id}("${label}")`;return`${id}["${label}"]`;}

    serializeMermaidFlowchart(){
      const nodes=this.elements.filter(el=>el.type==='mindnode'&&el.mermaid),idByNode=new Map();if(!nodes.length)return'';nodes.forEach((node,index)=>{const token=this.mermaidNodeToken(node,index);idByNode.set(node.id,token.match(/^[A-Za-z_]\w*/)[0]);});const lines=['flowchart LR'];nodes.forEach((node,index)=>lines.push(`    ${this.mermaidNodeToken(node,index)}`));for(const edge of this.elements.filter(el=>el.type==='mindedge'&&idByNode.has(el.fromId)&&idByNode.has(el.toId))){const label=edge.label?`|${String(edge.label).replace(/\|/g,'/')}|`:'';lines.push(`    ${idByNode.get(edge.fromId)} -->${label} ${idByNode.get(edge.toId)}`);}return lines.join('\n');
    }

    async copyMermaid(){const source=this.serializeMermaidFlowchart();if(!source){this.toast('当前画板没有 Mermaid 流程图。');return;}try{await navigator.clipboard.writeText(source);this.toast('Mermaid 源码已复制。');}catch{this.toast('无法写入剪贴板。');}}

    openMermaidDialog(edit=false){
      this.closePopovers();const dialog=$('#mermaid-dialog'),ta=$('#mermaid-input');if(!dialog||!ta)return;this.mermaidEditMode=!!edit;const source=edit?this.serializeMermaidFlowchart():'';if(edit&&!source){this.toast('当前画板没有 Mermaid 流程图。');return;}if(edit)ta.value=source;dialog.hidden=false;setTimeout(()=>{ta.focus();ta.setSelectionRange(ta.value.length,ta.value.length);},0);
    }
    closeMermaidDialog(){const dialog=$('#mermaid-dialog');if(dialog)dialog.hidden=true;this.container.focus({preventScroll:true});}
    generateMermaidFromInput(){
      const ta=$('#mermaid-input'),text=ta?.value||'';let parsed;try{parsed=this.parseMermaidFlowchart(text);}catch{this.toast('Mermaid 文本无法解析。');return;}
      if(!parsed.nodes.length){this.toast('没有识别到流程图节点。');return;}
      const layout=this.layoutMermaidFlowchart(parsed);if(!layout?.nodes?.length){this.toast('流程图生成失败。');return;}
      if(this.mermaidEditMode){const ids=new Set(this.elements.filter(el=>el.type==='mindnode'&&el.mermaid).map(el=>el.id));this.elements=this.elements.filter(el=>!ids.has(el.id)&&!(el.type==='mindedge'&&(ids.has(el.fromId)||ids.has(el.toId))));}
      this.elements.push(...layout.nodes);this.elements.unshift(...layout.edges);this.setSelection(layout.nodes,false);this.commit();this.render();this.closeMermaidDialog();this.toast(`${this.mermaidEditMode?'已更新':'已生成'} ${layout.nodes.length} 个节点、${layout.edges.length} 条连线。`);this.mermaidEditMode=false;
    }

    // ---------- text ----------
    measureTextLayout(el,context=this.ctx) {
      const fs=el.fontSize||18;
      const font=`${fs}px ui-sans-serif,system-ui,sans-serif`;
      const lines=String(el.text||'').split('\n');
      const lineHeight=fs*1.2;
      context.save();
      context.font=font;
      context.textAlign='left';
      context.textBaseline='alphabetic';
      const rows=lines.map(text=>{
        const metrics=context.measureText(text||' ');
        const measuredLeft=Number(metrics.actualBoundingBoxLeft);
        const measuredRight=Number(metrics.actualBoundingBoxRight);
        const measuredAscent=Number(metrics.actualBoundingBoxAscent);
        const measuredDescent=Number(metrics.actualBoundingBoxDescent);
        const left=Number.isFinite(measuredLeft)?measuredLeft:0;
        const inkWidth=measuredLeft+measuredRight;
        const width=text&&Number.isFinite(inkWidth)&&inkWidth>0?inkWidth:Math.max(2,metrics.width||0);
        const ascent=Number.isFinite(measuredAscent)&&measuredAscent>0?measuredAscent:fs*.8;
        const descent=Number.isFinite(measuredDescent)&&measuredDescent>=0?measuredDescent:fs*.2;
        return{text,left,width,ascent,descent};
      });
      context.restore();
      const width=Math.max(2,...rows.map(row=>row.width));
      const last=rows.at(-1);
      const height=Math.max(2,(rows.length-1)*lineHeight+(last?.ascent||fs*.8)+(last?.descent||fs*.2));
      return{font,lineHeight,rows,width,height};
    }

    updateTextMetrics(el) {
      const layout=this.measureTextLayout(el);
      el.w=layout.width;
      el.h=layout.height;
    }

    createTextEditor(wx,wy,note=false,existing=null) {
      if(note)return this.createNoteEditor(wx,wy,existing);

      const isNew=!existing;
      const before=existing?clone(existing):null;
      const el=existing||{id:newId(),type:'text',x:wx,y:wy,text:'',color:this.currentColor,fontSize:18,w:2,h:24};
      if(isNew)this.elements.push(el);
      this.setSelection([el]);

      const ta=document.createElement('textarea');
      ta.className='text-editor inline-text-editor';
      ta.value=el.text||'';
      ta.setAttribute('aria-label','编辑文字');
      ta.spellcheck=false;
      document.body.append(ta);

      const syncEditorPosition=()=>{
        const screen=this.worldToScreen(el.x,el.y),rect=this.container.getBoundingClientRect();
        const fs=(el.fontSize||18)*this.scale;
        ta.style.left=`${rect.left+screen.x}px`;
        ta.style.top=`${rect.top+screen.y}px`;
        this.transformTextEditor(ta,el);
        ta.style.fontSize=`${fs}px`;
        ta.style.lineHeight='1.2';
        ta.style.color='transparent';
        ta.style.caretColor=el.color||this.currentColor;
        ta.style.width=`${Math.max(80,(el.w||80)*this.scale+24)}px`;
        ta.style.height=`${Math.max(fs*1.5,(el.h||fs*1.35)*this.scale+8)}px`;
      };

      const syncText=()=>{
        el.text=ta.value;
        this.updateTextMetrics(el);
        syncEditorPosition();
        this.render();
      };

      let done=false;
      const finish=(cancel=false)=>{
        if(done)return;done=true;
        const text=ta.value.replace(/\s+$/,'');
        if(cancel){
          if(isNew)this.elements=this.elements.filter(x=>x!==el);
          else Object.assign(el,before);
        }else if(!text.trim()){
          if(isNew)this.elements=this.elements.filter(x=>x!==el);
          else Object.assign(el,before);
        }else{
          el.text=text;
          this.updateTextMetrics(el);
          this.setSelection([el]);
          this.commit();
        }
        ta.remove();
        this.setTool('select');
        this.render();
      };

      ta.addEventListener('input',syncText);
      ta.addEventListener('blur',()=>finish(false));
      ta.addEventListener('keydown',e=>{
        if(e.key==='Escape'){e.preventDefault();finish(true);}
        else if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();finish(false);}
      });
      syncEditorPosition();
      this.render();
      setTimeout(()=>{ta.focus();ta.setSelectionRange(ta.value.length,ta.value.length);},0);
    }

    createNoteEditor(wx,wy,existing=null) {
      const screen=this.worldToScreen(existing?.x??wx,existing?.y??wy),rect=this.container.getBoundingClientRect();
      screen.x+=rect.left;screen.y+=rect.top;
      const ta=document.createElement('textarea');ta.className='text-editor note-text-editor';ta.value=existing?.text||'';ta.placeholder='Markdown 便签：# 标题、**粗体**、- 列表…';ta.style.left=`${screen.x}px`;ta.style.top=`${screen.y}px`;ta.style.width=`${(existing?.w||180)*this.scale}px`;ta.style.height=`${(existing?.h||130)*this.scale}px`;
      if(existing)this.transformTextEditor(ta,existing);document.body.append(ta);setTimeout(()=>ta.focus(),0);let done=false;
      const finish=()=>{if(done)return;done=true;const text=ta.value.trim();if(text){if(existing){existing.text=text;}else{const el={id:newId(),type:'note',x:wx,y:wy,w:180,h:130,text,color:this.currentColor,bgColor:this.theme==='dark'?'#6f5b20':'#fff0a6',fontSize:15};this.elements.push(el);this.setSelection([el]);}this.commit();this.setTool('select');}ta.remove();this.render();};
      ta.addEventListener('blur',finish);ta.addEventListener('keydown',e=>{if(e.key==='Escape'){done=true;ta.remove();this.render();}});
    }

    editTextElement(el){if(el.type==='mindnode')return this.editMindNode(el,false);this.createTextEditor(el.x,el.y,el.type==='note',el);}

    // ---------- image ----------
    async initWindowContext() {
      if (!globalThis.chrome?.windows?.getCurrent) return;
      try { this.windowId=(await chrome.windows.getCurrent()).id ?? null; } catch { this.windowId=null; }
    }

    pendingCaptureKey() { return `quickdraw_pending_capture:${this.windowId ?? 'default'}`; }

    setupImageHandlers() {
      $('#btn-upload-img').addEventListener('click',()=>$('#file-input').click());
      $('#file-input').addEventListener('change',e=>{const f=e.target.files?.[0];if(f)this.insertImage(f).catch(error=>this.handleImageError(error));e.target.value='';});
      window.addEventListener('paste',e=>{
        if(e.defaultPrevented||this.isTextEditingTarget(e.target)||this.isTextEditingTarget(document.activeElement)||$$('[role="dialog"]').some(dialog=>!dialog.hidden))return;
        for(const item of e.clipboardData?.items||[]){if(item.type.startsWith('image/')){const f=item.getAsFile();if(f){e.preventDefault();this.insertImage(f).catch(error=>this.handleImageError(error));return;}}}
      });
      this.container.addEventListener('dragover',e=>{e.preventDefault();});
      this.container.addEventListener('drop',e=>{e.preventDefault();const p=this.eventPos(e);const f=[...(e.dataTransfer?.files||[])].find(x=>x.type.startsWith('image/'));if(f)this.insertImage(f,p.x,p.y).catch(error=>this.handleImageError(error));else{const u=(e.dataTransfer?.getData('text/uri-list')||e.dataTransfer?.getData('text/plain')||'').trim();if(u)this.insertRemoteImage(u,p.x,p.y);}});
      if(globalThis.chrome?.storage?.onChanged)chrome.storage.onChanged.addListener((changes,area)=>{
        const key=this.pendingCaptureKey();
        if(area==='session'&&changes[key]?.newValue)this.consumePendingCapture(changes[key].newValue);
        if(area==='local'&&changes.pending_image?.newValue)this.consumePendingCapture({kind:'image-url',url:changes.pending_image.newValue});
      });
    }

    fileToDataUrl(file){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(file);});}

    async ensureHostPermission(url) {
      if(!globalThis.chrome?.permissions||!/^https?:/i.test(url))return true;
      const origin=`${new URL(url).origin}/*`;
      return chrome.permissions.request({origins:[origin]});
    }

    async insertRemoteImage(url,x,y,sourceUrl=url,permissionGranted=false){
      try{if(url.startsWith('data:image'))return this.insertImage(url,x,y,{sourceUrl});if(!permissionGranted&&!await this.ensureHostPermission(url))throw new Error('permission-denied');const r=await fetch(url);if(!r.ok)throw new Error(`HTTP ${r.status}`);return this.insertImage(await r.blob(),x,y,{sourceUrl});}catch(error){this.handleImageError(error);}
    }

    async checkPendingCapture(){
      const key=this.pendingCaptureKey();
      if(globalThis.chrome?.storage?.session){const r=await this.store.get([key],'session');if(r[key])await this.consumePendingCapture(r[key]);}
      if(globalThis.chrome?.storage?.local){const legacy=await this.storageGet(['pending_image']);if(legacy.pending_image){await this.storageRemove(['pending_image']);await this.consumePendingCapture({kind:'image-url',url:legacy.pending_image});}}
    }

    async consumePendingCapture(payload){
      if(!payload)return;const key=this.pendingCaptureKey();
      if(globalThis.chrome?.storage?.session)await this.store.remove([key],'session').catch(()=>{});
      if(payload.kind==='error'){this.toast(payload.message||'网页内容采集失败。');return;}
      if(payload.kind==='selection'){const text=String(payload.text||'').trim();if(!text)return;this.insertNoteAtCenter(`${text}${payload.sourceUrl?`\n\n[来源](${payload.sourceUrl})`:''}`,{sourceUrl:payload.sourceUrl});return;}
      if(payload.kind==='asset')return this.insertStoredImage(payload.assetId,null,null,{sourceUrl:payload.sourceUrl}).catch(error=>this.handleImageError(error));
      if(payload.kind==='screenshot'||payload.kind==='image-data')return this.insertImage(payload.data,null,null,{sourceUrl:payload.sourceUrl}).catch(error=>this.handleImageError(error));
      if(payload.kind==='image-url')return this.insertRemoteImage(payload.url,null,null,payload.sourceUrl||payload.url,!!payload.permissionGranted);
    }

    insertNoteAtCenter(text,meta={}){
      const x=(this.width/2-this.offsetX)/this.scale-90,y=(this.height/2-this.offsetY)/this.scale-65;
      const el={id:newId(),type:'note',x,y,w:220,h:150,text,color:this.currentColor,bgColor:this.theme==='dark'?'#6f5b20':'#fff0a6',fontSize:15,...meta};
      this.elements.push(el);this.setSelection([el]);this.setTool('select');this.commit();this.render();
    }

    handleImageError(error){const message=String(error?.message||error||'');if(message.includes('permission'))this.toast('未获得该网站的图片读取权限。');else if(message.includes('large'))this.toast('图片过大：请选择 25 MB、5000 万像素以内的图片。');else if(message.includes('type'))this.toast('文件不是可识别的图片。');else this.toast('图片读取失败，可尝试复制图片后粘贴。');}

    backgroundRemovalProgress(update,prefix=''){
      const messages={signature:'正在获取匿名上传凭证…',uploading:'正在上传图片…',creating:'正在创建抠图任务…',downloading:'正在获取透明图片…'};
      if(messages[update?.state]){this.toast(`${prefix}${messages[update.state]}`);return;}
      if(update?.state==='processing'){
        const queue=Number(update.position)||0,progress=Number(update.progress)||0;
        this.toast(`${prefix}${queue>0?`抠图排队中：前面 ${queue} 个任务…`:progress>0?`AI 抠图处理中 ${Math.min(100,Math.round(progress))}%…`:'AI 抠图处理中…'}`);
      }
    }

    async imageBlobToPng(blob){
      if(blob.type==='image/png')return blob;
      let source;
      try{
        source=await this.loadCropDrawable(blob);const canvas=document.createElement('canvas');canvas.width=source.width;canvas.height=source.height;const context=canvas.getContext('2d');if(!context)throw new Error('canvas-unavailable');context.drawImage(source.drawable,0,0);return await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('png-encode-failed')),'image/png'));
      }finally{source?.dispose?.();}
    }

    async removeSelectedImageBackground(){
      const selected=this.getSelectedElements(),targets=selected.filter(element=>element.type==='image');
      if(!targets.length||targets.length!==selected.length){this.toast('请只选择一张或多张图片。');return;}
      if(this.backgroundRemovalInProgress){this.toast('已有抠图任务正在处理。');return;}
      if(this.cropTarget){this.cropSession+=1;this.cropTarget=null;this.cropStart=null;this.cropDrag=null;this.cropRect=null;this.container.style.cursor='';this.container.classList.remove('crop-mode');}
      if(this.watermarkTarget){this.watermarkSession+=1;this.watermarkTarget=null;this.watermarkStart=null;this.watermarkRect=null;this.container.classList.remove('watermark-mode');}
      this.backgroundRemovalInProgress=true;this.updateHistoryUI();let succeeded=0,failed=0,lastError='';
      try{
        for(let index=0;index<targets.length;index+=1){
          const target=targets[index],prefix=targets.length>1?`[${index+1}/${targets.length}] `:'';
          try{
            if(!this.elements.includes(target))throw new Error('图片已从画布移除。');
            const record=await this.store.getAsset(target.assetId);if(!record?.blob)throw new Error('图片资源不存在。');
            const dimensions=await this.decodeImageBlob(record.blob);
            const result=await this.koukoutuClient.removeBackground(record.blob,dimensions,update=>this.backgroundRemovalProgress(update,prefix));
            const png=await this.imageBlobToPng(result);
            if(!this.elements.includes(target))throw new Error('图片已从画布移除。');
            const oldAssetId=target.assetId,newAssetId=await this.store.putAsset(png,{sourceUrl:target.sourceUrl||'',backgroundRemovedFrom:oldAssetId,service:'koukoutu'});
            target.assetId=newAssetId;this.imageCache.delete(oldAssetId);this.getCachedImage(target);this.commit();this.render();succeeded+=1;
          }catch(error){failed+=1;lastError=error?.message||'抠图失败';console.error(`Quickdraw background removal failed (${index+1}/${targets.length})`,error);this.toast(`${prefix}${lastError}，继续处理下一张…`);}
        }
      }finally{
        this.backgroundRemovalInProgress=false;this.setSelection(targets.filter(target=>this.elements.includes(target)),false);this.updateHistoryUI();this.render();
      }
      if(succeeded&&failed)this.toast(`批量抠图完成：成功 ${succeeded} 张，失败 ${failed} 张。`);
      else if(succeeded)this.toast(targets.length>1?`批量抠图完成，共 ${succeeded} 张。`:'背景已移除，可使用撤销恢复。');
      else this.toast(lastError||'抠图失败，请稍后重试。');
    }

    startWatermarkRemoval(){
      const selected=this.getSelectedElements(),target=selected.length===1&&selected[0].type==='image'?selected[0]:null;
      if(!target){this.toast('请先单独选择一张图片。');return;}
      if(this.backgroundRemovalInProgress||this.watermarkRemovalInProgress){this.toast('图片处理任务正在进行中。');return;}
      if(this.watermarkTarget===target){this.cancelWatermarkRemoval();return;}
      if(this.cropTarget){this.cropSession+=1;this.cropTarget=null;this.cropStart=null;this.cropDrag=null;this.cropRect=null;this.container.style.cursor='';this.container.classList.remove('crop-mode');}
      this.closePopovers();this.watermarkSession+=1;this.watermarkTarget=target;this.watermarkStart=null;this.watermarkRect=null;this.container.classList.add('watermark-mode');this.updateHistoryUI();this.render();this.toast('在图片内部拖拽框选水印区域 · Esc 取消');
    }

    cancelWatermarkRemoval(notify=false){
      this.watermarkSession+=1;this.watermarkTarget=null;this.watermarkStart=null;this.watermarkRect=null;this.container.classList.remove('watermark-mode');this.updateHistoryUI();this.render();if(notify)this.toast('已取消去水印。');
    }

    ensureOpenCvSandbox(){
      if(this.openCvSandbox?.contentWindow&&this.openCvSandbox.dataset.ready==='true')return Promise.resolve(this.openCvSandbox);
      if(this.openCvSandboxReadyPromise)return this.openCvSandboxReadyPromise;
      this.openCvSandbox=document.createElement('iframe');this.openCvSandbox.id='quickdraw-opencv-sandbox';this.openCvSandbox.hidden=true;this.openCvSandbox.src=globalThis.chrome?.runtime?.getURL?chrome.runtime.getURL('opencv-sandbox.html'):'opencv-sandbox.html';
      this.openCvSandboxReadyPromise=new Promise((resolve,reject)=>{
        const frame=this.openCvSandbox;let settled=false;const timeout=setTimeout(()=>finish(new Error('OpenCV 加载超时。')),45_000);
        const onMessage=event=>{if(event.source!==frame.contentWindow||event.data?.channel!=='quickdraw-opencv')return;if(event.data.type==='ready')finish();else if(event.data.type==='startup-error')finish(new Error(event.data.message||'OpenCV 初始化失败。'));};
        const finish=error=>{if(settled)return;settled=true;clearTimeout(timeout);window.removeEventListener('message',onMessage);if(error){frame.remove();this.openCvSandbox=null;this.openCvSandboxReadyPromise=null;reject(error);}else{frame.dataset.ready='true';resolve(frame);}};
        window.addEventListener('message',onMessage);document.body.append(frame);
      });
      return this.openCvSandboxReadyPromise;
    }

    async runTeleaInSandbox(imageData,region){
      const frame=await this.ensureOpenCvSandbox(),requestId=newId();
      return new Promise((resolve,reject)=>{
        let settled=false;const timeout=setTimeout(()=>finish(new Error('Telea 修复超时。')),60_000);
        const onMessage=event=>{if(event.source!==frame.contentWindow||event.data?.channel!=='quickdraw-opencv'||event.data.requestId!==requestId)return;if(event.data.type==='result')finish(null,new Uint8ClampedArray(event.data.pixels));else if(event.data.type==='error')finish(new Error(event.data.message||'Telea 修复失败。'));};
        const finish=(error,pixels)=>{if(settled)return;settled=true;clearTimeout(timeout);window.removeEventListener('message',onMessage);error?reject(error):resolve(pixels);};
        window.addEventListener('message',onMessage);const pixels=imageData.data.buffer;frame.contentWindow.postMessage({channel:'quickdraw-opencv',type:'inpaint',requestId,width:imageData.width,height:imageData.height,region,pixels},'*',[pixels]);
      });
    }

    async applyWatermarkRemoval(rect){
      const target=this.watermarkTarget,session=this.watermarkSession;if(!target||!this.elements.includes(target))return this.cancelWatermarkRemoval();
      this.watermarkRemovalInProgress=true;this.updateHistoryUI();let source;
      try{
        const record=await this.store.getAsset(target.assetId);if(!record?.blob)throw new Error('图片资源不存在。');
        source=await this.loadCropDrawable(record.blob);if(this.watermarkSession!==session||this.watermarkTarget!==target)return;
        const bounds=this.getRawElementBBox(target),scaleX=source.width/bounds.w,scaleY=source.height/bounds.h;
        let x0=Math.floor((rect.x-bounds.x)*scaleX),y0=Math.floor((rect.y-bounds.y)*scaleY),x1=Math.ceil((rect.x+rect.w-bounds.x)*scaleX),y1=Math.ceil((rect.y+rect.h-bounds.y)*scaleY);
        const maskPadding=2;x0=clamp(x0-maskPadding,0,source.width-1);y0=clamp(y0-maskPadding,0,source.height-1);x1=clamp(x1+maskPadding,x0+1,source.width);y1=clamp(y1+maskPadding,y0+1,source.height);
        const maskWidth=x1-x0,maskHeight=y1-y0,margin=Math.min(192,Math.max(32,Math.ceil(Math.max(maskWidth,maskHeight)*.35)));
        const roiX=Math.max(0,x0-margin),roiY=Math.max(0,y0-margin),roiRight=Math.min(source.width,x1+margin),roiBottom=Math.min(source.height,y1+margin),roiWidth=roiRight-roiX,roiHeight=roiBottom-roiY;
        if(source.width>16384||source.height>16384)throw new Error('图片尺寸过大，暂不支持去水印。');
        if(roiWidth*roiHeight>12_000_000)throw new Error('框选区域过大，请缩小到水印附近。');
        const roiCanvas=document.createElement('canvas');roiCanvas.width=roiWidth;roiCanvas.height=roiHeight;const roiContext=roiCanvas.getContext('2d',{willReadFrequently:true});if(!roiContext)throw new Error('无法读取图片像素。');roiContext.drawImage(source.drawable,roiX,roiY,roiWidth,roiHeight,0,0,roiWidth,roiHeight);const imageData=roiContext.getImageData(0,0,roiWidth,roiHeight);
        this.toast('正在加载 Telea 快速修复组件…');const region={x0:x0-roiX,y0:y0-roiY,x1:x1-roiX,y1:y1-roiY};const pixels=await this.runTeleaInSandbox(imageData,region);if(this.watermarkSession!==session||this.watermarkTarget!==target)return;roiContext.putImageData(new ImageData(pixels,roiWidth,roiHeight),0,0);
        const output=document.createElement('canvas');output.width=source.width;output.height=source.height;const outputContext=output.getContext('2d');if(!outputContext)throw new Error('无法生成修复图片。');outputContext.drawImage(source.drawable,0,0);outputContext.drawImage(roiCanvas,roiX,roiY);
        const blob=await new Promise((resolve,reject)=>output.toBlob(value=>value?resolve(value):reject(new Error('修复图片编码失败。')),'image/png'));if(this.watermarkSession!==session||this.watermarkTarget!==target||!this.elements.includes(target))return;
        const oldAssetId=target.assetId,newAssetId=await this.store.putAsset(blob,{sourceUrl:target.sourceUrl||'',watermarkRemovedFrom:oldAssetId,method:'opencv-telea'});if(this.watermarkSession!==session||this.watermarkTarget!==target||!this.elements.includes(target))return;target.assetId=newAssetId;this.imageCache.delete(oldAssetId);this.watermarkTarget=null;this.watermarkStart=null;this.watermarkRect=null;this.container.classList.remove('watermark-mode');this.setSelection([target],false);this.getCachedImage(target);this.commit();this.render();this.toast('水印区域已使用 Telea 修复，可撤销恢复。');
      }catch(error){console.error('Quickdraw Telea watermark removal failed',error);this.watermarkRect=null;this.toast(error?.message||'去水印失败，请重新框选。');this.render();}
      finally{source?.dispose?.();this.watermarkRemovalInProgress=false;this.updateHistoryUI();}
    }

    cropHandles(){
      if(!this.cropTarget||!this.cropRect)return [];
      return this.selectionHandlesForBBox(this.cropRect).map(h=>({...h,...QDVector.point(QDVector.matrix(this.cropTarget),h)}));
    }

    beginCropDrag(e){
      if(this.cropApplyingSession!=null&&this.cropApplyingSession===this.cropSession){this.pointerDown=false;return;}
      const target=this.cropTarget,bounds=this.getRawElementBBox(target),world=this.eventPos(e),p=this.imageLocalPoint(target,world),rect=this.cropRect;
      const handle=this.cropHandles().find(h=>Math.hypot(h.x-world.x,h.y-world.y)<=9/this.scale);
      if(!handle&&(p.x<bounds.x||p.x>bounds.x+bounds.w||p.y<bounds.y||p.y>bounds.y+bounds.h)){this.pointerDown=false;return;}
      this.captureInteractionPointer(e.pointerId);
      const inside=rect&&p.x>=rect.x&&p.x<=rect.x+rect.w&&p.y>=rect.y&&p.y<=rect.y+rect.h;
      this.cropDrag={mode:handle?'resize':inside?'move':'new',handle:handle?.name,start:p,rect:rect?{...rect}:null};
      if(this.cropDrag.mode==='new'){this.cropStart=p;this.cropRect={x:p.x,y:p.y,w:0,h:0};}
      this.render();
    }

    moveCropDrag(e){
      const world=this.eventPos(e),p=this.imageLocalPoint(this.cropTarget,world),d=this.cropDrag,b=this.getRawElementBBox(this.cropTarget);
      if(!d){const handle=this.cropHandles().find(h=>Math.hypot(h.x-world.x,h.y-world.y)<=9/this.scale),r=this.cropRect;this.container.style.cursor=handle?({n:'ns-resize',s:'ns-resize',e:'ew-resize',w:'ew-resize',ne:'nesw-resize',sw:'nesw-resize',nw:'nwse-resize',se:'nwse-resize'}[handle.name]):r&&p.x>=r.x&&p.x<=r.x+r.w&&p.y>=r.y&&p.y<=r.y+r.h?'move':'crosshair';return;}
      if(d.mode==='new')this.cropRect=QDVector.cropRect(d.start,{x:clamp(p.x,b.x,b.x+b.w),y:clamp(p.y,b.y,b.y+b.h)},b,this.cropRatio||0);
      else if(d.mode==='move'){const r=d.rect;this.cropRect={...r,x:clamp(r.x+p.x-d.start.x,b.x,b.x+b.w-r.w),y:clamp(r.y+p.y-d.start.y,b.y,b.y+b.h-r.h)};}
      else{
        const r=d.rect,h=d.handle,ratio=this.cropRatio||0,min=1e-4,dx=p.x-d.start.x,dy=p.y-d.start.y;
        let left=r.x,right=r.x+r.w,top=r.y,bottom=r.y+r.h;
        if(h.includes('w'))left=clamp(r.x+dx,b.x,right-min);if(h.includes('e'))right=clamp(r.x+r.w+dx,left+min,b.x+b.w);
        if(h.includes('n'))top=clamp(r.y+dy,b.y,bottom-min);if(h.includes('s'))bottom=clamp(r.y+r.h+dy,top+min,b.y+b.h);
        if(ratio&&h.length===2){const anchor={x:h.includes('w')?r.x+r.w:r.x,y:h.includes('n')?r.y+r.h:r.y};this.cropRect=QDVector.cropRect(anchor,{x:h.includes('w')?left:right,y:h.includes('n')?top:bottom},b,ratio);}
        else if(ratio&&['n','s'].includes(h)){const cx=r.x+r.w/2,anchor=h==='n'?r.y+r.h:r.y,available=h==='n'?anchor-b.y:b.y+b.h-anchor,height=Math.min(bottom-top,available,2*Math.min(cx-b.x,b.x+b.w-cx)/ratio);this.cropRect={x:cx-height*ratio/2,y:h==='n'?anchor-height:anchor,w:height*ratio,h:height};}
        else if(ratio){const cy=r.y+r.h/2,anchor=h==='w'?r.x+r.w:r.x,available=h==='w'?anchor-b.x:b.x+b.w-anchor,width=Math.min(right-left,available,2*Math.min(cy-b.y,b.y+b.h-cy)*ratio);this.cropRect={x:h==='w'?anchor-width:anchor,y:cy-width/ratio/2,w:width,h:width/ratio};}
        else this.cropRect={x:left,y:top,w:right-left,h:bottom-top};
      }
      this.render();
    }

    endCropDrag(e){
      const previous=this.cropDrag.rect,rect=this.cropRect;this.cropDrag=null;this.cropStart=null;this.pointerDown=false;
      if(e?.type==='pointercancel')this.cropRect=previous;
      else if(!rect||rect.w<8/this.scale||rect.h<8/this.scale){this.cropRect=previous;this.toast('请拖出有效的裁剪区域。');}
      this.render();
    }

    startImageCrop(){const selected=this.getSelectedElements();if(selected.length!==1||selected[0].type!=='image'){this.toast('请先单独选择一张图片。');return;}if(this.cropTarget===selected[0]){this.cancelImageCrop();return;}if(this.watermarkTarget){this.watermarkSession+=1;this.watermarkTarget=null;this.watermarkStart=null;this.watermarkRect=null;this.container.classList.remove('watermark-mode');}this.closePopovers();this.cropSession++;this.cropTarget=selected[0];this.cropStart=null;this.cropDrag=null;this.cropRect=null;this.container.style.cursor='';this.container.classList.add('crop-mode');this.updateHistoryUI();this.render();this.toast('拖拽框选后可移动或调整裁剪框 · 框内双击确认 · Esc 取消');}

    cancelImageCrop(notify=false){if(this.cropDrag){this.pointerDown=false;this.releaseInteractionPointer();}this.cropSession++;this.cropTarget=null;this.cropStart=null;this.cropDrag=null;this.cropRect=null;this.container.style.cursor='';this.container.classList.remove('crop-mode');this.updateHistoryUI();this.render();if(notify)this.toast('已取消图片裁剪。');}

    async loadCropDrawable(blob){
      if(globalThis.createImageBitmap){try{const bitmap=await createImageBitmap(blob);return{drawable:bitmap,width:bitmap.width,height:bitmap.height,dispose:()=>bitmap.close?.()};}catch{}}
      const url=URL.createObjectURL(blob);try{const image=await new Promise((resolve,reject)=>{const value=new Image();value.onload=()=>resolve(value);value.onerror=()=>reject(new Error('image-decode-failed'));value.src=url;});return{drawable:image,width:image.naturalWidth,height:image.naturalHeight,dispose:()=>URL.revokeObjectURL(url)};}catch(error){URL.revokeObjectURL(url);throw error;}
    }

    async applyImageCrop(rect){
      const target=this.cropTarget,session=this.cropSession;if(!target||!this.elements.includes(target))return this.cancelImageCrop();
      if(this.cropApplyingSession!=null&&this.cropApplyingSession===session)return;this.cropApplyingSession=session;
      let source;
      try{
        const record=await this.store.getAsset(target.assetId);if(!record?.blob)throw new Error('missing-asset');source=await this.loadCropDrawable(record.blob);if(this.cropSession!==session||this.cropTarget!==target)return;const bounds=this.getRawElementBBox(target),rx=clamp((rect.x-bounds.x)/bounds.w,0,1),ry=clamp((rect.y-bounds.y)/bounds.h,0,1),rw=clamp(rect.w/bounds.w,0,1-rx),rh=clamp(rect.h/bounds.h,0,1-ry),sx=rx*source.width,sy=ry*source.height,sw=Math.max(1,rw*source.width),sh=Math.max(1,rh*source.height),outputScale=Math.min(1,16384/sw,16384/sh,Math.sqrt(50_000_000/(sw*sh))),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(sw*outputScale));canvas.height=Math.max(1,Math.round(sh*outputScale));const context=canvas.getContext('2d');if(!context)throw new Error('canvas-unavailable');context.drawImage(source.drawable,sx,sy,sw,sh,0,0,canvas.width,canvas.height);const blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('crop-encode-failed')),'image/png'));if(this.cropSession!==session||this.cropTarget!==target||!this.elements.includes(target))return;const oldAssetId=target.assetId,newAssetId=await this.store.putAsset(blob,{sourceUrl:target.sourceUrl||'',croppedFrom:oldAssetId});if(this.cropSession!==session||this.cropTarget!==target)return;target.assetId=newAssetId;target.x=rect.x;target.y=rect.y;target.w=rect.w;target.h=rect.h;this.imageCache.delete(oldAssetId);this.cancelImageCrop();this.setSelection([target],false);this.getCachedImage(target);this.commit();this.render();this.toast('图片已裁剪，可使用撤销恢复。');
      }catch(error){console.error(error);this.toast('图片裁剪失败，请重新选择区域。');this.render();}finally{source?.dispose?.();if(this.cropApplyingSession===session)this.cropApplyingSession=null;}
    }

    async decodeImageBlob(blob){
      if(!blob?.type?.startsWith('image/'))throw new Error('invalid-type');if(blob.size>25*1024*1024)throw new Error('image-too-large');const url=URL.createObjectURL(blob);
      try{return await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>img.naturalWidth*img.naturalHeight>50_000_000?reject(new Error('image-too-large')):resolve({width:img.naturalWidth,height:img.naturalHeight});img.onerror=()=>reject(new Error('invalid-type'));img.src=url;});}finally{URL.revokeObjectURL(url);}
    }

    async migrateImageAssets(){let changed=false;for(const el of this.elements.filter(item=>item.type==='image'&&!item.assetId&&item.src?.startsWith('data:image'))){try{const blob=await this.store.dataUrlToBlob(el.src);el.assetId=await this.store.putAsset(blob,{migrated:true});delete el.src;changed=true;}catch{}}return changed;}

    async preloadImages(){await Promise.all(this.elements.filter(el=>el.type==='image').map(el=>new Promise(resolve=>{const img=this.getCachedImage(el);if(img?.complete)return resolve();const done=()=>resolve();img?.addEventListener('load',done,{once:true});img?.addEventListener('error',done,{once:true});setTimeout(done,2000);})));this.render();}

    async insertStoredImage(assetId,x,y,meta={},knownDimensions=null){
      let dimensions=knownDimensions;if(!dimensions){const record=await this.store.getAsset(assetId);if(!record?.blob)throw new Error('missing-asset');dimensions=await this.decodeImageBlob(record.blob);}
      let w=dimensions.width||300,h=dimensions.height||200;const max=420;if(w>max||h>max){const s=Math.min(max/w,max/h);w*=s;h*=s;}if(x==null||y==null){x=(this.width/2-this.offsetX)/this.scale-w/2;y=(this.height/2-this.offsetY)/this.scale-h/2;}
      const el={id:newId(),type:'image',assetId,x,y,w,h,sourceUrl:meta.sourceUrl||''};this.elements.push(el);this.getCachedImage(el);this.setSelection([el]);this.setTool('select');this.commit();this.render();return el;
    }

    async insertStoredImages(items, x, y, meta = {}) {
      const source = Array.isArray(items) ? items : [];
      if (!source.length) throw new Error('missing-asset');
      const prepared = [];
      // Resolve and decode every asset before changing the document. This
      // keeps a missing second image from leaving a partially inserted group.
      for (const item of source) {
        const assetId = String(item?.assetId || '').trim();
        if (!assetId) throw new Error('missing-asset');
        const record = await this.store.getAsset(assetId);
        if (!record?.blob) throw new Error('missing-asset');
        let dimensions = item.imageWidth > 0 && item.imageHeight > 0 ? { width: item.imageWidth, height: item.imageHeight } : null;
        if (!dimensions) {
          dimensions = await this.decodeImageBlob(record.blob);
        }
        let w = dimensions.width || 300, h = dimensions.height || 200;
        const max = 420;
        if (w > max || h > max) { const scale = Math.min(max / w, max / h); w *= scale; h *= scale; }
        prepared.push({ item, assetId, w, h });
      }
      const gap = 24;
      const totalWidth = prepared.reduce((sum, item) => sum + item.w, 0) + gap * Math.max(0, prepared.length - 1);
      const maxHeight = Math.max(...prepared.map(item => item.h));
      let cursorX = x, cursorY = y;
      if (cursorX == null || cursorY == null) {
        cursorX = (this.width / 2 - this.offsetX) / this.scale - totalWidth / 2;
        cursorY = (this.height / 2 - this.offsetY) / this.scale - maxHeight / 2;
      }
      const elements = prepared.map(({ item, assetId, w, h }) => {
        const element = { id: newId(), type: 'image', assetId, x: cursorX, y: cursorY, w, h, sourceUrl: String(item.imageUrl || meta.sourceUrl || '') };
        cursorX += w + gap;
        this.elements.push(element);
        this.getCachedImage(element);
        return element;
      });
      this.setSelection(elements, false);
      this.setTool('select');
      this.commit();
      this.render();
      return elements;
    }

    async insertImage(source,x,y,meta={}){
      const blob=source instanceof Blob?source:await this.store.dataUrlToBlob(source),dimensions=await this.decodeImageBlob(blob),assetId=await this.store.putAsset(blob,{name:source?.name||'',sourceUrl:meta.sourceUrl||''});return this.insertStoredImage(assetId,x,y,meta,dimensions);
    }

    savePreferences(){return this.storageSet({[this.PREF_KEY]:{theme:this.theme,grid:this.gridType,mindStyle:this.currentMindStyle,snapToGrid:this.snapToGrid,aiProvider:this.aiProvider}});}

    toggleMindCollapse(){const node=this.getMindFocus();if(!node){this.toast('请先选择一个思维导图节点。');return;}node.collapsed=!node.collapsed;this.setSelection([node],false);this.commit();this.render();this.toast(node.collapsed?'分支已折叠。':'分支已展开。');}

    autoLayoutMind(){
      let root=this.getMindFocus();if(root)while(root.parentId){const parent=this.elements.find(node=>node.id===root.parentId&&node.type==='mindnode');if(!parent)break;root=parent;}else root=this.elements.find(node=>node.type==='mindnode'&&!node.parentId&&!node.mermaid);
      if(!root){this.toast('没有可整理的思维导图。');return;}const children=new Map();for(const node of this.elements.filter(el=>el.type==='mindnode'&&!el.mermaid)){if(!children.has(node.parentId||''))children.set(node.parentId||'',[]);children.get(node.parentId||'').push(node);}let cursor=0;const positions=new Map();
      const visit=(node,depth)=>{const list=children.get(node.id)||[];if(!list.length){positions.set(node.id,{x:depth*220,y:cursor});cursor+=(node.h||44)+24;return;}for(const child of list)visit(child,depth+1);const first=positions.get(list[0].id),last=positions.get(list.at(-1).id);positions.set(node.id,{x:depth*220,y:(first.y+last.y)/2});};visit(root,0);const anchor=positions.get(root.id),shiftY=root.y-anchor.y;for(const [id,p] of positions){const node=this.elements.find(el=>el.id===id);if(node){node.x=root.x+p.x;node.y=p.y+shiftY;}}this.commit();this.render();
    }

    openSearchDialog(){this.closePopovers();$('#search-dialog').hidden=false;const input=$('#search-input');input.value='';this.renderSearchResults('');setTimeout(()=>input.focus(),0);}
    closeSearchDialog(){$('#search-dialog').hidden=true;this.container.focus({preventScroll:true});}
    renderSearchResults(query){
      const root=$('#search-results'),needle=String(query||'').trim().toLowerCase();root.textContent='';const candidates=this.elements.filter(el=>['text','note','mindnode'].includes(el.type)&&(!needle||String(el.text||'').toLowerCase().includes(needle))).slice(0,100);
      if(!candidates.length){const empty=document.createElement('div');empty.className='utility-empty';empty.textContent=needle?'没有匹配内容。':'输入关键词，或浏览全部文字对象。';root.append(empty);return;}
      for(const el of candidates){const row=document.createElement('button');row.className='utility-row';const kind=document.createElement('span');kind.className='utility-row-kind';kind.textContent=el.type==='mindnode'?'节点':el.type==='note'?'便签':'文本';const text=document.createElement('span');text.className='utility-row-text';text.textContent=String(el.text||'').replace(/\s+/g,' ').slice(0,120)||'（空）';row.append(kind,text);row.addEventListener('click',()=>{this.focusElement(el);this.closeSearchDialog();});root.append(row);}
    }

    focusElement(el){let expanded=false,current=el;while(current?.parentId){const parent=this.elements.find(item=>item.id===current.parentId&&item.type==='mindnode');if(!parent)break;if(parent.collapsed){parent.collapsed=false;expanded=true;}current=parent;}const b=this.getElementBBox(el);if(!b)return;this.setSelection([el],false);this.offsetX=this.width/2-(b.x+b.w/2)*this.scale;this.offsetY=this.height/2-(b.y+b.h/2)*this.scale;if(expanded)this.commit();else this.scheduleSave();this.render();}

    async openVersionsDialog(){
      await this.saveFileNow();this.closePopovers();const root=$('#versions-list');root.textContent='';const versions=await this.store.listVersions(this.currentFileId);if(!versions.length){root.innerHTML='<div class="utility-empty">还没有可恢复的历史版本。</div>';}for(const version of versions){const row=document.createElement('button');row.className='utility-row';const kind=document.createElement('span');kind.className='utility-row-kind';kind.textContent='版本';const text=document.createElement('span');text.className='utility-row-text';text.textContent=new Date(version.createdAt).toLocaleString();row.append(kind,text);row.addEventListener('click',()=>this.restoreVersion(version));root.append(row);}$('#versions-dialog').hidden=false;
    }

    async restoreVersion(version){if(!version?.document||!confirm(`恢复到 ${new Date(version.createdAt).toLocaleString()}？`))return;await this.store.saveVersion(this.currentFileId,this.serializeDocument(),$('#file-name').value,true);this.elements=clone(version.document.elements||[]);this.aiTaskReceipts=new Map(Object.entries(version.document.aiTaskReceipts||{}).map(([taskId,receipt])=>[taskId,{...receipt,taskId}]));this.scale=version.document.camera?.scale||1;this.offsetX=version.document.camera?.offsetX||0;this.offsetY=version.document.camera?.offsetY||0;this.resetHistory();this.commit();await this.saveFileNow({snapshot:false});$('#versions-dialog').hidden=true;await this.preloadImages();this.render();this.toast('历史版本已恢复。');}

    async getExportDirectory(){
      try{return await this.store.getHandle(this.EXPORT_DIRECTORY_KEY);}catch(error){console.warn('Quickdraw export directory read failed',error);return null;}
    }

    async syncExportDirectoryUI(handle){
      if(arguments.length===0)handle=await this.getExportDirectory();
      const label=$('#export-directory-label');if(!label)return;
      label.textContent=handle?.name||'浏览器默认';label.title=handle?.name||'使用浏览器默认下载位置';
    }

    async setDefaultExportDirectory(){
      if(typeof window.showDirectoryPicker!=='function'){this.toast('当前浏览器不支持选择文件夹，将继续使用浏览器默认下载位置。');this.closePopovers();return;}
      try{
        const handle=await window.showDirectoryPicker({id:'quickdraw-export-directory',mode:'readwrite',startIn:'downloads'});
        await this.store.putHandle(this.EXPORT_DIRECTORY_KEY,handle);await this.syncExportDirectoryUI(handle);this.closePopovers();this.toast(`默认导出路径：${handle.name}`);
      }catch(error){if(error?.name!=='AbortError'){console.error(error);this.toast('默认导出路径设置失败。');}}
    }

    imageExtension(blob){
      const type=String(blob?.type||'').toLowerCase();if(type.includes('jpeg'))return 'jpg';if(type.includes('webp'))return 'webp';if(type.includes('gif'))return 'gif';if(type.includes('bmp'))return 'bmp';if(type.includes('svg'))return 'svg';return 'png';
    }

    assetFilename(record,index,used){
      let name=record?.name||'';
      if(!name&&record?.sourceUrl){try{name=decodeURIComponent(new URL(record.sourceUrl).pathname.split('/').pop()||'');}catch{}}
      const extension=this.imageExtension(record?.blob),dot=name.lastIndexOf('.');let base=dot>0?name.slice(0,dot):name;
      base=QDCore.safeFilename(base||`image-${String(index+1).padStart(3,'0')}`,'image');
      if(record?.backgroundRemovedFrom&&!base.endsWith('-抠图'))base+='-抠图';
      else if(record?.watermarkRemovedFrom&&!base.endsWith('-去水印'))base+='-去水印';
      else if(record?.croppedFrom&&!base.endsWith('-裁剪'))base+='-裁剪';
      const ext=`.${extension}`;name=`${base}${ext}`;let candidate=name,count=2;
      while(used.has(candidate.toLowerCase()))candidate=`${base}-${count++}${ext}`;
      used.add(candidate.toLowerCase());return candidate;
    }

    async exportImageAssets(){
      try{
        const images=this.elements.filter(element=>element.type==='image'&&element.assetId);
        if(!images.length){this.toast('当前画布没有可下载的图片。');return;}
        this.toast('正在整理画布当前图片…');const records=[];
        for(const image of images){const record=await this.store.getAsset(image.assetId);if(record?.blob)records.push(record);}
        if(!records.length)throw new Error('missing-assets');
        const used=new Set(),entries=records.map((record,index)=>({name:this.assetFilename(record,index,used),blob:record.blob,modifiedAt:new Date(record.createdAt||Date.now())}));
        if(entries.length===1){await this.downloadBlob(entries[0].blob,entries[0].name);this.toast('已下载画布中的当前图片。');return;}
        const zip=await QDZip.createZip(entries);await this.downloadBlob(zip,`${this.exportBaseName()}-画布图片.zip`);this.toast(`已打包 ${entries.length} 张当前图片。`);
      }catch(error){console.error('Quickdraw image asset export failed',error);this.toast(error?.message==='zip-too-large'?'图片资源总量过大，无法一次打包。':'画布图片下载失败。');}
    }

    async exportProject(){
      try{await this.saveFileNow();const stored=await this.storageGet([this.INDEX_KEY,...this.fileIndex.files.map(file=>this.fileKey(file.id))]),documents={},assetIds=[];for(const file of this.fileIndex.files){const doc=stored[this.fileKey(file.id)]||this.blankDocument();documents[file.id]=doc;for(const el of doc.elements||[])if(el.assetId)assetIds.push(el.assetId);}const project={format:'quickdraw-project',version:1,exportedAt:new Date().toISOString(),fileIndex:this.fileIndex,documents,assets:await this.store.exportAssets(assetIds)};await this.downloadBlob(new Blob([JSON.stringify(project)],{type:'application/json'}),`${QDCore.safeFilename($('#file-name').value)}.quickdraw`);this.toast('Quickdraw 项目已导出。');}catch(error){console.error(error);this.toast('项目导出失败。');}
    }

    async importProject(file){
      try{if(file.size>150*1024*1024)throw new Error('project-too-large');await this.saveFileNow();const project=JSON.parse(await file.text());if(project?.format!=='quickdraw-project'||!project.fileIndex?.files||!project.documents||project.fileIndex.files.length>500)throw new Error('invalid-project');const assetMap=new Map();for(const asset of project.assets||[])assetMap.set(asset.id,await this.store.importAsset(asset));let firstId=null;await this.store.withLock('documents',async()=>{const stored=await this.storageGet([this.INDEX_KEY]);const index=stored[this.INDEX_KEY]||this.fileIndex,values={};for(const sourceFile of project.fileIndex.files){const oldDoc=project.documents[sourceFile.id];if(!oldDoc||!Array.isArray(oldDoc.elements)||oldDoc.elements.length>100_000)continue;const fileId=`f${newId().slice(1)}`;firstId ||= fileId;const idMap=new Map(oldDoc.elements.map(el=>[el.id,newId()]));const elements=oldDoc.elements.map(el=>{const next=clone(el);next.id=idMap.get(el.id);if(idMap.has(el.parentId))next.parentId=idMap.get(el.parentId);if(idMap.has(el.fromId))next.fromId=idMap.get(el.fromId);if(idMap.has(el.toId))next.toId=idMap.get(el.toId);if(assetMap.has(el.assetId))next.assetId=assetMap.get(el.assetId);return next;});index.files.push({id:fileId,name:`${sourceFile.name||'导入画板'}（导入）`,updatedAt:Date.now()});values[this.fileKey(fileId)]={...oldDoc,version:4,revision:0,updatedBy:this.instanceId,elements};}if(!firstId)throw new Error('empty-project');index.current=firstId;values[this.INDEX_KEY]=index;await this.storageSet(values);this.fileIndex=index;});this.currentFileId=null;await this.openFile(firstId,true,true);this.toast('项目已导入为新的画板。');}catch(error){console.error(error);this.toast(error?.message==='project-too-large'?'项目文件过大，无法安全导入。':'项目文件无效或已损坏。');}
    }

    // ---------- UI ----------
    setupUI() {
      for(const button of $$('button[title]:not([aria-label])'))button.setAttribute('aria-label',button.title);
      const toggle=(id)=>{const el=$(id);const will=el.hidden;this.closePopovers();el.hidden=!will;if(!el.hidden&&id==='#menu-popover')this.positionMenuPopover();};
      $('#btn-clear-storage').addEventListener('click',()=>this.requestClearStorage());
      $('#files-btn').addEventListener('click',e=>{e.stopPropagation();this.renderFilesMenu();toggle('#files-menu');});
      $('#new-file-btn').addEventListener('click',()=>this.createFile());
      $('#btn-open-tab').addEventListener('click',()=>this.openCanvasTab());
      $('#btn-export-assets').addEventListener('click',()=>this.exportImageAssets());
      $('#file-name').addEventListener('input',()=>this.sizeFileName());
      $('#file-name').addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Enter')e.target.blur();if(e.key==='Escape'){const f=this.fileIndex.files.find(x=>x.id===this.currentFileId);e.target.value=f?.name||'Untitled';e.target.blur();}});
      $('#file-name').addEventListener('blur',async e=>{const f=this.fileIndex?.files?.find(x=>x.id===this.currentFileId);if(!f)return;const name=e.target.value.trim()||f.name;f.name=name;e.target.value=name;this.sizeFileName();await this.saveFileNow({snapshot:false}).catch(()=>{});});

      $$('.tool-btn[data-tool]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();this.setTool(b.dataset.tool);if(b.dataset.tool==='geo')toggle('#shape-popover');else this.closePopovers();}));
      $('#btn-mermaid').addEventListener('click',e=>{e.stopPropagation();this.openMermaidDialog();});
      $('#btn-ai-mindmap').addEventListener('click',e=>{e.stopPropagation();this.openAIMindmapDialog();});
      $('#btn-ai-edit')?.addEventListener('click',e=>{e.stopPropagation();this.openAIImageDialog();});
      $('#mermaid-cancel').addEventListener('click',()=>this.closeMermaidDialog());
      $('#mermaid-generate').addEventListener('click',()=>this.generateMermaidFromInput());
      $('#mermaid-dialog').addEventListener('pointerdown',e=>{if(e.target===$('#mermaid-dialog'))this.closeMermaidDialog();});
      $('#mermaid-input').addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();this.closeMermaidDialog();}else if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();this.generateMermaidFromInput();}});
      $('#btn-menu').addEventListener('click',e=>{e.stopPropagation();toggle('#menu-popover');});
      $('#btn-ai-pending').addEventListener('click',()=>this.openAIMindmapDialog(true));
      $('#btn-arrange').addEventListener('click',e=>{e.stopPropagation();toggle('#arrange-popover');});
      $$('.popover').forEach(p=>p.addEventListener('click',e=>e.stopPropagation()));
      document.addEventListener('pointerdown',e=>{if(!e.target.closest('.popover,.tool-btn,#files-btn'))this.closePopovers();});

      $$('.shape-option').forEach(b=>b.addEventListener('click',()=>{this.currentShape=b.dataset.shape;$$('.shape-option').forEach(x=>x.classList.toggle('active',x===b));this.setTool('geo');this.closePopovers();}));
      $$('.color-dot').forEach(b=>b.addEventListener('click',e=>{
        const hasMindNode=this.getSelectedElements().some(el=>el.type==='mindnode');
        if(e.shiftKey&&hasMindNode)this.setMindTextColor(b.dataset.color);
        else if((e.ctrlKey||e.metaKey)&&hasMindNode)this.setMindFillColor(b.dataset.color);
        else this.setStyle('color',b.dataset.color,b,'.color-dot');
      }));
      $$('.mind-text-color-dot').forEach(b=>b.addEventListener('click',()=>this.setMindTextColor(b.dataset.color)));
      $$('#mind-style-control button').forEach(b=>b.addEventListener('click',()=>this.setMindStyle(b.dataset.mindStyle)));
      const customColor=$('#custom-color');
      customColor.addEventListener('pointerdown',e=>{this.customColorMode=e.shiftKey?'text':((e.ctrlKey||e.metaKey)?'fill':'color');});
      customColor.addEventListener('input',e=>{
        const hasMindNode=this.getSelectedElements().some(el=>el.type==='mindnode');
        if(this.customColorMode==='text'&&hasMindNode)this.setMindTextColor(e.target.value);
        else if(this.customColorMode==='fill'&&hasMindNode)this.setMindFillColor(e.target.value);
        else this.setStyle('color',e.target.value,null,'.color-dot');
      });
      customColor.addEventListener('change',()=>{this.customColorMode='color';});
      $$('.size-option').forEach(b=>b.addEventListener('click',()=>{const level=Number(b.dataset.size);if(!this.setMindFontSizeLevel(level,b))this.setStyle('size',level,b,'.size-option');}));
      $$('.dash-option').forEach(b=>b.addEventListener('click',()=>this.setStyle('dash',b.dataset.dash,b,'.dash-option')));
      $$('.fill-option').forEach(b=>b.addEventListener('click',()=>this.setStyle('fill',b.dataset.fill,b,'.fill-option')));
      $$('.stroke-option').forEach(b=>b.addEventListener('click',()=>this.setStyle('stroke',b.dataset.stroke,b,'.stroke-option')));
      $$('[data-align]').forEach(b=>b.addEventListener('click',()=>this.alignSelected(b.dataset.align)));
      $$('[data-distribute]').forEach(b=>b.addEventListener('click',()=>this.distributeSelected(b.dataset.distribute)));
      $('#btn-layout-mind').addEventListener('click',()=>this.autoLayoutMind());
      $('#btn-collapse-mind').addEventListener('click',()=>this.toggleMindCollapse());

      $('#btn-undo').addEventListener('click',()=>this.undo());$('#btn-redo').addEventListener('click',()=>this.redo());$('#btn-duplicate').addEventListener('click',()=>this.duplicateSelected());$('#btn-clear-action').addEventListener('click',()=>this.requestClearBoard());
      $('#btn-remove-bg').addEventListener('click',()=>this.removeSelectedImageBackground());
      $('#btn-remove-watermark').addEventListener('click',()=>this.startWatermarkRemoval());
      $('#btn-crop').addEventListener('click',e=>{if(e.detail<2)this.beginRatioCrop(0);});
      $('#btn-crop').addEventListener('dblclick',e=>{e.preventDefault();this.cancelImageCrop();this.toggleEditingPopover('crop-popover');});
      $('#btn-zoom-in').addEventListener('click',()=>this.zoom(1.15));$('#btn-zoom-out').addEventListener('click',()=>this.zoom(.87));$('#btn-zoom-reset').addEventListener('click',()=>this.resetZoom());
      $('#btn-fit').addEventListener('click',()=>{this.fitContent();this.closePopovers();});
      $('#btn-clear').addEventListener('click',()=>this.requestClearBoard());
      $('#clear-cancel').addEventListener('click',()=>this.closeClearDialog());
      $('#clear-confirm').addEventListener('click',()=>this.confirmClearBoard());
      $('#clear-dialog').addEventListener('pointerdown',e=>{if(e.target===$('#clear-dialog'))this.closeClearDialog();});
      $('#storage-cancel').addEventListener('click',()=>this.closeStorageDialog());
      $('#storage-confirm').addEventListener('click',()=>this.confirmClearStorage());
      $('#storage-dialog').addEventListener('pointerdown',e=>{if(e.target===$('#storage-dialog'))this.closeStorageDialog();});
      $('#btn-export-png').addEventListener('click',()=>{this.exportPNG(false);this.closePopovers();});
      $('#btn-export-transparent').addEventListener('click',()=>{this.exportPNG(true);this.closePopovers();});
      $('#btn-export-svg').addEventListener('click',()=>{this.exportSVG();this.closePopovers();});
      $('#btn-export-directory').addEventListener('click',()=>this.setDefaultExportDirectory());
      $('#btn-copy-png').addEventListener('click',()=>{this.copyPNG();this.closePopovers();});
      $('#btn-copy-svg').addEventListener('click',()=>{this.copySVG();this.closePopovers();});
      $('#btn-export-project').addEventListener('click',()=>{this.exportProject();this.closePopovers();});
      $('#btn-import-project').addEventListener('click',()=>{$('#project-input').click();this.closePopovers();});
      $('#project-input').addEventListener('change',e=>{const file=e.target.files?.[0];if(file)this.importProject(file);e.target.value='';});
      $('#btn-versions').addEventListener('click',()=>this.openVersionsDialog().catch(()=>this.toast('版本历史读取失败。')));
      $('#versions-close').addEventListener('click',()=>{$('#versions-dialog').hidden=true;});
      $('#versions-dialog').addEventListener('pointerdown',e=>{if(e.target===$('#versions-dialog')){$('#versions-dialog').hidden=true;this.container.focus({preventScroll:true});}});
      $('#btn-search').addEventListener('click',()=>this.openSearchDialog());
      $('#search-close').addEventListener('click',()=>this.closeSearchDialog());
      $('#search-dialog').addEventListener('pointerdown',e=>{if(e.target===$('#search-dialog'))this.closeSearchDialog();});
      $('#search-input').addEventListener('input',e=>this.renderSearchResults(e.target.value));
      $('#search-input').addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();this.closeSearchDialog();}});
      $('#btn-edit-mermaid').addEventListener('click',()=>this.openMermaidDialog(true));
      $('#btn-copy-mermaid').addEventListener('click',()=>this.copyMermaid());
      $$('#grid-control button').forEach(b=>b.addEventListener('click',()=>{this.gridType=b.dataset.grid;this.syncGridUI();this.savePreferences();this.render();}));
      $$('#theme-control button').forEach(b=>b.addEventListener('click',()=>{this.theme=b.dataset.theme;this.applyTheme();this.savePreferences();this.render();}));
      $$('#snap-control button').forEach(b=>b.addEventListener('click',()=>{this.snapToGrid=b.dataset.enabled==='true';this.syncPreferenceUI();this.savePreferences();}));
      $('#ai-provider-select').addEventListener('change',e=>this.setAIProvider(e.target.value));
      this.updateMindStyleUI();
      this.syncPreferenceUI();
      for(const dialog of $$('.confirm-backdrop,.mermaid-backdrop,.ai-backdrop'))dialog.addEventListener('keydown',e=>this.trapDialogFocus(dialog,e));
      document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&this.dirty)this.saveFileNow().catch(()=>{});});
      window.addEventListener('pagehide',()=>{if(this.dirty)this.saveFileNow().catch(()=>{});});
      window.addEventListener('beforeunload',()=>this.saveFileNow());
    }

    positionMenuPopover(){
      const menu=$('#menu-popover'),button=$('#btn-menu');if(!menu||menu.hidden||!button)return;
      const margin=8,rect=button.getBoundingClientRect(),rail=$('#style-popover')?.getBoundingClientRect();
      const usableRight=rail?Math.max(margin+160,rail.left-margin):window.innerWidth-margin;
      const availableWidth=Math.max(100,Math.min(window.innerWidth-margin*2,usableRight-margin));
      const width=Math.min(310,availableWidth),above=rect.top-margin-8;
      menu.style.width=width+'px';menu.style.maxWidth=(window.innerWidth-margin*2)+'px';
      menu.style.maxHeight=Math.max(80,above)+'px';
      menu.style.left=Math.max(margin,Math.min(rect.right-width,usableRight-width))+'px';
      menu.style.right='auto';menu.style.bottom='auto';
      menu.style.top=Math.max(margin,rect.top-Math.min(menu.scrollHeight,Math.max(80,above))-8)+'px';
    }

    setupAIUI(){
      const dialog=$('#ai-mindmap-dialog');if(!dialog)return;
      $('#ai-mindmap-cancel').addEventListener('click',()=>this.closeAIMindmapDialog());
      $('#ai-task-cancel')?.addEventListener('click',()=>this.cancelAITask());
      $('#ai-mindmap-submit').addEventListener('click',()=>this.submitAIMindmap());
      $('#ai-open-provider').addEventListener('click',()=>this.openProviderTab());
      $('#ai-task-provider')?.addEventListener('change',event=>{this.setAIProvider(event.target.value);this.syncAIModeUI();});
      $('#ai-image-preset')?.addEventListener('change',event=>this.applyAIImagePreset(event.target.value));
      $('#ai-mindmap-input').addEventListener('input',()=>this.syncAIImagePresetSelection());
      $('#ai-mindmap-input').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();this.closeAIMindmapDialog();}else if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();this.submitAIMindmap();}});
      dialog.addEventListener('pointerdown',event=>{if(event.target===dialog)this.closeAIMindmapDialog();});
      $('#ai-task-flyout-details')?.addEventListener('click',()=>this.openAIProgressDetails());
      $('#ai-task-flyout-reedit')?.addEventListener('click',()=>this.reeditAIProgressTask());
      $('#ai-task-flyout-cancel')?.addEventListener('click',()=>this.cancelAITask(this.aiProgressTask?.taskId).catch(error=>this.showAITaskError(error)));
      $('#ai-task-flyout-dismiss')?.addEventListener('click',()=>this.dismissAIProgressTask(this.aiProgressTask?.taskId));
      if(globalThis.chrome?.runtime?.onMessage)chrome.runtime.onMessage.addListener((message,sender)=>{
        if(sender?.id!==chrome.runtime.id||sender?.tab)return;
        if(message?.type==='qd-ai-task-updated'&&message.task){this.onAITaskUpdated(message.task);}
      });
      if(globalThis.chrome?.storage?.onChanged)chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.quickdraw_ai_tasks_v1)this.refreshAITasks();});
      window.addEventListener('resize',()=>{if(!$('#menu-popover')?.hidden)this.positionMenuPopover();});
      this.setupAIImagePresets();
      this.syncAIProviderUI();
    }

    setupAIImagePresets(){
      const select=$('#ai-image-preset');if(!select)return;
      const presets=Array.isArray(globalThis.QuickdrawAIImagePresets)?globalThis.QuickdrawAIImagePresets:[];
      select.textContent='';
      const blank=document.createElement('option');blank.value='';blank.textContent='选择预设';select.append(blank);
      for(const preset of presets){
        if(!preset?.id||!preset?.title)continue;
        const option=document.createElement('option');option.value=String(preset.id);option.textContent=String(preset.title);select.append(option);
      }
    }

    getAIImagePreset(id){
      return (Array.isArray(globalThis.QuickdrawAIImagePresets)?globalThis.QuickdrawAIImagePresets:[]).find(preset=>String(preset?.id)===String(id));
    }

    resetAIImagePresetUI(){
      const select=$('#ai-image-preset');if(select)select.value='';
    }

    syncAIImagePresetSelection(){
      if(this.aiDialogMode!=='image-edit')return;
      const select=$('#ai-image-preset'),input=$('#ai-mindmap-input');if(!select||!input)return;
      const preset=(Array.isArray(globalThis.QuickdrawAIImagePresets)?globalThis.QuickdrawAIImagePresets:[]).find(item=>String(item?.prompt||'')===String(input.value||''));
      select.value=preset?.id?String(preset.id):'';
    }

    applyAIImagePreset(id){
      const select=$('#ai-image-preset');if(!select||select.disabled||this.aiSubmitBusy||this.aiDialogMode!=='image-edit')return;
      const preset=this.getAIImagePreset(id),input=$('#ai-mindmap-input');
      if(!preset){this.resetAIImagePresetUI();return;}
      if(input){input.value=String(preset.prompt||'');this.focusTextInput(input);}
      select.value=String(preset.id);
    }

    setAIProvider(value){
      const selected=globalThis.QuickdrawAI?.provider(value);
      if(!selected?.enabled){this.aiProvider='gpt';this.toast('当前平台未接入，请选择 GPT、豆包或 Grok。');}
      else this.aiProvider=selected.id;
      this.syncAIProviderUI();
      this.syncAIModeUI?.();
      this.savePreferences();
    }

    syncAIProviderUI(){
      const select=$('#ai-provider-select'),taskSelect=$('#ai-task-provider');
      if(select)select.value=this.aiProvider||'gpt';
      if(taskSelect)taskSelect.value=this.aiProvider||'gpt';
    }

    syncAIModeUI(){
      const image=this.aiDialogMode==='image-edit';
      const detailTask=!this.aiImageSelection&&this.aiCurrentTaskId?(this.aiTasks||[]).find(task=>task.taskId===this.aiCurrentTaskId)||(this.aiProgressTask?.taskId===this.aiCurrentTaskId?this.aiProgressTask:null):null;
      const hasInputImages=image&&!!(this.aiImageSelection?.units?.length||detailTask?.inputAssets?.length||detailTask?.inputAssetIds?.length||detailTask?.inputAssetId);
      const title=$('#ai-mindmap-dialog-title'),input=$('#ai-mindmap-input'),submit=$('#ai-mindmap-submit'),hint=$('.ai-dialog-hint'),presetField=$('#ai-image-preset-field'),preset=$('#ai-image-preset');
      const provider=globalThis.QuickdrawAI?.provider(this.aiProvider||'gpt'),label=provider?.label||'GPT';
      if(title)title.textContent=image?`AI 图片编辑（${label}）`:`AI 脑图（${label}）`;
       if(input)input.placeholder=image?(hasInputImages?'例如：把背景改成浅蓝色，并保留主体轮廓（可不填）':'例如：一只戴宇航员头盔的猫，电影质感'):'例如：做一个外卖系统的开发架构交互流程图';
      if(presetField)presetField.hidden=!image;
      if(preset&&!image)preset.value='';
      const open=$('#ai-open-provider');if(open)open.textContent=`打开${label}`;
      if(submit)submit.textContent=image?(hasInputImages?`使用${label}生成图片`:`使用${label}文生图`):`发送到${label}`;
      const pageHint=this.aiProvider==='doubao'?'豆包任务会自动打开并切到专用标签页，请保持该页可见直到完成。':`${label} 会在同一浏览器配置的专用标签页中处理。`;
      if(hint)hint.textContent=image?(hasInputImages?`${pageHint}图片编辑需求可不填。首次图片任务会申请已知必要权限，遇到新的结果图片网站时才会另行请求。`:`${pageHint}当前未选择图片，将按文字生成图片；请输入生成描述。首次图片任务会申请已知必要权限，遇到新的结果图片网站时才会另行请求。`):`${pageHint}首次使用需要授予${label}网站权限。未确认发送时不会自动重试。`;
    }

    aiTaskStatusLabel(status,task=null){
      const label=globalThis.QuickdrawAI?.provider(task?.provider||this.aiProvider)?.label||'AI';
      const stageLabels={queued:'排队中','page-loading':`打开${label}`,hydrating:`等待${label}页面`,uploading:'上传图片',sending:'发送中',generating:'生成中',returning:'接收回复'};
      if(status==='paused'&&task?.pauseReason==='raw-image-unavailable')return '等待读取豆包原图';
      if(status==='paused'&&task?.pauseReason==='conversation-conflict')return '已暂停（需确认会话）';
      if(task?.status!=='paused'&&task?.stage&&globalThis.QuickdrawAI?.isActiveTask(task)&&stageLabels[task.stage])return stageLabels[task.stage];
      return ({queued:'排队中',connecting:`连接${label}`,sending:'发送中',waiting:`等待${label}回复`,validating:'校验中',ready:'待导入',pending:'待导入','image-ready':'图片待插入','pending-image':'等待图片权限',importing:'导入中',paused:'已暂停（需登录/验证）',imported:'已导入',failed:'失败','needs-attention':'需要处理',cancelled:'已取消'}[status]||'未知状态');
    }

    async refreshAITasks(){
      if(!this.aiTaskStore)return;
      this.aiTasks=await this.aiTaskStore.list().catch(()=>[]);
      this.aiTasks=this.aiTasks.filter(item=>!this.aiDismissedTaskIds.has(item.taskId));
      const current=(this.aiCurrentTaskId&&!this.aiDismissedTaskIds.has(this.aiCurrentTaskId)&&this.aiTasks.find(item=>item.taskId===this.aiCurrentTaskId))||this.aiTasks.find(item=>!this.aiDismissedTaskIds.has(item.taskId)&&globalThis.QuickdrawAI?.isActiveTask(item));
      if(current)this.aiProgressTask=current;
      else if(this.aiProgressTask&&!this.aiTasks.some(item=>item.taskId===this.aiProgressTask.taskId)&&this.aiDismissedTaskIds.has(this.aiProgressTask.taskId))this.aiProgressTask=null;
      this.renderAITaskList();
      this.syncAITaskControls();
      this.renderAIProgress();
    }

    onAITaskUpdated(task){
      if(!task?.taskId)return;
      if(this.aiDismissedTaskIds.has(task.taskId)){
        if(this.aiCurrentTaskId===task.taskId)this.aiCurrentTaskId=null;
        if(this.aiProgressTask?.taskId===task.taskId)this.aiProgressTask=null;
        this.syncAITaskControls();this.renderAIProgress();return;
      }
      if(task.taskId===this.aiCurrentTaskId||task.taskId===this.aiProgressTask?.taskId||globalThis.QuickdrawAI?.isActiveTask(task))this.aiProgressTask=task;
      const index=this.aiTasks.findIndex(item=>item.taskId===task.taskId);
      const finished=['imported','failed','needs-attention','cancelled'].includes(task.status);
      if(finished){if(index>=0)this.aiTasks.splice(index,1);}
      else if(index>=0)this.aiTasks[index]=task;else this.aiTasks.unshift(task);
      this.aiTasks.sort((a,b)=>Number(b.updatedAt||0)-Number(a.updatedAt||0));
      this.renderAITaskList();
      if((task.status==='ready'||task.status==='image-ready')&&globalThis.QuickdrawAI?.canAutoImport(task,{instanceId:this.instanceId,boardId:this.currentFileId,boardEpoch:this.aiBoardEpoch,loading:this.boardLoading}))this.importAITask(task,false).catch(error=>this.showAITaskError(error));
      if(['failed','needs-attention','paused'].includes(task.status)&&this.aiCurrentTaskId===task.taskId)this.showAITaskError(task.error||`${globalThis.QuickdrawAI?.provider(task.provider||this.aiProvider)?.label||'AI'} 任务需要处理。`);
      if(this.aiCurrentTaskId===task.taskId){const status=$('#ai-task-status');if(status)status.textContent=this.aiTaskStatusLabel(task.status,task);}
      this.syncAITaskControls();
      if(task.status==='imported'||task.status==='cancelled')this.aiProgressTask=null;
      this.renderAIProgress();
    }

    renderAITaskList(){
      const root=$('#ai-task-list');if(!root)return;
      root.textContent='';
      const tasks=(this.aiTasks||[]).filter(task=>globalThis.QuickdrawAI?.isActiveTask(task)||['ready','pending','image-ready','pending-image','importing'].includes(task.status));
      for(const task of tasks){
        const row=document.createElement('div');row.className='ai-task-row';
        const receipt=this.aiTaskReceipts.get(task.taskId);
        const taskLabel=task.prompt||(task.kind==='image-edit'?'图片编辑':'AI 任务');
        const text=document.createElement('span');text.className='ai-task-row-text';text.textContent=taskLabel;text.title=task.error?`${taskLabel}\n${task.error}`:taskLabel;
        const status=document.createElement('span');status.className='ai-task-row-status';status.textContent=receipt&&task.status!=='imported'?'已写入待确认':this.aiTaskStatusLabel(task.status,task);
        row.append(text,status);
        if(globalThis.QuickdrawAI?.isActiveTask(task)){const button=document.createElement('button');button.type='button';button.textContent='取消任务';button.addEventListener('click',()=>this.cancelAITask(task.taskId).catch(error=>this.showAITaskError(error)));row.append(button);}
        if(task.status==='paused'){
          const open=document.createElement('button');open.type='button';open.textContent=`打开 ${globalThis.QuickdrawAI?.provider(task.provider||this.aiProvider)?.label||'AI'}`;open.addEventListener('click',()=>this.openProviderTab(task).catch(error=>this.showAITaskError(error)));row.append(open);
          const resume=document.createElement('button');resume.type='button';resume.textContent='继续任务';resume.addEventListener('click',()=>this.resumeAITask(task.taskId).catch(error=>this.showAITaskError(error)));row.append(resume);
        }
        if(['ready','pending','image-ready'].includes(task.status)&&!receipt){const button=document.createElement('button');button.type='button';button.textContent=task.kind==='image-edit'?'插入图片':'导入当前画板';button.addEventListener('click',()=>this.importAITask(task,true).catch(error=>this.showAITaskError(error)));row.append(button);}
        if(task.status==='pending-image'){const button=document.createElement('button');button.type='button';button.textContent='授予图片权限并重试';button.addEventListener('click',()=>this.retryAIImage(task).catch(error=>this.showAITaskError(error)));row.append(button);}
        if(receipt&&task.status!=='imported'){const button=document.createElement('button');button.type='button';button.textContent='确认已写入';button.addEventListener('click',()=>this.ackAIReceipt(task));row.append(button);}
        root.append(row);
      }
      const menuStatus=$('#ai-menu-status');
      if(menuStatus){menuStatus.textContent=tasks.length?`${tasks.length} 项`:'无';}
    }

    openAIMindmapDialog(showPending=false){
      this.closePopovers();
      const dialog=$('#ai-mindmap-dialog');if(!dialog)return;
      this.aiCurrentTaskId=null;
      this.aiDialogMode='mindmap';this.aiImageSelection=null;dialog.hidden=false;this.syncAIProviderUI();this.syncAIModeUI();this.refreshAITasks();
      const input=$('#ai-mindmap-input');if(input&&!showPending){input.value='';}
      this.hideAITaskError();
      const status=$('#ai-task-status');if(status)status.textContent=showPending?'待导入结果':'准备就绪';this.syncAITaskControls();
      if(showPending)$('#ai-task-list')?.scrollTo?.({top:0});else this.focusTextInput(input);
    }

    getAIImageInputUnits(requested=null){
      const selected=(requested||this.getSelectedElements()||[]).filter(el=>el&&this.elements.includes(el)&&this.isElementVisible(el));
      if(!selected.length)return [];
      const selectedIds=new Set(selected.map(el=>el.id)),used=new Set(),units=[];
      const descendants=(root,out)=>{
        for(const child of this.elements){
          if(child.type!=='mindnode'||child.parentId!==root.id||!this.isElementVisible(child)||out.some(item=>item.id===child.id))continue;
          out.push(child);descendants(child,out);
        }
      };
      const addUnit=(seed,items)=>{
        const visibleItems=(items||[]).filter(el=>el&&this.elements.includes(el)&&this.isElementVisible(el));
        if(!visibleItems.length)return;
        const exported=this.exportElementsFor(visibleItems),ids=visibleItems.map(el=>el.id),bounds=this.getElementsBBox(exported),firstIndex=Math.min(...visibleItems.map(el=>this.elements.indexOf(el)).filter(index=>index>=0));
        units.push({items:exported,ids,bounds,firstIndex:Number.isFinite(firstIndex)?firstIndex:999999,seedId:String(seed?.id||ids[0]||''),order:units.length});
      };
      for(const el of selected){
        if(used.has(el.id))continue;
        if(el.groupId){
          const members=this.elements.filter(item=>item.groupId===el.groupId&&this.isElementVisible(item));
          members.forEach(item=>used.add(item.id));
          addUnit(el,members);
          continue;
        }
        if(el.type==='mindnode'){
          let parent=el;
          while(parent.parentId){const next=this.elements.find(item=>item.type==='mindnode'&&item.id===parent.parentId);if(!next||!selectedIds.has(next.id))break;parent=next;}
          if(parent!==el&&used.has(parent.id)){used.add(el.id);continue;}
          const members=[parent];descendants(parent,members);members.forEach(item=>used.add(item.id));addUnit(parent,members);
          continue;
        }
        used.add(el.id);addUnit(el,[el]);
      }
      units.sort((a,b)=>Number(a.bounds?.x||0)-Number(b.bounds?.x||0)||Number(a.bounds?.y||0)-Number(b.bounds?.y||0)||a.firstIndex-b.firstIndex||a.seedId.localeCompare(b.seedId));
      units.forEach((unit,index)=>{unit.order=index;});
      return units;
    }

    openAIImageDialog(){
      const selected=this.getSelectedElements();
      const units=selected.length?this.getAIImageInputUnits(selected):[];
      if(selected.length&&!units.length){this.toast('当前选择没有可导出的对象。');return;}
      this.closePopovers();this.aiDialogMode='image-edit';this.aiImageSelection={refs:[...selected],ids:selected.map(el=>el.id),units,bounds:units.length?this.getElementsBBox(units.flatMap(unit=>unit.items)):null,sourceInputUnits:units.map(unit=>unit.ids)};
      const dialog=$('#ai-mindmap-dialog');if(!dialog)return;dialog.hidden=false;this.syncAIProviderUI();this.syncAIModeUI();this.refreshAITasks();this.hideAITaskError();
      const input=$('#ai-mindmap-input');if(input)input.value='';this.resetAIImagePresetUI();const status=$('#ai-task-status');if(status)status.textContent='准备就绪';this.syncAITaskControls();this.focusTextInput(input);
    }

    closeAIMindmapDialog(){
      const dialog=$('#ai-mindmap-dialog');if(dialog)dialog.hidden=true;
      const task=this.aiProgressTask?.taskId===this.aiCurrentTaskId?this.aiProgressTask:null;
      if(task&&['failed','needs-attention','cancelled'].includes(task.status))this.dismissAIProgressTask(task.taskId);
      this.hideAITaskError();this.aiCurrentTaskId=null;this.aiDialogMode='mindmap';this.aiImageSelection=null;this.syncAIModeUI();
      const status=$('#ai-task-status');if(status)status.textContent='准备就绪';
      this.syncAITaskControls();
      this.container?.focus?.({preventScroll:true});
    }

    showAITaskError(message){const box=$('#ai-task-error');if(!box)return;box.textContent=String(message||'AI 任务失败。');box.hidden=false;}
    hideAITaskError(){const box=$('#ai-task-error');if(box){box.textContent='';box.hidden=true;}}
    syncAITaskControls(){
      const task=(this.aiTasks||[]).find(item=>item.taskId===this.aiCurrentTaskId);
      const active=!!task&&globalThis.QuickdrawAI?.isActiveTask(task);
      const cancel=$('#ai-task-cancel'),submit=$('#ai-mindmap-submit'),preset=$('#ai-image-preset');
      if(cancel){cancel.hidden=!active;cancel.disabled=!active;}
      if(submit)submit.disabled=active||this.aiSubmitBusy;
      if(preset)preset.disabled=active||this.aiSubmitBusy;
    }

    renderAIProgress(){
      const root=$('#ai-task-flyout'),task=this.aiProgressTask;
      if(!root||!task||this.aiDismissedTaskIds.has(task.taskId)||['imported','cancelled'].includes(task.status)){if(root)root.hidden=true;return;}
      const provider=globalThis.QuickdrawAI?.provider(task.provider||this.aiProvider),label=provider?.label||'AI';
      const active=!!globalThis.QuickdrawAI?.isActiveTask(task),stage=this.aiTaskStatusLabel(task.status,task);
      const heading=$('#ai-task-flyout-provider'),stageNode=$('#ai-task-flyout-stage'),text=$('#ai-task-flyout-text'),card=$('.ai-task-flyout-card',root),cancel=$('#ai-task-flyout-cancel'),reedit=$('#ai-task-flyout-reedit'),dismiss=$('#ai-task-flyout-dismiss');
      if(heading)heading.textContent=label;if(stageNode)stageNode.textContent=stage;
      if(text)text.textContent=task.error||task.prompt||(task.kind==='image-edit'?'图片编辑':'AI 任务');
      if(card)card.dataset.active=active?'true':'false';
      if(cancel){cancel.hidden=!active;cancel.disabled=!active;}
      if(reedit)reedit.hidden=!['failed','needs-attention'].includes(task.status);
      if(dismiss){dismiss.hidden=!['failed','needs-attention','cancelled'].includes(task.status);dismiss.disabled=false;}
      root.hidden=false;
    }

    dismissAIProgressTask(taskId){
      const id=String(taskId||'');if(!id)return;
      const task=this.aiProgressTask?.taskId===id?this.aiProgressTask:(this.aiTasks||[]).find(item=>item.taskId===id);
      if(!task||!['failed','needs-attention','cancelled'].includes(task.status))return;
      this.aiDismissedTaskIds.add(id);
      this.aiTasks=(this.aiTasks||[]).filter(item=>item.taskId!==id);
      if(this.aiProgressTask?.taskId===id)this.aiProgressTask=null;
      if(this.aiCurrentTaskId===id)this.aiCurrentTaskId=null;
      this.hideAITaskError();this.syncAITaskControls();this.renderAITaskList();this.renderAIProgress();
    }

    hideAIDialogAfterSubmit(taskId){
      const dialog=$('#ai-mindmap-dialog');if(dialog)dialog.hidden=true;
      this.hideAITaskError();
      this.aiCurrentTaskId=taskId;
      this.aiImageSelection=null;
      this.container?.focus?.({preventScroll:true});
      this.renderAIProgress();
    }

    openAIProgressDetails(){
      const task=this.aiProgressTask;if(!task)return;
      const dialog=$('#ai-mindmap-dialog');if(!dialog)return;
      this.closePopovers();this.aiCurrentTaskId=task.taskId;this.aiDialogMode=task.kind==='image-edit'?'image-edit':'mindmap';this.aiImageSelection=null;dialog.hidden=false;this.syncAIProviderUI();this.syncAIModeUI();
      this.resetAIImagePresetUI();const input=$('#ai-mindmap-input');if(input)input.value=task.prompt||'';
      if(task.error)this.showAITaskError(task.error);else this.hideAITaskError();
      const status=$('#ai-task-status');if(status)status.textContent=this.aiTaskStatusLabel(task.status,task);
      this.syncAITaskControls();
    }

    reeditAIProgressTask(){
      const task=this.aiProgressTask;if(!task)return;
      if(['failed','needs-attention','cancelled'].includes(task.status))this.aiDismissedTaskIds.add(task.taskId);
      this.aiProgressTask=null;this.aiCurrentTaskId=null;
      if(task.kind==='image-edit'){
        const source=(task.boardId===this.currentFileId?(task.sourceElementIds||[]).map(id=>this.elements.find(el=>el.id===id)).filter(Boolean):[]);
        if(source.length){this.setSelection(source,false);this.openAIImageDialog();const input=$('#ai-mindmap-input');if(input)input.value=task.prompt||'';return;}
        this.openAIMindmapDialog();this.showAITaskError('请重新选择图片对象后再开始图片编辑。');return;
      }
      this.openAIMindmapDialog();const input=$('#ai-mindmap-input');if(input)input.value=task.prompt||'';
    }
    async cancelAITask(taskId=this.aiCurrentTaskId){
      if(!taskId)return;
      const response=await chrome.runtime.sendMessage({type:'qd-ai-cancel',taskId});
      if(!response?.ok)throw new Error(response?.error||'任务已结束或不可取消。');
      this.onAITaskUpdated(response.task);
      if(this.aiCurrentTaskId===taskId){const status=$('#ai-task-status');if(status)status.textContent='已取消';}
    }
    async openProviderTab(task){try{const provider=globalThis.QuickdrawAI?.provider(task?.provider||this.aiProvider),label=provider?.label||'AI';if(!(await this.ensureProviderPermission(task?.provider||this.aiProvider)))return;const response=await chrome.runtime.sendMessage({type:'qd-ai-open-provider',provider:task?.provider||this.aiProvider,taskId:task?.taskId});if(!response?.ok)throw new Error(response?.error||`无法打开${label}标签页。`);if(response.task)this.onAITaskUpdated(response.task);if(response.groupError)this.showAITaskError(`${label} 已打开，但当前浏览器未能创建折叠 AI 标签组。`);}catch(error){this.showAITaskError(error);}}
    async openGPTTab(task){return this.openProviderTab(task);}
    async resumeAITask(taskId){
      const response=await chrome.runtime.sendMessage({type:'qd-ai-resume',taskId});
      if(!response?.ok)throw new Error(response?.error||'任务无法继续。');
      this.aiCurrentTaskId=taskId;
      this.onAITaskUpdated(response.task);
      const status=$('#ai-task-status');if(status)status.textContent=this.aiTaskStatusLabel(response.task?.status,response.task);
    }
    async ackAIReceipt(task){
      if(this.boardLoading||!this.aiTaskReceipts.has(task.taskId))return;
      try{
        const boardId=await this.saveFileNow({snapshot:false});
        if(!boardId)throw new Error('画板尚未保存，请重试。');
        const response=await chrome.runtime.sendMessage({type:'qd-ai-mark-imported',taskId:task.taskId,ownerId:this.instanceId,targetBoardId:boardId,receipt:true});
        if(!response?.ok)throw new Error(response?.error||'任务状态同步失败。');
        this.onAITaskUpdated(response.task);
      }catch(error){this.showAITaskError(error);}
    }

    async ensureProviderPermission(providerId=this.aiProvider,image=false){
      if(!globalThis.chrome?.permissions)return true;
      const provider=globalThis.QuickdrawAI?.provider(providerId),label=provider?.label||'AI';
      if(!provider?.enabled)return false;
      const origins=[...(provider.origins||[]),...(provider.authOrigins||[]),...(image?(provider.imageOrigins||[]):[])];
      try{if(await chrome.permissions.contains({origins}))return true;}catch{}
      try{return await chrome.permissions.request({origins});}catch(error){this.showAITaskError(`无法取得${label}网站权限，请在扩展权限设置中允许后重试。`);return false;}
    }
    async ensureGPTPermission(image=false){return this.ensureProviderPermission('gpt',image);}

    async ensureImageOriginPermission(url,requestedOrigins=[]){
      if(!url||!globalThis.chrome?.permissions)return true;
      try{
        const parsed=new URL(url);if(parsed.protocol!=='https:'||!parsed.origin)return false;
        const origins=Array.isArray(requestedOrigins)&&requestedOrigins.length?requestedOrigins:[`${parsed.origin}/*`];
        if(await chrome.permissions.contains({origins}))return true;
        const granted=!!(await chrome.permissions.request({origins}));
        return granted&&!!(await chrome.permissions.contains({origins}));
      }catch{return false;}
    }

    async retryAIImage(task){
      if(!task?.taskId)return;
      const pending=Array.isArray(task.pendingImageResults)&&task.pendingImageResults.length
        ? task.pendingImageResults
        : (task.imageUrl?[{imageUrl:task.imageUrl,permissionOrigins:task.imagePermissionOrigins||[]}]:[]);
      const checkedOrigins=new Set();
      for(const item of pending){
        const url=String(item?.imageUrl||'');if(!url)continue;
        const origins=Array.isArray(item.permissionOrigins)&&item.permissionOrigins.length?item.permissionOrigins:(task.imagePermissionOrigins||[]);
        const key=`${url}|${origins.join(',')}`;if(checkedOrigins.has(key))continue;checkedOrigins.add(key);
        if(!(await this.ensureImageOriginPermission(url,origins))){this.showAITaskError('图片网站权限未授予，结果仍会保留，可再次重试。');return;}
      }
      const response=await chrome.runtime.sendMessage({type:'qd-ai-retry-image',taskId:task.taskId,imageUrls:pending.map(item=>item?.imageUrl).filter(Boolean)});
      if(response?.task)this.onAITaskUpdated(response.task);
      this.renderAITaskList();
      if(!response?.ok)throw new Error(response?.error||'图片读取失败，请重试。');
    }

    async submitAIMindmap(){
      if(this.aiSubmitBusy)return;
      if(this.aiDialogMode==='image-edit')return this.submitAIImageEdit();
      this.hideAITaskError();
      if(this.boardLoading||!this.currentFileId){this.showAITaskError('画板正在加载，请稍后再发送。');return;}
      const provider=globalThis.QuickdrawAI?.provider(this.aiProvider||'gpt');
      if(!provider?.enabled){this.showAITaskError('当前平台未接入，请选择 GPT 或豆包。');return;}
      const input=$('#ai-mindmap-input'),prompt=String(input?.value||'').trim();
      if(!prompt){this.showAITaskError('请输入 AI 脑图需求。');input?.focus();return;}
      const boardId=this.currentFileId,boardEpoch=this.aiBoardEpoch,sourceRevision=this.documentRevision;
      this.aiSubmitBusy=true;this.syncAITaskControls();
      const submit=$('#ai-mindmap-submit'),status=$('#ai-task-status');if(submit)submit.disabled=true;if(status)status.textContent='提交任务…';
      try{
       if(!(await this.ensureProviderPermission(provider.id)))return;
        if(this.boardLoading||this.currentFileId!==boardId||this.aiBoardEpoch!==boardEpoch)throw new Error('画板已切换，任务未发送。');
        if(!globalThis.chrome?.runtime?.sendMessage)throw new Error('当前环境无法连接扩展后台。');
        const response=await chrome.runtime.sendMessage({type:'qd-ai-submit',payload:{provider:provider.id,kind:'mindmap',prompt,boardId,sourceWindowId:this.windowId,sourceInstanceId:this.instanceId,sourceBoardEpoch:boardEpoch,sourceRevision}});
        if(!response?.ok)throw new Error(response?.error||'AI 任务提交失败。');
        this.aiCurrentTaskId=response.taskId;this.aiProgressTask={taskId:response.taskId,provider:provider.id,kind:'mindmap',prompt,status:'queued',stage:'queued'};input.value='';if(status)status.textContent=`已提交，等待${provider.label}回复`;this.hideAIDialogAfterSubmit(response.taskId);this.refreshAITasks().catch(()=>{});
      }catch(error){this.showAITaskError(error);if(status)status.textContent='提交失败';}
      finally{this.aiSubmitBusy=false;this.syncAITaskControls();if(submit)submit.disabled=false;}
    }

    async submitAIImageEdit(){
      if(this.aiSubmitBusy)return;
      this.hideAITaskError();
      const selection=this.aiImageSelection;
      if(this.boardLoading||!this.currentFileId||!selection){this.showAITaskError('请先打开图片生成对话框。');return;}
      const provider=globalThis.QuickdrawAI?.provider(this.aiProvider||'gpt');
      const input=$('#ai-mindmap-input'),prompt=String(input?.value||'').trim();
      if(!provider?.enabled||!provider.capabilities?.image){this.showAITaskError('当前平台未接入图片编辑。');return;}
       const boardId=this.currentFileId,boardEpoch=this.aiBoardEpoch,sourceRevision=this.documentRevision;
      this.aiSubmitBusy=true;this.syncAITaskControls();const submit=$('#ai-mindmap-submit'),status=$('#ai-task-status');if(submit)submit.disabled=true;if(status)status.textContent='导出所选对象…';
      let inputAssetIds=[];
      try{
         if(!(await this.ensureProviderPermission(provider.id,true)))return;
        const units=Array.isArray(selection.units)&&selection.units.length?selection.units:this.getAIImageInputUnits(selection.refs);
        const maxImages=Number(provider.maxInputImages||globalThis.QuickdrawAI?.MAX_INPUT_IMAGES||4);
        if(units.length>maxImages)throw new Error(`${provider.label} 当前一次最多处理 ${maxImages} 张图片，请减少选区后重试。`);
        for(const unit of units){
          const blob=await this.createPNGBlob(true,unit.items);
          if(!globalThis.QuickdrawAIImage?.inspectBlob)throw new Error('图片校验不可用。');
          await globalThis.QuickdrawAIImage.inspectBlob(blob,{maxBytes:globalThis.QuickdrawAIImage.MAX_INPUT_BYTES});
          const assetId=await this.store.putAsset(blob,{sourceUrl:'quickdraw-selection',aiInput:true,createdBy:this.instanceId,aiInputOrder:unit.order});
          inputAssetIds.push(assetId);
        }
        if(this.boardLoading||this.currentFileId!==boardId||this.aiBoardEpoch!==boardEpoch||selection.refs.some(el=>!this.elements.includes(el)))throw new Error('画板已变化，任务未发送。');
        const inputAssets=units.map((unit,order)=>({assetId:inputAssetIds[order],order,sourceElementIds:unit.ids}));
        const response=await chrome.runtime.sendMessage({type:'qd-ai-submit',payload:{provider:provider.id,kind:'image-edit',prompt,boardId,sourceWindowId:this.windowId,sourceInstanceId:this.instanceId,sourceBoardEpoch:boardEpoch,sourceRevision,inputAssetId:inputAssetIds[0],inputAssetIds,inputAssets,sourceElementIds:selection.ids,sourceInputUnits:units.map(unit=>unit.ids),sourceBounds:selection.bounds}});
        if(!response?.ok)throw new Error(response?.error||'AI 图片任务提交失败。');
        this.aiCurrentTaskId=response.taskId;this.aiProgressTask={taskId:response.taskId,provider:provider.id,kind:'image-edit',prompt,status:'queued',stage:'queued'};input.value='';if(status)status.textContent=`已提交，等待${provider.label}回复`;this.hideAIDialogAfterSubmit(response.taskId);this.refreshAITasks().catch(()=>{});
      }catch(error){for(const assetId of inputAssetIds)this.store.deleteAsset?.(assetId).catch?.(()=>{});this.showAITaskError(error);if(status)status.textContent='提交失败';}
      finally{this.aiSubmitBusy=false;this.syncAITaskControls();if(submit)submit.disabled=false;}
    }

    async importAITask(task,manual=false){
      if(!task||task.importedAt||this.aiImporting.has(task.taskId))return;
      const existingReceipt=this.aiTaskReceipts.get(task.taskId);
      if(existingReceipt){await this.ackAIReceipt(task);return;}
      if(!['ready','pending','image-ready'].includes(task.status))return;
      if(this.boardLoading||!this.currentFileId){this.showAITaskError('画板正在加载，请等待后再导入。');return;}
      const targetBoardId=this.currentFileId,targetEpoch=this.aiBoardEpoch;
      if(!manual&&!globalThis.QuickdrawAI.canAutoImport(task,{instanceId:this.instanceId,boardId:targetBoardId,boardEpoch:targetEpoch,loading:this.boardLoading}))return;
      this.aiImporting.add(task.taskId);
      let claimed=false,committed=false,applied=false;
      try{
        const claim=await chrome.runtime.sendMessage({type:'qd-ai-claim-import',taskId:task.taskId,ownerId:this.instanceId});
        if(!claim?.ok)throw new Error(claim?.error||'任务正在由其他画板实例导入。');
        claimed=true;
        task=claim.task;
        if(task.kind==='image-edit'){
          const outputImages=Array.isArray(task.outputImages)&&task.outputImages.length
            ? task.outputImages.slice().sort((a,b)=>Number(a.order||0)-Number(b.order||0))
            : (task.outputAssetId?[{assetId:task.outputAssetId,imageUrl:task.imageUrl||'',imageType:task.imageType||'',imageBytes:task.imageBytes||0,imageWidth:task.imageWidth||0,imageHeight:task.imageHeight||0,order:0}]:[]);
          if(!outputImages.length||outputImages.length>MAX_AI_OUTPUT_IMAGES)throw new Error(`${globalThis.QuickdrawAI?.provider(task.provider||this.aiProvider)?.label||'AI'} 图片资源不存在或数量超限。`);
          const sameBoard=task.boardId===targetBoardId;
          const sourceElements=sameBoard?(task.sourceElementIds||[]).map(id=>this.elements.find(el=>el.id===id)).filter(Boolean):[];
          const sourceBox=this.getElementsBBox(sourceElements)||task.sourceBounds||this.getSelectionBBox();
          let x=null,y=null;
          if(sourceBox){
            if(sameBoard&&sourceElements.length){x=sourceBox.x+sourceBox.w+24;y=sourceBox.y;}
            else{x=sourceBox.x+sourceBox.w/2-150;y=sourceBox.y+sourceBox.h/2-100;}
          }
          await this.insertStoredImages(outputImages,x,y,{sourceUrl:task.imageUrl||'GPT image',aiTaskId:task.taskId});
          // Record the receipt only after every asset has been resolved and the
          // whole group has been added, so a missing second asset cannot be
          // acknowledged as a successful import.
          this.aiTaskReceipts.set(task.taskId,{taskId:task.taskId,boardId:targetBoardId,ownerId:this.instanceId,outputAssetId:outputImages[0].assetId,outputAssetIds:outputImages.map(item=>item.assetId).filter(Boolean),createdAt:Date.now()});
          applied=true;
          const savedBoardId=await this.saveFileNow({snapshot:false});if(!savedBoardId)throw new Error('画板保存失败，结果未确认。');
          committed=true;
          const marked=await chrome.runtime.sendMessage({type:'qd-ai-mark-imported',taskId:task.taskId,ownerId:this.instanceId,targetBoardId:savedBoardId});
          if(!marked?.ok){this.toast('图片已写入当前画板，但任务状态同步失败，请不要重复导入。');return;}
          this.onAITaskUpdated(marked.task);this.toast(`AI 编辑图片已插入 ${outputImages.length} 张图片，可撤销。`);return;
        }
        const checked=globalThis.QuickdrawAI.validateMermaid(task.validatedMermaid||task.rawReply);
        if(!checked.ok)throw new Error(`Mermaid 校验失败：${checked.error}`);
        const parsed=checked.parsed;
        const layout=this.layoutMermaidFlowchart(parsed);if(!layout?.nodes?.length)throw new Error('流程图没有可导入节点。');
        if(this.boardLoading||this.currentFileId!==targetBoardId||this.aiBoardEpoch!==targetEpoch)throw new Error('画板已切换，结果已保留在待导入任务中。');
        this.aiTaskReceipts.set(task.taskId,{taskId:task.taskId,boardId:targetBoardId,ownerId:this.instanceId,mermaidHash:QDCore.hashString(checked.source),createdAt:Date.now()});
        this.elements.push(...layout.nodes);this.elements.unshift(...layout.edges);this.setSelection(layout.nodes,false);this.commit();this.render();applied=true;
        const savedBoardId=await this.saveFileNow({snapshot:false});if(!savedBoardId)throw new Error('画板保存失败，结果未确认。');
        committed=true;
        const marked=await chrome.runtime.sendMessage({type:'qd-ai-mark-imported',taskId:task.taskId,ownerId:this.instanceId,targetBoardId:savedBoardId});
        if(!marked?.ok){this.toast('脑图已写入当前画板，但任务状态同步失败，请不要重复导入。');return;}
        this.onAITaskUpdated(marked.task);this.toast(`已导入 ${layout.nodes.length} 个节点、${layout.edges.length} 条连线，可撤销。`);
      }catch(error){
        this.showAITaskError(error);
        // Keep the applied edit on save failure; undo could erase a later user edit.
        if(applied&&!committed)this.toast(`${task.kind==='image-edit'?'图片':'脑图'}已显示，但尚未确认保存。请在任务中点击确认已写入重试保存。`);
        if(claimed&&!applied)await chrome.runtime.sendMessage({type:'qd-ai-release-import',taskId:task.taskId,ownerId:this.instanceId,error:String(error?.message||'导入未完成。')}).catch?.(()=>{});
      }finally{this.aiImporting.delete(task.taskId);}
    }

    trapDialogFocus(dialog,event){
      if(event.key==='Escape'){
        event.preventDefault();
        if(dialog.id==='ai-mindmap-dialog')this.closeAIMindmapDialog();
        else if(dialog.id==='mermaid-dialog')this.closeMermaidDialog();
        else if(dialog.id==='clear-dialog')this.closeClearDialog();
        else if(dialog.id==='storage-dialog')this.closeStorageDialog();
        else if(dialog.id==='search-dialog')this.closeSearchDialog();
        else{dialog.hidden=true;this.container.focus({preventScroll:true});}
        return;
      }
      if(event.key!=='Tab')return;
      const items=$$('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',dialog).filter(el=>el.offsetParent!==null);
      if(!items.length)return;
      const first=items[0],last=items.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    }

    closePopovers(){for(const p of $$('.popover')){if(p.id!=='style-popover')p.hidden=true;}this.contextMindNode=null;}

    setStyle(kind,value,button,selector){
      if(kind==='color'){this.currentColor=value;}
      if(kind==='size')this.currentSize=value;if(kind==='dash')this.currentDash=value;if(kind==='fill')this.currentFill=value;if(kind==='stroke')this.currentStroke=value;
      if(button)$$(selector).forEach(x=>x.classList.toggle('active',x===button));else if(kind==='color')$$('.color-dot').forEach(x=>x.classList.remove('active'));
      const geoTypes=new Set(['path','rect','ellipse','triangle','diamond','hexagon','star','cloud']);const targets=this.getSelectedElements();let changed=false;
      for(const el of targets){if(kind==='stroke'&&!geoTypes.has(el.type))continue;if(kind==='size'&&el.type==='mindnode')continue;if(kind==='color'){el.color=value;if(el.type==='path'){el.fillColor=value;el.strokeColor=value;}}else el[kind]=value;changed=true;}if(changed){this.commit();this.render();}
    }

    requestClearBoard(){this.closePopovers();if(!this.elements.length){this.toast('当前画板已经是空的。');return;}$('#clear-dialog-text').textContent=`这会删除当前画板中的 ${this.elements.length} 个元素。清空后仍可使用撤销恢复。`;$('#clear-dialog').hidden=false;setTimeout(()=>$('#clear-confirm').focus(),0);}
    closeClearDialog(){$('#clear-dialog').hidden=true;this.container.focus({preventScroll:true});}
    confirmClearBoard(){if(!this.elements.length){this.closeClearDialog();return;}this.elements=[];this.currentElement=null;this.clearSelection();this.commit();this.render();this.closeClearDialog();this.toast('画板已清空，可用撤销恢复。');}

    requestClearStorage(){
      this.closePopovers();if(this.backgroundRemovalInProgress||this.watermarkRemovalInProgress||this.editingBusy){this.toast('请等待图片处理完成后再清理画板数据。');return;}$('#storage-dialog').hidden=false;setTimeout(()=>$('#storage-confirm').focus(),0);
    }
    closeStorageDialog(){$('#storage-dialog').hidden=true;this.container.focus({preventScroll:true});}
    async confirmClearStorage(){
      if(this.backgroundRemovalInProgress||this.watermarkRemovalInProgress||this.editingBusy){this.toast('请等待图片处理完成后再清理画板数据。');return;}
      const confirmButton=$('#storage-confirm');confirmButton.disabled=true;
      try{
        this.cancelImageCrop();this.cancelWatermarkRemoval();this.penDraft=null;this.penDrag=null;this.penEdit=null;this.rotationDrag=null;
        clearTimeout(this.saveTimer);this.dirty=false;await this.saveQueue.catch(()=>{});await this.store.withLock('documents',()=>this.store.clearDrawingData());
        const id=`f${newId().slice(1)}`,now=Date.now(),document=this.blankDocument();
        this.fileIndex={current:id,files:[{id,name:'Untitled',updatedAt:now}]};this.currentFileId=id;this.documentRevision=0;this.elements=[];this.aiTaskReceipts=new Map();this.aiBoardEpoch++;this.currentElement=null;this.scale=1;this.offsetX=0;this.offsetY=0;
        this.imageCache.clear();this.spatialIndex.clear();this.spatialDirty=true;this.gridRenderKey='';this.saveQueue=Promise.resolve();
        this.openCvSandbox?.remove();this.openCvSandbox=null;this.openCvSandboxReadyPromise=null;
        this.clearSelection();this.resetHistory();$('#file-name').value='Untitled';this.sizeFileName();this.updateZoomUI();
        await this.storageSet({[this.INDEX_KEY]:this.fileIndex,[this.fileKey(id)]:document});await this.syncExportDirectoryUI();this.closeStorageDialog();this.render();this.toast('画板数据已清理，偏好和导出目录已保留。');
      }catch(error){console.error('Quickdraw clear storage failed',error);this.toast('清除本地存储失败。');}
      finally{confirmButton.disabled=false;}
    }

    syncGridUI(){$$('#grid-control button').forEach(b=>b.classList.toggle('active',b.dataset.grid===this.gridType));}
    syncPreferenceUI(){$$('#snap-control button').forEach(b=>b.classList.toggle('active',(b.dataset.enabled==='true')===this.snapToGrid));}
    applyTheme(){this.app.dataset.theme=this.theme;$$('#theme-control button').forEach(b=>b.classList.toggle('active',b.dataset.theme===this.theme));}

    toast(msg){const t=$('#toast');t.textContent=msg;t.hidden=false;clearTimeout(this.toastTimer);this.toastTimer=setTimeout(()=>t.hidden=true,2600);}

    // ---------- export ----------
    xmlEscape(value) { return String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;'); }
    svgNum(n) { return Number.isFinite(Number(n))?Number(n).toFixed(2).replace(/\.00$/,'').replace(/(\.\d)0$/,'$1'):'0'; }
    svgDash(el) { return el.dash==='dashed'?'12 8':el.dash==='dotted'?'2 8':''; }
    patternId(color){return`qd-hatch-${QDCore.hashString(String(color||this.currentColor))}`;}

    svgShapeMarkup(el) {
      const n=v=>this.svgNum(v), esc=v=>this.xmlEscape(v);
      const x1=Math.min(el.x,el.x+(el.w||0)), y1=Math.min(el.y,el.y+(el.h||0)), w=Math.abs(el.w||0), h=Math.abs(el.h||0), cx=x1+w/2,cy=y1+h/2;
      const color=el.color||this.currentColor, stroke=el.stroke==='none'?'none':color, dash=this.svgDash(el);
      const strokeAttrs=`stroke="${esc(stroke)}" stroke-width="${n(el.size||4)}" stroke-linecap="round" stroke-linejoin="round"${dash?` stroke-dasharray="${dash}"`:''}`;
      let fill='none',fillOpacity='1';
      if(el.fill==='solid')fill=color;else if(el.fill==='semi'){fill=color;fillOpacity='.2';}else if(el.fill==='pattern')fill=`url(#${this.patternId(color)})`;
      const attrs=`fill="${esc(fill)}" fill-opacity="${fillOpacity}" ${strokeAttrs}`;
      if(el.type==='rect')return `<rect x="${n(x1)}" y="${n(y1)}" width="${n(w)}" height="${n(h)}" ${attrs}/>`;
      if(el.type==='ellipse')return `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(w/2)}" ry="${n(h/2)}" ${attrs}/>`;
      let d='';
      if(el.type==='triangle')d=`M ${n(cx)} ${n(y1)} L ${n(x1+w)} ${n(y1+h)} L ${n(x1)} ${n(y1+h)} Z`;
      else if(el.type==='diamond')d=`M ${n(cx)} ${n(y1)} L ${n(x1+w)} ${n(cy)} L ${n(cx)} ${n(y1+h)} L ${n(x1)} ${n(cy)} Z`;
      else if(el.type==='hexagon')d=`M ${n(x1+w*.25)} ${n(y1)} L ${n(x1+w*.75)} ${n(y1)} L ${n(x1+w)} ${n(cy)} L ${n(x1+w*.75)} ${n(y1+h)} L ${n(x1+w*.25)} ${n(y1+h)} L ${n(x1)} ${n(cy)} Z`;
      else if(el.type==='star'){
        const pts=[];for(let i=0;i<10;i++){const a=-Math.PI/2+i*Math.PI/5,r=i%2?.45:1;pts.push(`${n(cx+Math.cos(a)*w/2*r)},${n(cy+Math.sin(a)*h/2*r)}`);}return `<polygon points="${pts.join(' ')}" ${attrs}/>`;
      }else if(el.type==='cloud')d=`M ${n(x1+w*.18)} ${n(y1+h*.78)} C ${n(x1-w*.04)} ${n(y1+h*.78)},${n(x1-w*.04)} ${n(y1+h*.45)},${n(x1+w*.22)} ${n(y1+h*.45)} C ${n(x1+w*.25)} ${n(y1+h*.16)},${n(x1+w*.60)} ${n(y1+h*.08)},${n(x1+w*.72)} ${n(y1+h*.36)} C ${n(x1+w*1.04)} ${n(y1+h*.31)},${n(x1+w*1.10)} ${n(y1+h*.73)},${n(x1+w*.82)} ${n(y1+h*.78)} Z`;
      return `<path d="${d}" ${attrs}/>`;
    }

    svgTextMarkup(el) {
      const n=v=>this.svgNum(v), esc=v=>this.xmlEscape(v),fs=el.fontSize||18,lh=fs*1.2, color=el.color||this.currentColor;
      const lines=String(el.text||'').split('\n');
      return `<text x="${n(el.x)}" y="${n(el.y)}" fill="${esc(color)}" font-size="${n(fs)}" font-family="Arial,Helvetica,sans-serif" dominant-baseline="text-before-edge">${lines.map((line,i)=>`<tspan x="${n(el.x)}" dy="${i? n(lh):'0'}">${esc(line||' ')}</tspan>`).join('')}</text>`;
    }

    svgMarkdownNoteMarkup(el){
      const n=v=>this.svgNum(v),esc=v=>this.xmlEscape(v),w=el.w||180,h=el.h||130,base=el.fontSize||15,bg=el.bgColor||(this.theme==='dark'?'#6f5b20':'#fff0a6'),fg=el.color||(this.theme==='dark'?'#fff8dc':'#2b261d'),rows=[];
      for(const raw of String(el.text||'').split('\n')){
        let text=raw,size=base,weight=400,prefix='';
        const heading=text.match(/^(#{1,3})\s+(.*)$/);
        if(heading){size=base*({1:1.55,2:1.3,3:1.12}[heading[1].length]);weight=700;text=heading[2];}
        else{const bullet=text.match(/^\s*[-*+]\s+(.*)$/),numbered=text.match(/^\s*(\d+)\.\s+(.*)$/);if(bullet){prefix='• ';text=bullet[1];}else if(numbered){prefix=`${numbered[1]}. `;text=numbered[2];}}
        const capacity=Math.max(4,Math.floor((w-24)/(size*.62))),segments=[...(prefix?[{text:prefix,bold:weight>=600}]:[]),...this.parseMarkdownInline(text)];
        let row={segments:[],size,weight},used=0;
        const flush=()=>{if(!row.segments.length)row.segments.push({text:' '});rows.push(row);row={segments:[],size,weight};used=0;};
        for(const segment of segments)for(const ch of [...String(segment.text||'')]){if(used>=capacity)flush();const styleKey=`${!!segment.bold}|${!!segment.italic}|${!!segment.code}|${!!segment.link}`,last=row.segments.at(-1);if(last?._styleKey===styleKey)last.text+=ch;else row.segments.push({...segment,text:ch,_styleKey:styleKey});used++;}
        flush();
      }
      let y=el.y+12,markup='';for(const row of rows){const lh=row.size*1.35;if(y+lh>el.y+h-6)break;markup+=`<text x="${n(el.x+12)}" y="${n(y)}" fill="${esc(fg)}" font-size="${n(row.size)}" font-family="system-ui,Segoe UI,Arial,sans-serif" dominant-baseline="text-before-edge">${row.segments.map((segment,index)=>`<tspan${index?'' : ` x="${n(el.x+12)}"`} font-weight="${segment.bold?700:row.weight}" font-style="${segment.italic?'italic':'normal'}" font-family="${segment.code?'ui-monospace,Consolas,monospace':'system-ui,Segoe UI,Arial,sans-serif'}" fill="${segment.link?'#2f6fed':esc(fg)}">${esc(segment.text||' ')}</tspan>`).join('')}</text>`;y+=lh;}return`<g><rect x="${n(el.x)}" y="${n(el.y)}" width="${n(w)}" height="${n(h)}" fill="${esc(bg)}"/>${markup}</g>`;
    }

    svgMindConnectionsMarkup() {
      const n=v=>this.svgNum(v),esc=v=>this.xmlEscape(v),out=[],paper=this.theme==='dark'?'#191713':'#F9FAFB';
      for(const edge of this.elements){
        if(edge.type!=='mindedge'||!this.isElementVisible(edge))continue;const pts=this.mindEdgeSamplePoints(edge);if(pts.length<2)continue;const stroke=edge.color||(this.theme==='dark'?'#9aa3ad':'#7d8794'),d=pts.map((p,i)=>`${i?'L':'M'} ${n(p.x)} ${n(p.y)}`).join(' ');
        out.push(`<path d="${d}" fill="none" stroke="${esc(stroke)}" stroke-width="${n(edge.size||1.6)}" stroke-linecap="round" stroke-linejoin="round"/>`);
        if(edge.arrow){let i=pts.length-2;while(i>0&&Math.hypot(pts.at(-1).x-pts[i].x,pts.at(-1).y-pts[i].y)<.01)i--;const a=pts[i],b=pts.at(-1),ang=Math.atan2(b.y-a.y,b.x-a.x),len=10,a1={x:b.x-len*Math.cos(ang-.55),y:b.y-len*Math.sin(ang-.55)},a2={x:b.x-len*Math.cos(ang+.55),y:b.y-len*Math.sin(ang+.55)};out.push(`<path d="M ${n(a1.x)} ${n(a1.y)} L ${n(b.x)} ${n(b.y)} L ${n(a2.x)} ${n(a2.y)}" fill="none" stroke="${esc(stroke)}" stroke-width="${n(edge.size||1.6)}" stroke-linecap="round" stroke-linejoin="round"/>`);}
        if(edge.label){const q=this.mindEdgeLabelPoint(edge,pts),text=String(edge.label),w=Math.max(22,text.length*12+10),h=20;out.push(`<rect x="${n(q.x-w/2)}" y="${n(q.y-h/2)}" width="${n(w)}" height="${n(h)}" rx="4" fill="${paper}"/><text x="${n(q.x)}" y="${n(q.y)}" text-anchor="middle" dominant-baseline="middle" fill="${this.theme==='dark'?'#e5e7eb':'#4b5563'}" font-size="12" font-family="Arial,Helvetica,sans-serif">${esc(text)}</text>`);}
      }
      return out.join('');
    }

    svgElementMarkup(el) {
      const markup=this.svgRawElementMarkup(el);
      return el.transform?`<g transform="matrix(${el.transform.map(v=>this.svgNum(v)).join(' ')})">${markup}</g>`:markup;
    }

    svgRawElementMarkup(el) {
      if(el.type==='path')return this.svgVectorPath(el);
      const n=v=>this.svgNum(v),esc=v=>this.xmlEscape(v),color=el.color||this.currentColor,dash=this.svgDash(el),dashAttr=dash?` stroke-dasharray="${dash}"`:'';
      if(el.type==='draw'||el.type==='highlight'){
        const pts=el.points||[];if(!pts.length)return '';
        if(pts.length===1)return `<circle cx="${n(pts[0].x)}" cy="${n(pts[0].y)}" r="${n(el.type==='highlight'?(el.size||4)*2:(el.size||4)/2)}" fill="${esc(color)}" opacity="${el.type==='highlight'?'.28':'1'}"/>`;
        if(el.type==='highlight')return `<polyline points="${pts.map(point=>`${n(point.x)},${n(point.y)}`).join(' ')}" fill="none" stroke="${esc(color)}" stroke-width="${n((el.size||4)*4)}" stroke-linecap="round" stroke-linejoin="round" opacity=".28"/>`;
        const closed=el.type==='draw'&&el.fill&&el.fill!=='none'&&this.isClosedFreehand(el),path=closed?`<path d="${pts.map((point,index)=>`${index?'L':'M'} ${n(point.x)} ${n(point.y)}`).join(' ')} Z" fill="${el.fill==='pattern'?`url(#${this.patternId(color)})`:esc(color)}" fill-opacity="${el.fill==='semi'?'.2':'1'}" stroke="none"/>`:'';
        const strokes=pts.slice(1).map((b,i)=>{const a=pts[i],p=b.pressure||a.pressure||.5,width=(el.size||4)*(.65+p*.7);return `<line x1="${n(a.x)}" y1="${n(a.y)}" x2="${n(b.x)}" y2="${n(b.y)}" stroke="${esc(color)}" stroke-width="${n(width)}" stroke-linecap="round"/>`;}).join('');
        const closing=closed?`<line x1="${n(pts.at(-1).x)}" y1="${n(pts.at(-1).y)}" x2="${n(pts[0].x)}" y2="${n(pts[0].y)}" stroke="${esc(color)}" stroke-width="${n(el.size||4)}" stroke-linecap="round"/>`:'';return path+strokes+closing;
      }
      if(el.type==='line'||el.type==='arrow'){
        const ex=el.x+(el.w||0),ey=el.y+(el.h||0);if(el.type==='line')return `<line x1="${n(el.x)}" y1="${n(el.y)}" x2="${n(ex)}" y2="${n(ey)}" stroke="${esc(color)}" stroke-width="${n(el.size||4)}" stroke-linecap="round"${dashAttr}/>`;
        const g=this.arrowGeometry(el),base=Math.abs(el.bend||0)>.01?`<path d="M ${n(el.x)} ${n(el.y)} Q ${n(g.cx)} ${n(g.cy)} ${n(ex)} ${n(ey)}" fill="none" stroke="${esc(color)}" stroke-width="${n(el.size||4)}" stroke-linecap="round"${dashAttr}/>`:`<line x1="${n(el.x)}" y1="${n(el.y)}" x2="${n(ex)}" y2="${n(ey)}" stroke="${esc(color)}" stroke-width="${n(el.size||4)}" stroke-linecap="round"${dashAttr}/>`;
        const ang=Math.atan2(ey-g.cy,ex-g.cx),len=12+(el.size||4)*1.5,a1={x:ex-len*Math.cos(ang-.55),y:ey-len*Math.sin(ang-.55)},a2={x:ex-len*Math.cos(ang+.55),y:ey-len*Math.sin(ang+.55)};
        return base+`<path d="M ${n(a1.x)} ${n(a1.y)} L ${n(ex)} ${n(ey)} L ${n(a2.x)} ${n(a2.y)}" fill="none" stroke="${esc(color)}" stroke-width="${n(el.size||4)}" stroke-linecap="round" stroke-linejoin="round"/>`;
      }
      if(['rect','ellipse','triangle','diamond','hexagon','star','cloud'].includes(el.type))return this.svgShapeMarkup(el);
      if(el.type==='text')return this.svgTextMarkup(el);
      if(el.type==='mindnode'){
        const w=el.w||150,h=el.h||44,fs=el.fontSize||15,isRoot=!el.parentId&&!el.mermaid,bg=el.bgColor||(this.theme==='dark'?(isRoot?'#34302a':'#24211d'):(isRoot?'#fffdf8':'#ffffff')),bgOpacity=el.bgOpacity==null?1:clamp(Number(el.bgOpacity),0,1),stroke=el.color||(this.theme==='dark'?'#d8d3ca':'#5d5952'),shape=el.nodeShape||'rounded';
        this.ctx.save();this.ctx.font=`${isRoot?600:500} ${fs}px ui-sans-serif,system-ui,sans-serif`;const lines=this.getMindNodeLines(this.ctx,el.text||'',Math.max(36,w-(shape==='diamond'?42:24)));this.ctx.restore();const lh=fs*1.3,start=el.y+h/2-(lines.length-1)*lh/2;
        let nodeMarkup='';
        if(shape==='diamond')nodeMarkup=`<path d="M ${n(el.x+w/2)} ${n(el.y)} L ${n(el.x+w)} ${n(el.y+h/2)} L ${n(el.x+w/2)} ${n(el.y+h)} L ${n(el.x)} ${n(el.y+h/2)} Z" fill="${esc(bg)}" fill-opacity="${n(Number.isFinite(bgOpacity)?bgOpacity:1)}" stroke="${esc(stroke)}" stroke-width="${isRoot?'2':'1.35'}"/>`;
        else if(shape==='ellipse')nodeMarkup=`<ellipse cx="${n(el.x+w/2)}" cy="${n(el.y+h/2)}" rx="${n(w/2)}" ry="${n(h/2)}" fill="${esc(bg)}" fill-opacity="${n(Number.isFinite(bgOpacity)?bgOpacity:1)}" stroke="${esc(stroke)}" stroke-width="${isRoot?'2':'1.35'}"/>`;
        else nodeMarkup=`<rect x="${n(el.x)}" y="${n(el.y)}" width="${n(w)}" height="${n(h)}" rx="${n(shape==='pill'?h/2:shape==='rect'?4:Math.min(10,h/2))}" fill="${esc(bg)}" fill-opacity="${n(Number.isFinite(bgOpacity)?bgOpacity:1)}" stroke="${esc(stroke)}" stroke-width="${isRoot?'2':'1.35'}"/>`;
        return `<g>${nodeMarkup}<text text-anchor="middle" dominant-baseline="middle" fill="${esc(el.textColor||(this.theme==='dark'?'#ffffff':'#292722'))}" font-size="${n(fs)}" font-weight="${isRoot?'600':'500'}" font-family="Arial,Helvetica,sans-serif">${lines.map((line,i)=>`<tspan x="${n(el.x+w/2)}" y="${n(start+i*lh)}">${esc(line||' ')}</tspan>`).join('')}</text></g>`;
      }
      if(el.type==='note'){
        return this.svgMarkdownNoteMarkup(el);
      }
      if(el.type==='image'){const source=this.exportAssetData?.get(el.assetId)||el.src;if(source)return `<image href="${esc(source)}" x="${n(el.x)}" y="${n(el.y)}" width="${n(el.w)}" height="${n(el.h)}" preserveAspectRatio="none"/>`;}
      return '';
    }

    async createSVGDocument(transparent=false) {
      await this.waitForImages();
      this.exportAssetData=new Map();for(const el of this.elements.filter(item=>item.type==='image'&&item.assetId)){const asset=await this.store.getAsset(el.assetId);if(asset?.blob)this.exportAssetData.set(el.assetId,await this.store.blobToDataUrl(asset.blob));}
      const b=this.contentBounds()||{x:(-this.offsetX)/this.scale,y:(-this.offsetY)/this.scale,w:this.width/this.scale,h:this.height/this.scale},pad=32,x=b.x-pad,y=b.y-pad,w=Math.max(1,b.w+pad*2),h=Math.max(1,b.h+pad*2),paper=this.theme==='dark'?'#191713':'#F9FAFB';
      const patternColors=[...new Set(this.elements.filter(el=>this.isElementVisible(el)&&el.fill==='pattern').map(el=>el.color||this.currentColor))],defs=`<defs>${patternColors.map(color=>`<pattern id="${this.patternId(color)}" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="10" stroke="${this.xmlEscape(color)}" stroke-width="1.2" opacity=".35"/></pattern>`).join('')}</defs>`;
      const background=transparent?'':`<rect x="${this.svgNum(x)}" y="${this.svgNum(y)}" width="${this.svgNum(w)}" height="${this.svgNum(h)}" fill="${paper}"/>`;
      const body=this.svgMindConnectionsMarkup()+this.elements.filter(el=>this.isElementVisible(el)).map(el=>this.svgElementMarkup(el)).join('');
      return {svg:`<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${this.svgNum(w)}" height="${this.svgNum(h)}" viewBox="${this.svgNum(x)} ${this.svgNum(y)} ${this.svgNum(w)} ${this.svgNum(h)}">${defs}${background}${body}</svg>`,width:w,height:h};
    }

    async downloadBlob(blob,filename) {
      const safeName=QDCore.safeFilename(filename),directory=await this.getExportDirectory();
      if(directory){
        try{
          let permission=await directory.queryPermission({mode:'readwrite'});
          if(permission==='prompt'&&navigator.userActivation?.isActive)permission=await directory.requestPermission({mode:'readwrite'});
          if(permission==='granted'){const file=await directory.getFileHandle(safeName,{create:true}),writable=await file.createWritable();await writable.write(blob);await writable.close();return;}
        }catch(error){console.warn('Quickdraw direct directory export failed',error);}
      }
      const url=URL.createObjectURL(blob);
      try{if(globalThis.chrome?.downloads){await chrome.downloads.download({url,filename:safeName,saveAs:false});setTimeout(()=>URL.revokeObjectURL(url),30000);return;}const a=document.createElement('a');a.href=url;a.download=safeName;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch{URL.revokeObjectURL(url);throw new Error('download');}
    }

    exportBaseName() { const file=this.fileIndex?.files?.find(f=>f.id===this.currentFileId);return (file?.name||'Quickdraw').replace(/[\\/:*?"<>|]/g,'_'); }

    async exportSVG() {
      try{const {svg}=await this.createSVGDocument(true);await this.downloadBlob(new Blob([svg],{type:'image/svg+xml;charset=utf-8'}),`${this.exportBaseName()}.svg`);this.toast('SVG 已导出：文字和形状可继续编辑。');}catch{this.toast('SVG 导出失败。');}
    }

    /* PDF export removed
      try{
        const data=await this.createSVGDocument(false);
        if(globalThis.chrome?.storage?.local&&globalThis.chrome?.tabs?.create){
          const exportId=crypto.randomUUID(),key=`quickdraw_pdf_export:${exportId}`;
          await chrome.storage.local.set({[key]:{...data,title:this.exportBaseName(),createdAt:Date.now()}});
          await chrome.tabs.create({url:`${chrome.runtime.getURL('print.html')}?export=${encodeURIComponent(exportId)}`});
          this.toast('已打开矢量打印页；在打印窗口选择“另存为 PDF”。');
        }else{
          const html=`<!doctype html><meta charset="utf-8"><title>${this.xmlEscape(this.exportBaseName())}</title><style>@page{size:${data.width}px ${data.height}px;margin:0}html,body{margin:0;padding:0}svg{display:block;width:${data.width}px;height:${data.height}px}</style>${data.svg}<script>setTimeout(()=>print(),250)<\\/script>`;
          const url=URL.createObjectURL(new Blob([html],{type:'text/html'}));window.open(url,'_blank','noopener');setTimeout(()=>URL.revokeObjectURL(url),60000);
        }
      }catch{this.toast('PDF 矢量导出失败。');}
    */

    exportElementsFor(requested=null){
      if(!requested)return this.elements.filter(el=>this.isElementVisible(el));
      const source=requested.filter(el=>this.elements.includes(el)&&this.isElementVisible(el)),ids=new Set(source.map(el=>el.id)),nodeIds=new Set(source.filter(el=>el.type==='mindnode').map(el=>el.id));
      for(const edge of this.elements)if(edge.type==='mindedge'&&this.isElementVisible(edge)&&(ids.has(edge.id)||(nodeIds.has(edge.fromId)&&nodeIds.has(edge.toId)))&&!ids.has(edge.id)){source.unshift(edge);ids.add(edge.id);}
      return source;
    }

    async waitForImages(items=this.elements){await Promise.all(items.filter(e=>e.type==='image').map(e=>new Promise(resolve=>{const img=this.getCachedImage(e);if(img?.complete&&img.naturalWidth)return resolve();const done=()=>resolve();img?.addEventListener('load',done,{once:true});img?.addEventListener('error',done,{once:true});setTimeout(done,2000);})));}

    async createPNGBlob(transparent=false,requested=null){
      const items=this.exportElementsFor(requested);if(!items.length)throw new Error('empty-export');await this.waitForImages(items);this.exporting=true;
      try{const b=this.getElementsBBox(items)||{x:(-this.offsetX)/this.scale,y:(-this.offsetY)/this.scale,w:this.width/this.scale,h:this.height/this.scale},pad=32,scale=2,width=Math.ceil((b.w+pad*2)*scale),height=Math.ceil((b.h+pad*2)*scale);if(width>32767||height>32767||width*height>120_000_000)throw new Error('canvas-too-large');const c=document.createElement('canvas');c.width=width;c.height=height;const ctx=c.getContext('2d');if(!ctx)throw new Error('canvas-unavailable');if(!transparent){ctx.fillStyle=this.theme==='dark'?'#191713':'#F9FAFB';ctx.fillRect(0,0,c.width,c.height);}ctx.save();ctx.scale(scale,scale);ctx.translate(-b.x+pad,-b.y+pad);for(const edge of items)if(edge.type==='mindedge')this.drawMindEdge(ctx,edge,false);for(const el of items)if(el.type!=='mindedge')this.drawElement(ctx,el);ctx.restore();return await new Promise((resolve,reject)=>c.toBlob(blob=>blob?resolve(blob):reject(new Error('png-encode-failed')),'image/png'));}finally{this.exporting=false;}
    }

    async exportPNG(transparent=false){try{const blob=await this.createPNGBlob(transparent);await this.downloadBlob(blob,`${this.exportBaseName()}.png`);}catch(error){console.error(error);this.toast(error?.message==='canvas-too-large'?'导出范围过大，请缩小对象间距后重试。':'PNG 导出失败。');}}
    async copyPNG(items=null){try{const blob=await this.createPNGBlob(true,items);await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);this.toast(items?'所选对象已复制为 PNG。':'PNG 已复制到剪贴板。');}catch(error){console.error(error);this.toast('无法复制 PNG，请使用下载导出。');}}
    async copySVG(){try{const {svg}=await this.createSVGDocument(true);await navigator.clipboard.writeText(svg);this.toast('SVG 源码已复制到剪贴板。');}catch(error){console.error(error);this.toast('无法复制 SVG。');}}
  }

  Object.assign(QuickdrawBoard.prototype,globalThis.QDEditing);
  globalThis.QuickdrawBoard=QuickdrawBoard;
  if(typeof document!=='undefined')document.addEventListener('DOMContentLoaded',()=>{window.quickdraw=new QuickdrawBoard();});
})();
