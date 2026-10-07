(() => {
  'use strict';

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const clone = globalThis.QDCore.clone;
  const newId = () => globalThis.QDCore.newId('e');
  const MAX_AI_OUTPUT_IMAGES = Number(globalThis.QuickdrawAI?.MAX_INPUT_IMAGES || 4);
  const COLOR_PALETTES = [
    { name:'多巴胺', colors:['#A785FE','#FF7BB5','#F73A2C','#FF7131','#FEE717','#557EF2','#45B4FC','#03BF61','#DDF977','#2B2B2B','#F2F2F2'] },
    { name:'浅霏', colors:['#E3ECB3','#E9E9CF','#E9F2FB','#D8ECEA','#FDE9EA','#E8EAF6','#F9EEF6','#E2D9EC','#FBFBDD','#FFF5E1','#D2E4F5'] },
    { name:'糖果', colors:['#E4465E','#EF6F8C','#FE8F00','#FFEB17','#BDCB22','#5DC6C3','#6B9ACE','#AAABC4','#B7D0EA','#E3BEA4','#F0EFEB'] },
    { name:'国风', colors:['#326257','#1F9B90','#E70500','#C25B58','#F6C12C','#6C5CE8','#1A4F98','#6B9ACE','#0D1219','#DEDEDE','#FAFAFA'] },
    { name:'复古', colors:['#CE0000','#A0522D','#D4B87A','#4A6741','#5FB3B3','#234497','#7E6BB8','#F0E68C','#2B2B2B','#C0C0C0','#F5EDE2'] },
    { name:'莫兰迪', colors:['#4A4B7B','#8E86C2','#881A1F','#DB5476','#DD793E','#C4A37E','#98AA72','#F9DF9D','#1D1D1D','#EDF1F4','#FAFAFA'] }
  ];

  class QuickdrawBoard {
    constructor() {
      this.app = $('#app');
      this.container = $('#canvas-container');
      this.gridCanvas = $('#grid-canvas');
      this.paintCanvas = $('#paint-canvas');
      this.gridCtx = this.gridCanvas.getContext('2d');
      this.ctx = this.paintCanvas.getContext('2d');

      this.elements = [];
      this.groups = [];
      this.imageCache = new Map();
      this.currentTool = 'select';
      this.currentShape = 'rect';
      this.currentColor = '#2B2B2B';
      this.currentFillColor = this.currentColor;
      this.currentStrokeColor = this.currentColor;
      this.currentTextSize = 28;
      this.currentArrowHeadSize = 'M';
      this.sizeControlMode = 'text';
      this.wheelZoomLocked = false;
      this.currentSize = 3;
      this.currentDash = 'solid';
      this.currentFill = 'none';
      this.currentStroke = 'solid';
      this.currentOpacity = 1;
      this.currentMindStyle = 'rounded';
      this.gridType = 'lines';
      this.theme = 'light';
      this.colorPaletteIndex = 0;

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
      this.textDraft = null;
      this.editingBusy = false;
      this.cropRatio = 0;
      this.mindLinkDraft = null;
      this.mindEdgePointDrag = null;
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
      this.aiDiagramType = 'flowchart';
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
      this.assetGcQueue = Promise.resolve();
      this.lastAssetGcAt = 0;
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
      this.aiDiagramType = globalThis.QuickdrawAI?.normalizeDiagramType?.(prefs.aiDiagramType) || 'flowchart';
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

    blankDocument() { return globalThis.QuickdrawDocumentModel.createBlank(); }

    serializeDocument() {
      return globalThis.QuickdrawDocumentModel.encode({
        version: globalThis.QuickdrawDocumentModel.CURRENT_VERSION,
        revision: this.documentRevision,
        updatedBy: this.instanceId,
        elements: clone(this.elements),
        groups: clone(this.groups),
        camera: { scale: this.scale, offsetX: this.offsetX, offsetY: this.offsetY },
        aiTaskReceipts: Object.fromEntries(this.aiTaskReceipts || [])
      });
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
      // Reclaim orphaned image blobs after the document is safely persisted.
      // Throttled and fully backgrounded: never block or fail the save itself.
      this.saveQueue.then(() => this.runAssetGarbageCollection()).catch(() => {});
      return this.saveQueue;
    }

    // Collect every assetId that is still reachable from live documents, undo/redo
    // history, stored version snapshots or in-flight AI tasks. Anything not in this
    // set is an orphan blob that is safe to delete from IndexedDB.
    async collectReferencedAssetIds() {
      const keep = new Set();
      const addElement = element => { if (element?.assetId) keep.add(String(element.assetId)); };
      const addElements = elements => (elements || []).forEach(addElement);
      const addReceipts = receipts => {
        for (const receipt of Object.values(receipts || {})) {
          if (receipt?.outputAssetId) keep.add(String(receipt.outputAssetId));
          (receipt?.outputAssetIds || []).forEach(id => id && keep.add(String(id)));
        }
      };
      // Live board (may include edits not persisted yet) and its undo/redo history,
      // so cropping/removing a background stays undoable after a GC pass.
      addElements(this.elements);
      for (const patch of [...(this.history || []), ...(this.redos || [])]) {
        for (const change of patch.changes || []) { addElement(change.before); addElement(change.after); }
      }
      addReceipts(Object.fromEntries(this.aiTaskReceipts || []));
      // Every persisted document across all boards.
      const index = (await this.storageGet([this.INDEX_KEY]))[this.INDEX_KEY];
      const fileIds = (index?.files || []).map(file => file.id);
      if (fileIds.length) {
        const documents = await this.storageGet(fileIds.map(id => this.fileKey(id)));
        for (const id of fileIds) {
          const document = documents[this.fileKey(id)];
          addElements(document?.elements);
          addReceipts(document?.aiTaskReceipts);
        }
        // Stored version snapshots (up to 30 per board).
        for (const id of fileIds) {
          try {
            const versions = await this.store.listVersions(id);
            for (const version of versions) addElements(version.document?.elements);
          } catch (error) { console.warn('Quickdraw version scan failed', error); }
        }
      }
      // Inputs/outputs owned by background AI tasks that have not been cleaned up.
      try {
        const tasks = (await this.store.get('quickdraw_ai_tasks_v1'))['quickdraw_ai_tasks_v1'];
        for (const task of Array.isArray(tasks) ? tasks : []) {
          if (task.inputAssetId) keep.add(String(task.inputAssetId));
          if (task.outputAssetId) keep.add(String(task.outputAssetId));
          (task.inputAssetIds || []).forEach(id => id && keep.add(String(id)));
          (task.inputAssets || []).forEach(item => item?.assetId && keep.add(String(item.assetId)));
          (task.outputImages || []).forEach(item => item?.assetId && keep.add(String(item.assetId)));
        }
      } catch (error) { console.warn('Quickdraw AI task scan failed', error); }
      return keep;
    }

    isImageEditBusy() {
      return !!(this.editingBusy || this.backgroundRemovalInProgress || this.watermarkRemovalInProgress || this.cropTarget || this.watermarkTarget);
    }

    async runAssetGarbageCollection(options = {}) {
      const force = options.force === true;
      const now = Date.now();
      if (!force && now - this.lastAssetGcAt < 60_000) return;
      // Never collect while an edit may have staged a new asset that is not yet
      // attached to an element; the next save will run the GC instead.
      if (this.isImageEditBusy()) return;
      this.assetGcQueue = this.assetGcQueue.catch(() => {}).then(async () => {
        if (this.isImageEditBusy()) return;
        const referenced = await this.collectReferencedAssetIds();
        await this.store.cleanupAssets(referenced);
        this.lastAssetGcAt = Date.now();
      }).catch(error => console.warn('Quickdraw asset GC failed', error));
      return this.assetGcQueue;
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
        const doc = globalThis.QuickdrawDocumentModel.normalizeDocument(data[this.fileKey(id)] || this.blankDocument());
        this.elements = doc.elements;
        this.groups = doc.groups;
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
        if (migratedImages || doc.migrated) await this.saveFileNow({ snapshot: false });
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
      this.runAssetGarbageCollection({ force: true }).catch(error=>console.warn('Quickdraw asset GC failed',error));
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
      this.historyBaseline = { elements: clone(this.elements), groups: clone(this.groups) };
      this.spatialDirty = true;
      this.updateHistoryUI();
    }

    commit() {
      const next = { elements: clone(this.elements), groups: clone(this.groups) };
      const before = this.historyBaseline || { elements: [], groups: [] };
      if (JSON.stringify(before) !== JSON.stringify(next)) {
        this.history.push({ before: clone(before), after: clone(next) });
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
      this.elements = clone(patch.before.elements);
      this.groups = clone(patch.before.groups || []);
      this.redos.push(patch);
      this.historyBaseline = { elements: clone(this.elements), groups: clone(this.groups) };
      this.spatialDirty = true;
      this.clearSelection();
      this.updateHistoryUI(); this.scheduleSave(); this.render();
    }

    redo() {
      if (!this.redos.length) return;
      const patch = this.redos.pop();
      this.elements = clone(patch.after.elements);
      this.groups = clone(patch.after.groups || []);
      this.history.push(patch);
      this.historyBaseline = { elements: clone(this.elements), groups: clone(this.groups) };
      this.spatialDirty = true;
      this.clearSelection();
      this.updateHistoryUI(); this.scheduleSave(); this.render();
    }

    updateHistoryUI() {
      $('#btn-undo').disabled = this.history.length === 0;
      $('#btn-redo').disabled = this.redos.length === 0;
      $('#btn-duplicate').disabled = this.getSelectedElements().length === 0;
      const selected=this.getSelectedElements();
      const opacityTypes=new Set(['image','path','draw','highlight','line','arrow','rect','roundrect','ellipse','triangle','diamond','hexagon','star','cloud']);
      const opacityButton=$('#btn-opacity');if(opacityButton)opacityButton.disabled=!selected.some(el=>opacityTypes.has(el.type));
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
      this.syncOpacityUI?.();
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

    fitBounds(b) {
      if(!b)return false;
      const pad = Math.min(100, Math.min(this.width, this.height) * .12);
      const sx = (this.width - pad * 2) / Math.max(1, b.w);
      const sy = (this.height - pad * 2) / Math.max(1, b.h);
      this.scale = clamp(Math.min(sx, sy), .1, 4);
      this.offsetX = this.width / 2 - (b.x + b.w / 2) * this.scale;
      this.offsetY = this.height / 2 - (b.y + b.h / 2) * this.scale;
      this.updateZoomUI(); this.scheduleSave(); this.render();return true;
    }

    fitContent() { const b=this.contentBounds();if(!b)return this.resetZoom();this.fitBounds(b); }
    fitSelection() { const items=this.getSelectedElements();if(!items.length)return this.toast('请先选择要缩放查看的内容。');this.fitBounds(this.getElementsBBox(items)); }

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
      ctx.strokeStyle = el.strokeColor || el.color || this.currentStrokeColor || this.currentColor;
      ctx.fillStyle = el.fillColor || el.color || this.currentFillColor || this.currentColor;
      const matrix=QDVector.matrix(el),transformScale=Math.sqrt(Math.abs(matrix[0]*matrix[3]-matrix[1]*matrix[2]))||1;
      ctx.lineWidth = (el.size || 2)/transformScale;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (el.dash === 'dashed') ctx.setLineDash([8, 16]);
      else if (el.dash === 'dotted') ctx.setLineDash([1, 11]);
      else ctx.setLineDash([]);
    }

    fillCurrentPath(ctx, el) {
      if (el.fill === 'solid') { ctx.save();ctx.globalAlpha*=el.fillOpacity==null?1:clamp(Number(el.fillOpacity),0,1);ctx.fill();ctx.restore(); }
      else if (el.fill === 'pattern') {
        ctx.save(); ctx.clip(); ctx.globalAlpha *= .35; ctx.strokeStyle = el.fillColor || el.color || this.currentFillColor || this.currentColor; ctx.lineWidth = 1.2;
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
      ctx.globalAlpha*=clamp(el.opacity==null?1:Number(el.opacity),0,1);
      this.applyStrokeStyle(ctx, el);
      if(el.type==='path'){
        this.drawVectorPath(ctx,el);
      } else if (el.type === 'draw' || el.type === 'highlight') {
        const pts = el.points || [];
        if (el.type === 'highlight') {
          ctx.globalAlpha *= .28;
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
          const g=this.arrowGeometry(el), ang=Math.atan2(ey-g.cy,ex-g.cx), len=this.arrowHeadLength(el);
          ctx.setLineDash([]);
          ctx.beginPath(); ctx.moveTo(ex,ey); ctx.lineTo(ex-len*Math.cos(ang-.55), ey-len*Math.sin(ang-.55)); ctx.moveTo(ex,ey); ctx.lineTo(ex-len*Math.cos(ang+.55), ey-len*Math.sin(ang+.55)); ctx.stroke();
        }
      } else if (['rect','roundrect','ellipse','triangle','diamond','hexagon','star','cloud'].includes(el.type)) {
        const hasStroke = el.stroke !== 'none';
        this.geometryPath(ctx, el); this.fillCurrentPath(ctx, el); if (hasStroke){ctx.save();ctx.globalAlpha*=el.strokeOpacity==null?1:clamp(Number(el.strokeOpacity),0,1);ctx.stroke();ctx.restore();}
      } else if (el.type === 'text') {
        const layout=this.measureTextLayout(el,ctx);
        ctx.fillStyle = el.color || this.currentColor; ctx.setLineDash([]); ctx.font = layout.font; ctx.textBaseline='alphabetic';ctx.textAlign='left';
        layout.rows.forEach((row,i)=>{if(row.text)ctx.fillText(row.text,el.x+row.left,el.y+i*layout.lineHeight+row.ascent);});
      } else if (el.type === 'mindnode') {
        const w=el.w||150,h=el.h||44;
        const isRoot=!el.parentId&&!el.mermaid;
        const nodeBg=el.bgColor || (this.theme==='dark'?(isRoot?'#34302a':'#24211d'):(isRoot?'#fffdf8':'#ffffff'));
        const nodeBgOpacity=el.bgOpacity==null?1:clamp(Number(el.bgOpacity),0,1);
        const stroke=el.color || (this.theme==='dark'?'#d8d3ca':'#5d5952');
        const fg=el.textColor || (this.theme==='dark'?'rgba(255,255,255,.94)':'#292722');
        if(el.mermaidRole==='state-start'){
          ctx.beginPath();ctx.arc(el.x+w/2,el.y+h/2,Math.min(w,h)/2,0,Math.PI*2);ctx.fillStyle=stroke;ctx.fill();
        }else if(el.mermaidRole==='state-end'){
          const r=Math.min(w,h)/2;
          ctx.beginPath();ctx.arc(el.x+w/2,el.y+h/2,r,0,Math.PI*2);ctx.fillStyle=nodeBg;ctx.fill();ctx.strokeStyle=stroke;ctx.lineWidth=1.6*(this.exporting?1:1/this.scale);ctx.stroke();
          ctx.beginPath();ctx.arc(el.x+w/2,el.y+h/2,Math.max(3,r-5*(this.exporting?1:1/this.scale)),0,Math.PI*2);ctx.fillStyle=stroke;ctx.fill();
        }else if(el.mermaidType==='class'){
          ctx.beginPath();if(ctx.roundRect)ctx.roundRect(el.x,el.y,w,h,4);else ctx.rect(el.x,el.y,w,h);
          ctx.save();ctx.fillStyle=nodeBg;ctx.globalAlpha*=Number.isFinite(nodeBgOpacity)?nodeBgOpacity:1;ctx.fill();ctx.restore();
          ctx.strokeStyle=stroke;ctx.lineWidth=1.35*(this.exporting?1:1/this.scale);ctx.setLineDash([]);ctx.stroke();
          const rawLines=String(el.text||'').split('\n'),title=rawLines[0]||'',members=rawLines.slice(1),fs=el.fontSize||15;
          const titleH=38;
          if(members.length){ctx.beginPath();ctx.moveTo(el.x,el.y+titleH);ctx.lineTo(el.x+w,el.y+titleH);ctx.stroke();}
          ctx.fillStyle=fg;ctx.textBaseline='middle';ctx.font=`600 ${fs}px ui-sans-serif,system-ui,sans-serif`;ctx.textAlign='center';ctx.fillText(title,el.x+w/2,el.y+titleH/2);
          ctx.font=`500 ${Math.max(12,fs-1)}px ui-monospace,SFMono-Regular,Consolas,monospace`;ctx.textAlign='left';
          const lineH=22,memberY=el.y+titleH+lineH/2+5;
          members.forEach((line,i)=>{if(memberY+i*lineH<=el.y+h-8)ctx.fillText(line,el.x+12,memberY+i*lineH);});
        }else{
          if(!el.plainMind){
            this.mindNodePath(ctx,el);
            ctx.save();ctx.fillStyle=nodeBg;ctx.globalAlpha*=Number.isFinite(nodeBgOpacity)?nodeBgOpacity:1;ctx.fill();ctx.restore();
            ctx.strokeStyle=stroke;ctx.lineWidth=(isRoot?2:1.35)*(this.exporting?1:1/this.scale);ctx.setLineDash([]);ctx.stroke();
          }
          ctx.fillStyle=fg;
          ctx.font=`${isRoot?(el.plainMind?700:600):500} ${el.fontSize||15}px ui-sans-serif,system-ui,sans-serif`;
          ctx.textBaseline='middle';
          ctx.textAlign='center';
          const pad=el.nodeShape==='diamond'?42:20;
          const lines=this.getMindNodeLines(ctx,el.text||'',Math.max(36,w-pad));
          const lh=(el.fontSize||15)*1.3;
          const startY=el.y+h/2-(lines.length-1)*lh/2;
          lines.forEach((line,i)=>ctx.fillText(line,el.x+w/2,startY+i*lh));
        }
      } else if (el.type === 'note') {
        const w=el.w||180,h=el.h||130;
        ctx.fillStyle=el.bgColor || (this.theme==='dark'?'#6f5b20':'#fff0a6'); ctx.shadowColor='rgba(0,0,0,.12)'; ctx.shadowBlur=8;ctx.beginPath();if(ctx.roundRect)ctx.roundRect(el.x,el.y,w,h,10);else ctx.rect(el.x,el.y,w,h);ctx.fill();ctx.shadowColor='transparent';
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
      else if(el.type==='roundrect'){const r=Math.min(12,Math.abs(w)/2,Math.abs(h)/2);if(ctx.roundRect)ctx.roundRect(x,y,w,h,r);else ctx.rect(x,y,w,h);}
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

    markdownNoteRows(ctx,el){
      const w=el.w||180,base=el.fontSize||16,maxW=Math.max(24,w-24),rows=[];
      const fontFor=(segment,size,weight)=>`${segment.italic?'italic ':'normal '}${segment.bold?'700':weight} ${size}px ${segment.code?'ui-monospace,SFMono-Regular,Menlo,monospace':'ui-sans-serif,system-ui,sans-serif'}`;
      ctx.save();
      for(const raw of String(el.text||'').split('\n')){
        let text=raw,size=base,weight='400',prefix='';const hm=text.match(/^(#{1,3})\s+(.*)$/);
        if(hm){size=base*(hm[1].length===1?1.55:hm[1].length===2?1.3:1.12);weight='700';text=hm[2];}else{const lm=text.match(/^\s*[-*+]\s+(.*)$/),nm=text.match(/^\s*(\d+)\.\s+(.*)$/);if(lm){prefix='• ';text=lm[1];}else if(nm){prefix=`${nm[1]}. `;text=nm[2];}}
        const pieces=[...(prefix?[{text:prefix,bold:weight>='600'}]:[]),...this.parseMarkdownInline(text)];let row={segments:[],size,weight,width:0,height:size*1.35};
        const pushRow=()=>{if(!row.segments.length)row.segments.push({text:' ',width:0});rows.push(row);row={segments:[],size,weight,width:0,height:size*1.35};};
        for(const segment of pieces){for(const ch of [...String(segment.text||'')]){ctx.font=fontFor(segment,size,weight);const cw=ctx.measureText(ch).width;if(row.width>0&&row.width+cw>maxW)pushRow();const styleKey=`${!!segment.bold}|${!!segment.italic}|${!!segment.code}|${!!segment.link}`,last=row.segments.at(-1);if(last?._styleKey===styleKey){last.text+=ch;last.width+=cw;}else row.segments.push({...segment,text:ch,width:cw,_styleKey:styleKey});row.width+=cw;}}
        pushRow();
      }
      ctx.restore();return rows;
    }

    drawMarkdownNote(ctx,el){
      const w=el.w||180,h=el.h||130,rows=this.markdownNoteRows(ctx,el),fg=el.color||(this.theme==='dark'?'#fff8dc':'#2b261d'),align=el.textAlign||'left',valign=el.verticalAlign||'top',total=rows.reduce((sum,row)=>sum+row.height,0),top=el.y+12,bottom=el.y+h-12;
      let y=valign==='bottom'?Math.max(top,bottom-total):valign==='middle'?Math.max(top,el.y+(h-total)/2):top;
      ctx.save();ctx.textBaseline='top';ctx.textAlign='left';
      for(const row of rows){if(y+row.height>bottom+1)break;let x=align==='center'?el.x+w/2-row.width/2:align==='right'?el.x+w-12-row.width:el.x+12;for(const seg of row.segments){const styleWeight=seg.bold?'700':row.weight,style=seg.italic?'italic ':'normal ',family=seg.code?'ui-monospace,SFMono-Regular,Menlo,monospace':'ui-sans-serif,system-ui,sans-serif';ctx.font=`${style}${styleWeight} ${row.size}px ${family}`;ctx.fillStyle=seg.link?'#2f6fed':fg;if(seg.code&&seg.width){ctx.save();ctx.fillStyle=this.theme==='dark'?'rgba(255,255,255,.10)':'rgba(31,31,31,.07)';ctx.fillRect(x-2,y-1,seg.width+4,row.size+3);ctx.restore();ctx.fillStyle=fg;}ctx.fillText(seg.text||' ',x,y);x+=seg.width||0;}y+=row.height;}
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
      if(el.type==='arrow'){const g=this.arrowGeometry(el),head=this.arrowHeadPoints(el),xs=[el.x,el.x+(el.w||0),g.cx,...head.map(p=>p.x)],ys=[el.y,el.y+(el.h||0),g.cy,...head.map(p=>p.y)],pad=Math.max(4,(el.size||4));return{x:Math.min(...xs)-pad,y:Math.min(...ys)-pad,w:Math.max(...xs)-Math.min(...xs)+pad*2,h:Math.max(...ys)-Math.min(...ys)+pad*2};}
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
      return globalThis.QDGroups.expandSelection(items,this.groups,this.elements);
    }

    setSelection(items, expandGroups=true) {
      const source=expandGroups?this.expandGroupedItems(items):items;
      const seen=new Set();
      this.selectedElements=(source||[]).filter(el=>el&&this.elements.includes(el)&&!seen.has(el.id)&&(seen.add(el.id),true));
      this.selectedElement=this.selectedElements[this.selectedElements.length-1]||null;
      if(this.cropTarget&&!this.selectedElements.includes(this.cropTarget)){this.cropTarget=null;this.cropStart=null;this.cropDrag=null;this.cropRect=null;this.container.style.cursor='';this.container.classList.remove('crop-mode');}
      if(this.watermarkTarget&&!this.selectedElements.includes(this.watermarkTarget)){this.watermarkTarget=null;this.watermarkStart=null;this.watermarkRect=null;this.container.classList.remove('watermark-mode');}
      this.updateHistoryUI();this.updateMindStyleUI?.();this.syncSizeLevelUI?.();
      const arrow=this.selectedElements.length===1&&this.selectedElements[0].type==='arrow'?this.selectedElements[0]:null;
      if(arrow)this.updateTextSizeUI?.(arrow.arrowHeadSize||'M',true,'arrow');
      else if(this.sizeControlMode==='arrow'&&this.currentTool!=='arrow')this.updateTextSizeUI?.(this.currentArrowHeadSize,false,'arrow');
    }

    clearSelection() {
      if(this.cropTarget){this.cropTarget=null;this.cropStart=null;this.cropDrag=null;this.cropRect=null;this.container.style.cursor='';this.container.classList.remove('crop-mode');}
      if(this.watermarkTarget){this.watermarkTarget=null;this.watermarkStart=null;this.watermarkRect=null;this.container.classList.remove('watermark-mode');}
      this.selectedElements=[];this.selectedElement=null;this.updateHistoryUI();this.updateMindStyleUI?.();this.syncSizeLevelUI?.();
      if(this.sizeControlMode==='arrow'&&this.currentTool!=='arrow')this.updateTextSizeUI?.(this.currentArrowHeadSize,false,'arrow');
    }

    getSelectionBBox() { return this.getElementsBBox(this.getSelectedElements()); }
    pointInElement(p, el) {
      if(el?.type==='mindedge')return this.pointNearMindEdge(p,el,9/this.scale);
      return this.pointInRawElement(QDVector.point(QDVector.inverse(QDVector.matrix(el)),p),el);
    }
    pointInRawElement(p, el) {
      if(clamp(el?.opacity==null?1:Number(el.opacity),0,1)<=0)return false;
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
      if(['rect','roundrect','ellipse','triangle','diamond','hexagon','star','cloud'].includes(el?.type)){
        this.ctx.save();this.ctx.setTransform(1,0,0,1,0,0);this.geometryPath(this.ctx,el);const fillHit=el.fill&&el.fill!=='none'&&this.ctx.isPointInPath(p.x,p.y);if(fillHit){this.ctx.restore();return true;}
        if(el.stroke!=='none'&&this.ctx.isPointInStroke){this.ctx.lineWidth=Math.max(10,(el.size||2)*2)/this.scale;const hit=this.ctx.isPointInStroke(p.x,p.y);this.ctx.restore();return hit;}this.ctx.restore();return false;
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
      const items=this.getSelectedElements();if(items.length===1&&['mindedge','arrow','mindnode'].includes(items[0].type))return null;
      const r=8/this.scale; for(const h of this.selectionFrameHandles()) if(Math.hypot(p.x-h.x,p.y-h.y)<=r)return h.name; return null;
    }

    drawCurrentSelection(ctx) {
      const items=this.getSelectedElements(); if(!items.length)return;
      if(items.length===1){
        const el=items[0];
        if(el.type==='mindedge'){this.drawMindEdge(ctx,el,true);if(el.objectLink)this.drawObjectLinkHandles(ctx,el);return;}
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
      const units=globalThis.QDGroups.selectionUnits(this.getSelectedElements().filter(el=>el.type!=='mindedge'),this.groups,this.elements);
      if(units.length<2){this.toast('至少选择两个对象或群组才能对齐。');return;}
      const outer=this.getElementsBBox(units.flatMap(unit=>unit.members)),target=this.alignmentAnchors(outer);
      for(const unit of units){const box=this.getElementsBBox(unit.members),a=this.alignmentAnchors(box);let dx=0,dy=0;if(mode==='left')dx=target.left-a.left;if(mode==='right')dx=target.right-a.right;if(mode==='hcenter')dx=target.center-a.center;if(mode==='top')dy=target.top-a.top;if(mode==='bottom')dy=target.bottom-a.bottom;if(mode==='vcenter')dy=target.middle-a.middle;for(const el of unit.members)this.moveElement(el,dx,dy);}this.commit();this.render();
    }

    centerSelectedBoth(){
      const units=globalThis.QDGroups.selectionUnits(this.getSelectedElements().filter(el=>el.type!=='mindedge'),this.groups,this.elements);
      if(units.length<2){this.toast('至少选择两个对象或群组才能中心对齐。');return;}
      const outer=this.getElementsBBox(units.flatMap(unit=>unit.members));if(!outer)return;const target=this.alignmentAnchors(outer);
      for(const unit of units){const box=this.getElementsBBox(unit.members);if(!box)continue;const a=this.alignmentAnchors(box),dx=target.center-a.center,dy=target.middle-a.middle;for(const el of unit.members)this.moveElement(el,dx,dy);}
      this.commit();this.render();
    }

    distributeSelected(axis){
      const units=globalThis.QDGroups.selectionUnits(this.getSelectedElements().filter(el=>el.type!=='mindedge'),this.groups,this.elements);if(units.length<3){this.toast('至少选择三个对象或群组才能等间距分布。');return;}const data=units.map(unit=>({unit,box:this.getElementsBBox(unit.members)})).filter(item=>item.box).sort((a,b)=>axis==='x'?a.box.x-b.box.x:a.box.y-b.box.y),first=data[0].box,last=data.at(-1).box,total=data.reduce((sum,item)=>sum+(axis==='x'?item.box.w:item.box.h),0),span=axis==='x'?last.x+last.w-first.x:last.y+last.h-first.y,gap=(span-total)/(data.length-1);let cursor=axis==='x'?first.x:first.y;for(const item of data){const current=axis==='x'?item.box.x:item.box.y,dx=axis==='x'?cursor-current:0,dy=axis==='y'?cursor-current:0;for(const el of item.unit.members)this.moveElement(el,dx,dy);cursor+=(axis==='x'?item.box.w:item.box.h)+gap;}this.commit();this.render();
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
      const sx=nb.w/Math.max(1e-6,ob.w),sy=nb.h/Math.max(1e-6,ob.h);const tx=(x,y)=>({x:nb.x+(x-ob.x)*sx,y:nb.y+(y-ob.y)*sy});
      const frameRotated=!!st.frame&&(Math.abs(st.frame.matrix[1])>1e-8||Math.abs(st.frame.matrix[2])>1e-8);
      for(const src of st.elements){
        const el=this.elements.find(e=>e.id===src.id);if(!el)continue;
        if(src.type==='mindedge'&&st.elements.some(node=>node.id===src.fromId||node.id===src.toId))continue;
        const local=[sx,0,0,sy,nb.x-ob.x*sx,nb.y-ob.y*sy];
        if(src.type==='text'&&src.textMode!=='paragraph'){
          const world=st.frame?QDVector.multiply(st.frame.matrix,QDVector.multiply(local,QDVector.inverse(st.frame.matrix))):local;
          el.transform=QDVector.multiply(world,QDVector.matrix(src));
          continue;
        }
        if(st.elements.length>1&&(frameRotated||src.transform)){const world=st.frame?QDVector.multiply(st.frame.matrix,QDVector.multiply(local,QDVector.inverse(st.frame.matrix))):local;el.transform=QDVector.multiply(world,QDVector.matrix(src));continue;}
        if(src.type==='path'&&Array.isArray(src.paths)){el.paths=src.paths.map(path=>({...path,nodes:path.nodes.map(node=>{const anchor=tx(node.x,node.y),next={...node,...anchor};for(const key of ['in','out'])if(node[key])next[key]=tx(node[key].x,node[key].y);return next;})}));continue;}
        if(src.points){el.points=src.points.map(q=>({...q,...tx(q.x,q.y)}));continue;}
        const a=tx(src.x||0,src.y||0),z=tx((src.x||0)+(src.w||0),(src.y||0)+(src.h||0));el.x=a.x;el.y=a.y;
        if(src.type==='text'){el.w=Math.max(24,Math.abs(z.x-a.x));el.h=Math.max((src.fontSize||18)*1.2,Math.abs(z.y-a.y));this.updateTextMetrics(el);}
        else{el.w=z.x-a.x;el.h=z.y-a.y;}
      }
    }

    cloneElements(items) {
      const source=[...(items||[])],sourceIds=new Set(source.map(el=>el.id));
      for(const edge of this.elements.filter(el=>el.type==='mindedge'))if(!sourceIds.has(edge.id)&&((sourceIds.has(edge.fromId)&&sourceIds.has(edge.toId))||(sourceIds.has(edge.toId)&&this.elements.find(node=>node.id===edge.toId)?.parentId===edge.fromId))){source.push(edge);sourceIds.add(edge.id);}
      const idMap=new Map(source.map(src=>[src.id,newId()]));
      const groupCopies=globalThis.QDGroups.cloneGroupsForElements(source,this.groups,()=>`g${newId()}`);this.groups.push(...groupCopies.copies);
      return source.map(src=>{
        const dup=clone(src);dup.id=idMap.get(src.id);
        if(src.groupId&&groupCopies.idMap.has(src.groupId))dup.groupId=groupCopies.idMap.get(src.groupId);
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
      const units=globalThis.QDGroups.selectionUnits(items,this.groups,this.elements);if(units.length<2){this.toast('所选对象已在同一群组中。');return;}
      const groupId=`g${newId()}`;this.groups.push({id:groupId,parentGroupId:null,rotation:0});
      for(const unit of units){if(unit.groupId){const group=this.groups.find(item=>item.id===unit.groupId);if(group)group.parentGroupId=groupId;}else for(const el of unit.members)el.groupId=groupId;}
      this.setSelection(items);this.commit();this.render();this.toast('已打组 · Ctrl/⌘+Shift+G 可取消分组');
    }

    ungroupSelected() {
      const groupIds=new Set(this.getSelectedElements().map(el=>globalThis.QDGroups.rootGroupId(el.groupId,this.groups)).filter(Boolean));
      if(!groupIds.size){this.toast('所选对象没有分组。');return;}
      const affected=[];
      for(const groupId of groupIds){affected.push(...globalThis.QDGroups.leafMembers(groupId,this.groups,this.elements));for(const child of this.groups.filter(group=>group.parentGroupId===groupId))child.parentGroupId=null;for(const el of this.elements)if(el.groupId===groupId)delete el.groupId;}
      this.groups=this.groups.filter(group=>!groupIds.has(group.id));
      this.setSelection(affected,false);this.commit();this.render();
    }

    deleteSelected() {
      const selected=this.getSelectedElements(),ids=new Set(selected.map(e=>e.id));if(!ids.size)return;
      for(const edge of selected.filter(e=>e.type==='mindedge')){const child=this.elements.find(e=>e.id===edge.toId&&e.type==='mindnode');if(child?.parentId===edge.fromId)child.parentId=null;}
      let grew=true;while(grew){grew=false;for(const el of this.elements){if(el.type==='mindnode'&&el.parentId&&ids.has(el.parentId)&&!ids.has(el.id)){ids.add(el.id);grew=true;}}}
      this.elements=this.elements.filter(e=>!ids.has(e.id)&&!(e.type==='mindedge'&&(ids.has(e.fromId)||ids.has(e.toId))));this.clearSelection();this.commit();this.render();
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
      this.container.addEventListener('pointerdown',e=>{if(e.button===0&&!this.isTextEditingTarget(e.target))this.container.focus({preventScroll:true});this.onPointerDown(e);},{passive:false});
      this.container.addEventListener('pointermove',e=>this.onPointerMove(e),{passive:false});
      window.addEventListener('pointerup',e=>this.onPointerUp(e));
      window.addEventListener('pointercancel',e=>this.onPointerUp(e));
      this.container.addEventListener('lostpointercapture',e=>{if(this.isPanning&&e.pointerId===this.panPointerId)this.finishPan(e.pointerId);});
      this.container.addEventListener('mousedown',e=>{if(e.button===1)e.preventDefault();},{passive:false});
      this.container.addEventListener('wheel',e=>{e.preventDefault();if(this.wheelZoomLocked)return;this.zoom(e.deltaY<0?1.10:.90,e.clientX,e.clientY);},{passive:false});
      this.container.addEventListener('auxclick',e=>{if(e.button===1)e.preventDefault();});
      this.container.addEventListener('contextmenu',e=>this.onContextMenu(e));
      this.container.addEventListener('dblclick',e=>{ const p=this.eventPos(e);if(e.altKey&&this.currentTool==='select'&&this.rotationHandleAt?.(p)){e.preventDefault();this.resetSelectionRotation?.();return;}if(this.cropTarget){e.preventDefault();const q=this.imageLocalPoint(this.cropTarget,p),r=this.cropRect;if(r&&r.w>0&&r.h>0&&q.x>=r.x&&q.x<=r.x+r.w&&q.y>=r.y&&q.y<=r.y+r.h)this.applyImageCrop({...r});return;}const hit=this.selectAt(p);if(!hit){if(this.currentTool==='select'){e.preventDefault();const q=this.snapWorldPoint(p);this.setTool('text');this.createTextEditor(q.x,q.y,false,null,{textMode:'art'});}return;}if(['text','note','mindnode'].includes(hit.type)){this.setSelection([hit]);this.editTextElement(hit);} });

      window.addEventListener('keydown',e=>this.onKeyDown(e));
      window.addEventListener('keydown',e=>{
        if(e.key==='Escape'&&this.backgroundRemovalController){e.preventDefault();e.stopImmediatePropagation();this.backgroundRemovalController.abort();}
      },true);
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
        const mindEdgeHandle=this.hitObjectLinkHandle(p);if(mindEdgeHandle){this.captureInteractionPointer(e.pointerId);this.startObjectLinkReconnect(mindEdgeHandle.edge,mindEdgeHandle.kind);return;}
        const mindAnchor=this.hitMindAnchor(p);if(mindAnchor){this.startMindLink(mindAnchor.node,mindAnchor.side,p);return;}
        const arrowControl=this.hitArrowControl(p);if(arrowControl){const el=arrowControl.el,g=this.arrowGeometry(el);if(arrowControl.kind==='curve')this.arrowCurveDrag={id:el.id};else this.arrowPointDrag={id:el.id,kind:arrowControl.kind,fixed:arrowControl.kind==='start'?{x:g.ex,y:g.ey}:{x:g.sx,y:g.sy}};return;}
        const handle=this.hitHandle(p);if(handle){this.captureInteractionPointer(e.pointerId);this.isResizing=true;this.resizeHandle=handle;const frame=this.getSelectionFrame(),elements=this.getSelectedElements().map(clone);this.resizeStart={bbox:frame.box,frame,elements,lockAspect:elements.some(el=>el.type==='image')};return;}
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
      if(this.currentTool==='text'){const q=this.snapWorldPoint(p);this.textDraft={start:q,current:q,pointerId:e.pointerId};this.captureInteractionPointer(e.pointerId);return;}
      if(this.currentTool==='note'){const q=this.snapWorldPoint(p);this.createTextEditor(q.x,q.y,true);this.pointerDown=false;return;}
      const base={id:newId(),color:this.currentColor,fillColor:this.currentFillColor||this.currentColor,strokeColor:this.currentStrokeColor||this.currentColor,size:this.currentSize,dash:this.currentDash,fill:this.currentFill,stroke:this.currentStroke},q=['draw','highlight'].includes(this.currentTool)?p:this.snapWorldPoint(p);
      if(this.currentTool==='draw')this.currentElement={...base,type:'draw',points:[{x:q.x,y:q.y,pressure:e.pressure||.5}]};
      else if(this.currentTool==='highlight')this.currentElement={...base,type:'highlight',points:[{x:q.x,y:q.y}]};
      else if(this.currentTool==='geo')this.currentElement={...base,type:this.currentShape,x:q.x,y:q.y,w:0,h:0};else this.currentElement={...base,type:this.currentTool,x:q.x,y:q.y,w:0,h:0,...(this.currentTool==='arrow'?{bend:0,arrowHeadSize:this.currentArrowHeadSize}:{})};
    }

    onPointerMove(e) {
      if(this.editingPointerMove(e))return;
      const p=this.eventPos(e);
      if(this.watermarkTarget&&this.watermarkStart){const bounds=this.getRawElementBBox(this.watermarkTarget),p=this.imageLocalPoint(this.watermarkTarget,this.eventPos(e)),end={x:clamp(p.x,bounds.x,bounds.x+bounds.w),y:clamp(p.y,bounds.y,bounds.y+bounds.h)};this.watermarkRect=this.rectFromPoints(this.watermarkStart,end);this.render();return;}
      if(this.cropTarget&&!this.isPanning){this.moveCropDrag(e);return;}
      if(this.mindEdgePointDrag){this.mindEdgePointDrag.pointer={x:p.x,y:p.y};this.render();return;}
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
      if(this.currentTool==='select'&&this.isResizing&&this.getSelectedElements().length){const keepAspect=this.resizeStart?.lockAspect?!e.shiftKey:e.shiftKey;this.resizeSelection(this.resizeHandle,this.snapWorldPoint(p),keepAspect);this.render();return;}
      if(this.currentTool==='text'&&this.textDraft){this.textDraft.current=this.snapWorldPoint(p);this.render();return;}
      if(this.currentTool==='select'&&this.isMarqueeSelecting){this.marqueeRect=this.rectFromPoints(this.marqueeStart,p);this.render();return;}
      if(this.currentTool==='eraser'){this.eraseAt(p);return;}if(!this.currentElement)return;
      if(this.currentElement.points){const pts=this.currentElement.points,last=pts[pts.length-1];if(!last||Math.hypot(p.x-last.x,p.y-last.y)>1/this.scale){const point={x:p.x,y:p.y};if(this.currentElement.type==='draw')point.pressure=e.pressure||.5;pts.push(point);}}else{const q=this.snapWorldPoint(p);let w=q.x-this.currentElement.x,h=q.y-this.currentElement.y;if(e.shiftKey){const t=this.currentElement.type;if(t==='line'||t==='arrow'){const len=Math.hypot(w,h);if(len>1e-6){const ang=Math.round(Math.atan2(h,w)/(Math.PI/4))*(Math.PI/4);w=Math.cos(ang)*len;h=Math.sin(ang)*len;}}else{const len=Math.max(Math.abs(w),Math.abs(h));w=(w<0?-1:1)*len;h=(h<0?-1:1)*len;}}this.currentElement.w=w;this.currentElement.h=h;}this.render();
    }

    onPointerUp(e) {
      if(this.editingPointerUp(e))return;
      if(!this.isPanning)this.releaseInteractionPointer(e?.pointerId);
      if(this.watermarkTarget&&this.watermarkStart){const rect=this.watermarkRect;this.watermarkStart=null;this.pointerDown=false;if(e?.type==='pointercancel'){this.watermarkRect=null;this.render();return;}if(rect&&rect.w>=8/this.scale&&rect.h>=8/this.scale)this.applyWatermarkRemoval(rect);else{this.watermarkRect=null;this.toast('水印区域太小，请重新框选。');this.render();}return;}
      if(this.cropTarget&&this.cropDrag){this.endCropDrag(e);return;}
      if(this.mindEdgePointDrag){const p=e?this.eventPos(e):this.mindEdgePointDrag.pointer;this.finishObjectLinkReconnect(p,e?.type==='pointercancel');this.pointerDown=false;return;}
      if(this.mindLinkDraft){const p=e?this.eventPos(e):this.mindLinkDraft.to;this.finishMindLink(p);this.pointerDown=false;return;}
      if(this.arrowPointDrag){this.arrowPointDrag=null;this.pointerDown=false;this.commit();this.render();return;}
      if(this.arrowCurveDrag){this.arrowCurveDrag=null;this.pointerDown=false;this.commit();this.render();return;}
      if(this.isPanning){this.finishPan(e?.pointerId);return;}
      if(this.currentTool==='select'&&this.isMarqueeSelecting){const rect=this.marqueeRect,moved=rect&&(rect.w>3/this.scale||rect.h>3/this.scale);if(moved){const hits=this.selectInRect(rect),merged=this.marqueeAdditive?[...this.marqueeBase,...hits]:hits;this.setSelection(merged);}else if(!this.marqueeAdditive)this.clearSelection();this.isMarqueeSelecting=false;this.marqueeStart=null;this.marqueeRect=null;this.marqueeBase=[];this.pointerDown=false;this.render();return;}
      if(this.currentTool==='select'&&(this.isDragging||this.isResizing)){this.isDragging=false;this.isResizing=false;this.resizeHandle=null;this.resizeStart=null;this.dragOrigin=null;this.altDuplicatePending=false;this.dragHasMoved=false;this.pointerDown=false;this.commit();this.render();return;}
      if(this.currentTool==='text'&&this.textDraft){const draft=this.textDraft;this.textDraft=null;this.pointerDown=false;const rect=this.rectFromPoints(draft.start,draft.current),paragraph=rect.w>6/this.scale||rect.h>6/this.scale;this.createTextEditor(paragraph?rect.x:draft.start.x,paragraph?rect.y:draft.start.y,false,null,paragraph?{textMode:'paragraph',width:Math.max(48,rect.w),height:Math.max(28,rect.h)}:{textMode:'art'});return;}
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
      if(this.mindEdgePointDrag&&key==='escape'){e.preventDefault();this.releaseInteractionPointer();this.finishObjectLinkReconnect(this.mindEdgePointDrag.pointer,true);this.pointerDown=false;return;}
      if(mod&&key==='c'){e.preventDefault();const selected=this.getSelectedElements();if(selected.length)this.copyPNG(selected);else this.toast('请先选择要复制的对象。');return;}
      if(e.altKey&&!mod&&key==='c'){e.preventDefault();this.centerSelectedBoth();return;}
      if(e.altKey&&!mod&&['t','l','r','b'].includes(key)){e.preventDefault();this.alignSelected(({t:'top',l:'left',r:'right',b:'bottom'})[key]);return;}
      if(mod&&key==='f'){e.preventDefault();this.openSearchDialog();return;}
      if(!$('#storage-dialog').hidden&&key==='escape'){e.preventDefault();this.closeStorageDialog();return;}if(!$('#clear-dialog').hidden&&key==='escape'){e.preventDefault();this.closeClearDialog();return;}if(e.code==='Space'){this.spaceDown=true;e.preventDefault();return;}if(mod&&key==='z'){e.preventDefault();e.shiftKey?this.redo():this.undo();return;}if(mod&&key==='y'){e.preventDefault();this.redo();return;}if(mod&&key==='d'){e.preventDefault();this.duplicateSelected();return;}if(mod&&key==='g'){e.preventDefault();e.shiftKey?this.ungroupSelected():this.groupSelected();return;}if(key==='tab'&&this.getMindFocus()){e.preventDefault();const node=this.getMindFocus();this.createMindRelative(node,e.shiftKey?'sibling':'child');return;}if(mod&&(e.code==='BracketLeft'||key==='[')){e.preventDefault();this.moveSelectedLayer(-1,e.shiftKey);return;}if(mod&&(e.code==='BracketRight'||key===']')){e.preventDefault();this.moveSelectedLayer(1,e.shiftKey);return;}if(key==='delete'||key==='backspace'){e.preventDefault();this.deleteSelected();return;}if(key==='escape'){this.closePopovers();this.clearSelection();this.render();return;}if(key==='f'){this.fitSelection();return;}
      if(mod&&key==='e'){e.preventDefault();this.exportJPG();return;}if(!mod&&key==='m'){e.preventDefault();this.connectSelectedAsMindmap();return;}const map={v:'select','1':'select',h:'hand','2':'hand',d:'draw','3':'draw',i:'highlight','4':'highlight',e:'eraser','5':'eraser',k:'pen','6':'pen',l:'line','7':'line',a:'arrow','8':'arrow',g:'geo','9':'geo',t:'text',n:'note'};if(map[key]){this.setTool(map[key]);return;}
      if(this.getSelectedElements().length&&['arrowup','arrowdown','arrowleft','arrowright'].includes(key)){e.preventDefault();const d=e.shiftKey?10:1,dx=key==='arrowleft'?-d:key==='arrowright'?d:0,dy=key==='arrowup'?-d:key==='arrowdown'?d:0;this.moveSelected(dx/this.scale,dy/this.scale);this.commit();this.render();}
    }

    setTool(tool) {
      if(tool==='mindmap'){this.connectSelectedAsMindmap();return;}
      if(this.penDraft&&tool!=='pen')this.finishPen();
      this.penEdit=null;this.currentTool=tool;
      $$('.tool-btn[data-tool]').forEach(b=>b.classList.toggle('active',b.dataset.tool===tool));
      this.container.className=`canvas-container tool-${tool}`;
      if(tool!=='select'&&tool!=='pen'&&tool!=='text')this.clearSelection();
      this.updateMindStyleUI();
      const arrow=this.getSelectedElements().length===1&&this.getSelectedElements()[0].type==='arrow'?this.getSelectedElements()[0]:null;
      if(tool==='arrow')this.updateTextSizeUI?.(this.currentArrowHeadSize,true,'arrow');
      else if(tool==='text')this.updateTextSizeUI?.(this.currentTextSize,true,'text');
      else if(tool==='select'&&arrow)this.updateTextSizeUI?.(arrow.arrowHeadSize||'M',true,'arrow');
      else this.updateTextSizeUI?.(this.currentTextSize,false,'text');
      this.render();
    }

    updateTextSizeUI(size=this.currentTextSize,show=this.currentTool==='text',mode='text'){
      const control=$('#text-size-control');if(!control)return;this.sizeControlMode=mode;control.hidden=!show;control.setAttribute('aria-label',mode==='arrow'?'箭头大小':'文字格式');const noteControls=$('#note-text-controls');if(noteControls)noteControls.hidden=mode!=='note';
      const buttons=$$('[data-text-size]',control);
      if(mode==='arrow'){const level=['S','M','L','XL'].includes(String(size))?String(size):'M';buttons.forEach(b=>b.classList.toggle('active',b.textContent.trim()===level));return;}
      const exact=buttons.find(b=>Number(b.dataset.textSize)===Number(size)),nearest=exact||buttons.reduce((best,b)=>!best||Math.abs(Number(b.dataset.textSize)-size)<Math.abs(Number(best.dataset.textSize)-size)?b:best,null);buttons.forEach(b=>b.classList.toggle('active',b===nearest));
      if(mode==='note'){const note=this.getSelectedElements().find(el=>el.type==='note');const align=note?.textAlign||'left',valign=note?.verticalAlign||'top';$$('[data-note-align]',control).forEach(b=>b.classList.toggle('active',b.dataset.noteAlign===align));$$('[data-note-valign]',control).forEach(b=>b.classList.toggle('active',b.dataset.noteValign===valign));}
    }

    setArrowHeadSize(level){
      level=String(level||'M').toUpperCase();if(!['S','M','L','XL'].includes(level))level='M';this.currentArrowHeadSize=level;
      const arrows=this.getSelectedElements().filter(el=>el.type==='arrow');for(const el of arrows)el.arrowHeadSize=level;
      if(arrows.length)this.commit();this.updateTextSizeUI(level,true,'arrow');this.render();
    }

    setTextSize(size){
      size=clamp(Number(size)||28,8,96);this.currentTextSize=size;const noteEditor=$('.note-text-editor'),notes=this.getSelectedElements().filter(el=>el.type==='note');
      if(noteEditor&&notes.length){for(const note of notes)note.fontSize=size;noteEditor.style.fontSize=`${size*this.scale}px`;noteEditor.dispatchEvent(new Event('input'));this.updateTextSizeUI(size,true,'note');this.render();return;}
      const items=this.getSelectedElements().filter(el=>el.type==='text');for(const el of items){el.fontSize=size;this.updateTextMetrics(el);}const editor=$('.inline-text-editor');if(editor){editor.style.fontSize=`${size*this.scale}px`;editor.dispatchEvent(new Event('input'));}else if(items.length)this.commit();this.updateTextSizeUI(size,true,'text');this.render();
    }

    setNoteAlignment(axis,value){
      const notes=this.getSelectedElements().filter(el=>el.type==='note');if(!notes.length)return;for(const note of notes){if(axis==='horizontal')note.textAlign=value;else note.verticalAlign=value;}const editor=$('.note-text-editor');if(editor){editor.style.textAlign=notes[0].textAlign||'left';editor.dispatchEvent(new Event('input'));}else this.commit();this.updateTextSizeUI(notes[0].fontSize||16,true,'note');this.render();
    }
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
      const natural=Math.max(70,...raw.split('\n').map(line=>this.ctx.measureText(line||' ').width+20));
      el.w=clamp(natural,110,260);
      const lines=this.getMindNodeLines(this.ctx,raw,Math.max(40,el.w-20));
      el.h=Math.max(40,lines.length*fs*1.3+20);
      this.ctx.restore();
    }

    createMindNode(x,y,parentId=null) {
      const parent=parentId?this.elements.find(el=>el.id===parentId):null;
      const node={id:newId(),type:'mindnode',plainMind:true,x,y,w:90,h:36,text:'',parentId:parentId||null,fontSize:15,color:this.theme==='dark'?'#d8d3ca':'#5d5952',textColor:this.theme==='dark'?'#ffffff':'#1f1f1f'};
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
      const objects=this.elements.filter(el=>el.type!=='mindedge'),objectIds=new Set(objects.map(el=>el.id)),nodes=objects.filter(el=>el.type==='mindnode'),nodeIds=new Set(nodes.map(n=>n.id));
      this.elements=this.elements.filter(el=>el.type!=='mindedge'||(objectIds.has(el.fromId)&&objectIds.has(el.toId)&&(el.objectLink||(nodeIds.has(el.fromId)&&nodeIds.has(el.toId)))));
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

    objectLinkSides(from,to){
      const a=this.getElementBBox(from),b=this.getElementBBox(to);if(!a||!b)return{fromSide:'right',toSide:'left'};
      const ac={x:a.x+a.w/2,y:a.y+a.h/2},bc={x:b.x+b.w/2,y:b.y+b.h/2},dx=bc.x-ac.x,dy=bc.y-ac.y;
      if(Math.abs(dx)>=Math.abs(dy))return dx>=0?{fromSide:'right',toSide:'left'}:{fromSide:'left',toSide:'right'};
      return dy>=0?{fromSide:'bottom',toSide:'top'}:{fromSide:'top',toSide:'bottom'};
    }

    objectLinkAnchor(el,side){
      const b=this.getElementBBox(el);if(!b)return null;
      if(side==='top')return{x:b.x+b.w/2,y:b.y};if(side==='bottom')return{x:b.x+b.w/2,y:b.y+b.h};if(side==='left')return{x:b.x,y:b.y+b.h/2};return{x:b.x+b.w,y:b.y+b.h/2};
    }

    objectLinkSidesForPoints(a,b){
      const dx=b.x-a.x,dy=b.y-a.y;if(Math.abs(dx)>=Math.abs(dy))return dx>=0?{fromSide:'right',toSide:'left'}:{fromSide:'left',toSide:'right'};return dy>=0?{fromSide:'bottom',toSide:'top'}:{fromSide:'top',toSide:'bottom'};
    }

    objectConnectionTargetAt(p,excludeId=null){
      return [...this.elements].reverse().find(el=>el.type!=='mindedge'&&el.id!==excludeId&&this.isElementVisible(el)&&this.pointInElement(p,el))||null;
    }

    drawObjectLinkHandles(ctx,edge){
      const g=this.mindEdgeGeometry(edge);if(!g)return;const sel=getComputedStyle(this.app).getPropertyValue('--sel').trim()||'#2f6fed',r=5/this.scale;ctx.save();ctx.fillStyle=this.themePaperColor();ctx.strokeStyle=sel;ctx.lineWidth=1.8/this.scale;for(const q of [g.a,g.b]){ctx.beginPath();ctx.arc(q.x,q.y,r,0,Math.PI*2);ctx.fill();ctx.stroke();}ctx.restore();
    }

    hitObjectLinkHandle(p){
      const items=this.getSelectedElements();if(items.length!==1)return null;const edge=items[0];if(edge.type!=='mindedge'||!edge.objectLink)return null;const g=this.mindEdgeGeometry(edge);if(!g)return null;const r=11/this.scale,fromDist=Math.hypot(p.x-g.a.x,p.y-g.a.y),toDist=Math.hypot(p.x-g.b.x,p.y-g.b.y);if(fromDist>r&&toDist>r)return null;return{edge,kind:fromDist<=toDist?'from':'to'};
    }

    startObjectLinkReconnect(edge,kind){
      if(!edge?.objectLink||!['from','to'].includes(kind))return false;const g=this.mindEdgeGeometry(edge);if(!g)return false;this.mindEdgePointDrag={id:edge.id,kind,original:{fromId:edge.fromId,toId:edge.toId,fromSide:edge.fromSide,toSide:edge.toSide},pointer:{...(kind==='from'?g.a:g.b)}};this.pointerDown=true;this.render();return true;
    }

    finishObjectLinkReconnect(p,cancel=false){
      const drag=this.mindEdgePointDrag;if(!drag)return false;this.mindEdgePointDrag=null;const edge=this.elements.find(el=>el.id===drag.id&&el.type==='mindedge'&&el.objectLink);if(!edge)return false;
      const restore=()=>{edge.fromId=drag.original.fromId;edge.toId=drag.original.toId;edge.fromSide=drag.original.fromSide;edge.toSide=drag.original.toSide;};
      if(cancel){restore();this.spatialDirty=true;this.render();return false;}
      const otherId=drag.kind==='from'?edge.toId:edge.fromId,target=this.objectConnectionTargetAt(p,otherId);if(!target){restore();this.spatialDirty=true;this.toast('把端点拖到另一个对象上才能重新连接。');this.render();return false;}
      if(drag.kind==='from')edge.fromId=target.id;else edge.toId=target.id;const from=this.elements.find(el=>el.id===edge.fromId),to=this.elements.find(el=>el.id===edge.toId);if(!from||!to||from.id===to.id){restore();this.spatialDirty=true;this.render();return false;}Object.assign(edge,this.objectLinkSides(from,to));this.spatialDirty=true;this.setSelection([edge],false);this.commit();this.render();return true;
    }

    connectSelectedAsMindmap(){
      const selected=this.getSelectedElements().filter(el=>el.type!=='mindedge'&&this.isElementVisible(el));
      if(selected.length<2){this.toast('至少选择两个对象再连接。');return false;}
      const data=selected.map(el=>{const box=this.getElementBBox(el);return{el,box,center:box?{x:box.x+box.w/2,y:box.y+box.h/2}:null};}).filter(item=>item.center);
      if(data.length<2){this.toast('所选对象无法建立连线。');return false;}
      const visited=new Set([0]),pairs=[];
      while(visited.size<data.length){let best=null;for(const i of visited)for(let j=0;j<data.length;j++){if(visited.has(j))continue;const a=data[i].center,b=data[j].center,d=(a.x-b.x)**2+(a.y-b.y)**2;if(!best||d<best.d)best={i,j,d};}if(!best)break;pairs.push(best);visited.add(best.j);}
      const selectedIds=new Set(data.map(item=>item.el.id));
      this.elements=this.elements.filter(edge=>!(edge.type==='mindedge'&&edge.objectLink&&selectedIds.has(edge.fromId)&&selectedIds.has(edge.toId)));
      const created=[];
      for(const pair of pairs){const from=data[pair.i].el,to=data[pair.j].el,{fromSide,toSide}=this.objectLinkSides(from,to);created.push({id:newId(),type:'mindedge',objectLink:true,fromId:from.id,toId:to.id,fromSide,toSide,style:'rounded',color:this.theme==='dark'?'#9aa3ad':'#7d8794',size:1.6,arrow:false});}
      if(!created.length){this.render();return false;}
      this.elements.unshift(...created);this.spatialDirty=true;this.commit();this.render();this.toast(`已连接 ${created.length} 条关系线。`);return true;
    }

    createMindEdge(from,to,fromSide='right',toSide='left',style=this.currentMindStyle,commit=true) {
      if(!from||!to||from.id===to.id)return null;
      const edge={id:newId(),type:'mindedge',fromId:from.id,toId:to.id,fromSide,toSide,style:style||'rounded',color:this.theme==='dark'?'#777c86':'#7d8794',size:1.6};
      this.elements.unshift(edge);
      if(commit)this.commit();
      return edge;
    }

    mindEdgeGeometry(edge) {
      const from=this.elements.find(el=>el.id===edge.fromId),to=this.elements.find(el=>el.id===edge.toId);if(!from||!to)return null;
      if(edge.objectLink){let a=this.objectLinkAnchor(from,edge.fromSide||'right'),b=this.objectLinkAnchor(to,edge.toSide||'left');const drag=this.mindEdgePointDrag?.id===edge.id?this.mindEdgePointDrag:null;if(drag?.pointer){if(drag.kind==='from')a=drag.pointer;else b=drag.pointer;}return a&&b?{from,to,a,b}:null;}
      if(from.type!=='mindnode'||to.type!=='mindnode')return null;
      return{from,to,a:this.mindAnchorPoint(from,edge.fromSide||'right'),b:this.mindAnchorPoint(to,edge.toSide||'left')};
    }

    rawMindEdgeSamplePoints(edge) {
      const g=this.mindEdgeGeometry(edge);if(!g)return[];const {a,b}=g;let fromSide=edge.fromSide||'right',toSide=edge.toSide||'left';if(edge.objectLink&&this.mindEdgePointDrag?.id===edge.id)({fromSide,toSide}=this.objectLinkSidesForPoints(a,b));
      if(edge.style==='orthogonal'){
        const gap=18;
        const out=(p,side)=>({x:p.x+(side==='left'?-gap:side==='right'?gap:0),y:p.y+(side==='top'?-gap:side==='bottom'?gap:0)});
        const a1=out(a,fromSide),b1=out(b,toSide);
        const fromH=['left','right'].includes(fromSide),toH=['left','right'].includes(toSide);
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
      const horizontal=(fromSide==='left'||fromSide==='right');
      let c1,c2;
      if(horizontal){const dir=fromSide==='left'?-1:1,dist=Math.max(26,Math.abs(dx)*.48);c1={x:a.x+dir*dist,y:a.y};const dir2=toSide==='left'?-1:1;c2={x:b.x+dir2*dist,y:b.y};}
      else{const dir=fromSide==='top'?-1:1,dist=Math.max(26,Math.abs(dy)*.48);c1={x:a.x,y:a.y+dir*dist};const dir2=toSide==='top'?-1:1;c2={x:b.x,y:b.y+dir2*dist};}
      const pts=[];for(let i=0;i<=24;i++){const t=i/24,u=1-t;pts.push({x:u*u*u*a.x+3*u*u*t*c1.x+3*u*t*t*c2.x+t*t*t*b.x,y:u*u*u*a.y+3*u*u*t*c1.y+3*u*t*t*c2.y+t*t*t*b.y});}return pts;
    }

    mindEdgeLabelPoint(edge,pts=null){const list=pts||this.mindEdgeSamplePoints(edge);if(!list.length)return null;let total=0;const lens=[];for(let i=1;i<list.length;i++){const l=Math.hypot(list[i].x-list[i-1].x,list[i].y-list[i-1].y);lens.push(l);total+=l;}let target=total/2;for(let i=1;i<list.length;i++){const l=lens[i-1];if(target<=l||i===list.length-1){const t=l?target/l:0;return{x:list[i-1].x+(list[i].x-list[i-1].x)*t,y:list[i-1].y+(list[i].y-list[i-1].y)*t};}target-=l;}return list[Math.floor(list.length/2)];}

    drawMindEdge(ctx,edge,selected=false) {
      const pts=this.mindEdgeSamplePoints(edge);if(pts.length<2)return;
      const stroke=selected?(getComputedStyle(this.app).getPropertyValue('--sel').trim()||'#2f6fed'):(edge.color||(this.theme==='dark'?'#9aa3ad':'#7d8794'));
      const unit=this.exporting?1:1/this.scale;ctx.save();ctx.strokeStyle=stroke;ctx.fillStyle=stroke;ctx.lineWidth=(selected?3.2:(edge.size||1.6))*unit;ctx.lineCap='round';ctx.lineJoin='round';ctx.setLineDash(edge.dashed?[6*unit,5*unit]:[]);ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i].x,pts[i].y);ctx.stroke();
      if(edge.arrow){let i=pts.length-2;while(i>0&&Math.hypot(pts.at(-1).x-pts[i].x,pts.at(-1).y-pts[i].y)<.01)i--;const a=pts[i],b=pts.at(-1),ang=Math.atan2(b.y-a.y,b.x-a.x),len=10*unit;ctx.beginPath();ctx.moveTo(b.x,b.y);ctx.lineTo(b.x-len*Math.cos(ang-.55),b.y-len*Math.sin(ang-.55));ctx.moveTo(b.x,b.y);ctx.lineTo(b.x-len*Math.cos(ang+.55),b.y-len*Math.sin(ang+.55));ctx.stroke();}
      if(edge.label){const q=this.mindEdgeLabelPoint(edge,pts),text=String(edge.label);ctx.font=`500 ${12*unit}px ui-sans-serif,system-ui,sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';const w=ctx.measureText(text).width+10*unit,h=18*unit;ctx.fillStyle=this.themePaperColor();if(ctx.roundRect){ctx.beginPath();ctx.roundRect(q.x-w/2,q.y-h/2,w,h,4*unit);ctx.fill();}else ctx.fillRect(q.x-w/2,q.y-h/2,w,h);ctx.fillStyle=selected?(getComputedStyle(this.app).getPropertyValue('--sel').trim()||'#2f6fed'):(this.theme==='dark'?'#e5e7eb':'#4b5563');ctx.fillText(text,q.x,q.y);}
      ctx.restore();
    }

    drawMindMapConnections(ctx) { for(const edge of this.elements)if(edge.type==='mindedge'&&this.isElementVisible(edge))this.drawMindEdge(ctx,edge,false); }

    drawMindAnchors(ctx,node) {
      ctx.save();const sel=getComputedStyle(this.app).getPropertyValue('--sel').trim()||'#2f6fed';const r=5/this.scale,off=10/this.scale;ctx.fillStyle=this.themePaperColor();ctx.strokeStyle=sel;ctx.lineWidth=1.7/this.scale;
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

    arrowHeadLength(el){
      const level=String(el?.arrowHeadSize||'M').toUpperCase();
      return ({S:12,M:16.5,L:22,XL:28})[level]||16.5;
    }
    arrowHeadPoints(el){
      const g=this.arrowGeometry(el),ex=el.x+(el.w||0),ey=el.y+(el.h||0),ang=Math.atan2(ey-g.cy,ex-g.cx),len=this.arrowHeadLength(el);
      return [{x:ex-len*Math.cos(ang-.55),y:ey-len*Math.sin(ang-.55)},{x:ex-len*Math.cos(ang+.55),y:ey-len*Math.sin(ang+.55)}];
    }
    arrowGeometry(el){const sx=el.x,sy=el.y,ex=el.x+(el.w||0),ey=el.y+(el.h||0),dx=ex-sx,dy=ey-sy,len=Math.hypot(dx,dy)||1,nx=-dy/len,ny=dx/len,mx=(sx+ex)/2,my=(sy+ey)/2,b=el.bend||0;return{sx,sy,ex,ey,cx:mx+nx*b,cy:my+ny*b,mx,my,nx,ny};}
    arrowSamplePoints(el){const g=this.arrowGeometry(el),pts=[];for(let i=0;i<=28;i++){const t=i/28,u=1-t;pts.push({x:u*u*g.sx+2*u*t*g.cx+t*t*g.ex,y:u*u*g.sy+2*u*t*g.cy+t*t*g.ey});}return pts;}
    pointNearArrow(p,el,tol){const pts=this.arrowSamplePoints(el);for(let i=1;i<pts.length;i++)if(this.pointSegmentDistance(p,pts[i-1],pts[i])<=tol)return true;const end={x:el.x+(el.w||0),y:el.y+(el.h||0)};for(const q of this.arrowHeadPoints(el))if(this.pointSegmentDistance(p,end,q)<=tol)return true;return false;}
    drawArrowSelection(ctx,el){const g=this.arrowGeometry(el),pts=this.arrowSamplePoints(el),mid={x:g.mx+g.nx*(el.bend||0)/2,y:g.my+g.ny*(el.bend||0)/2};ctx.save();const sel=getComputedStyle(this.app).getPropertyValue('--sel').trim()||'#2f6fed';ctx.strokeStyle=sel;ctx.lineWidth=2.4/this.scale;ctx.lineCap='round';ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i].x,pts[i].y);ctx.stroke();ctx.fillStyle=this.themePaperColor();ctx.lineWidth=1.8/this.scale;for(const q of [{x:g.sx,y:g.sy},mid,{x:g.ex,y:g.ey}]){ctx.beginPath();ctx.arc(q.x,q.y,5/this.scale,0,Math.PI*2);ctx.fill();ctx.stroke();}ctx.restore();}
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
      const slider=$('#size-slider'),num=$('#size-number');if(slider)slider.value=level;if(num)num.value=level;
    }
    syncShapeStyleUI(selected=this.getSelectedElements()){
      const shapeTypes=new Set(['path','rect','roundrect','ellipse','triangle','diamond','hexagon','star','cloud']);
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
        ta.style.width=`${Math.max(110,(node.w||110)*this.scale)}px`;
        ta.style.height=`${Math.max(40,(node.h||40)*this.scale)}px`;
        ta.style.fontSize=`${(node.fontSize||15)*this.scale}px`;
        ta.style.padding=`${10*this.scale}px`;
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
      for(const d of defs){
        const node={id:newId(),type:'mindnode',mermaid:true,mermaidType:parsed.type||'flowchart',mermaidRole:d.role||'',mermaidId:d.id,nodeShape:d.shape||'rect',x:0,y:0,w:90,h:36,text:d.text||d.id,parentId:null,fontSize:15,color:this.theme==='dark'?'#d8d3ca':'#5d5952',textColor:this.theme==='dark'?'#ffffff':'#1f1f1f',bgColor:this.theme==='dark'?'#24211d':'#ffffff'};
        if(node.mermaidRole==='state-start'||node.mermaidRole==='state-end'){
          node.w=28;node.h=28;node.text='';node.nodeShape='ellipse';
        }else{
          this.updateMindNodeMetrics(node);
          if(node.nodeShape==='diamond'){node.w=Math.max(160,node.w+26);node.h=Math.max(76,node.h+22);}
          else if(node.nodeShape==='ellipse'||node.nodeShape==='pill')node.h=Math.max(48,node.h);
          if((parsed.type||'flowchart')==='class'){
            const rawLines=String(node.text||'').split('\n');
            this.ctx.save();this.ctx.font=`500 ${node.fontSize||15}px ui-sans-serif,system-ui,sans-serif`;
            const measured=Math.max(180,...rawLines.map(line=>this.ctx.measureText(line||' ').width+38));this.ctx.restore();
            node.w=Math.max(220,Math.min(340,measured));
            node.h=Math.max(72,48+Math.max(0,rawLines.length-1)*23+16);
          }
        }
        nodeMap.set(d.id,node);created.push(node);
      }
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

    layoutMermaidDiagram(parsed){
      if(!parsed)return null;
      if(parsed.type==='sequence')return this.layoutMermaidSequence(parsed);
      if(parsed.type==='state')return this.layoutMermaidState(parsed);
      if(parsed.type==='gantt')return this.layoutMermaidGantt(parsed);
      if(parsed.type==='class')return this.layoutMermaidClass(parsed);
      return this.layoutMermaidFlowchart(parsed);
    }

    layoutMermaidState(parsed){
      const layout=this.layoutMermaidFlowchart(parsed);if(!layout)return null;
      for(const node of layout.nodes||[]){
        if(node.mermaidRole==='state-start'){
          node.w=28;node.h=28;node.text='';node.nodeShape='ellipse';node.bgColor=this.theme==='dark'?'#e5e7eb':'#252525';node.color=node.bgColor;
        }else if(node.mermaidRole==='state-end'){
          node.w=30;node.h=30;node.text='';node.nodeShape='ellipse';node.bgColor=this.themePaperColor();node.color=this.theme==='dark'?'#e5e7eb':'#252525';
        }else{
          node.nodeShape='rounded';node.w=Math.max(150,node.w);node.h=Math.max(48,node.h);
        }
      }
      for(const edge of layout.edges||[])edge.style='orthogonal';
      return layout;
    }

    layoutMermaidClass(parsed){
      const layout=this.layoutMermaidFlowchart({...parsed,direction:parsed.direction||'LR'});if(!layout)return null;
      for(const node of layout.nodes||[]){node.nodeShape='rect';node.w=Math.max(220,node.w);node.h=Math.max(72,node.h);}
      for(const edge of layout.edges||[]){
        edge.style='orthogonal';
        const relation=String(edge.label||'').match(/^(<\|--|--\|>|\*--|--\*|o--|--o|\.\.>|<\.\.|-->|<--|--|\.\.)/)?.[1]||'';
        if(relation.includes('.'))edge.dashed=true;
        if(relation==='--'||relation==='..')edge.arrow=false;
      }
      return layout;
    }

    layoutMermaidSequence(parsed){
      const participants=parsed.participants||[],messages=parsed.messages||[];if(!participants.length)return null;
      const cx=(this.width/2-this.offsetX)/this.scale,cy=(this.height/2-this.offsetY)/this.scale;
      const stroke=this.theme==='dark'?'#d8d3ca':'#5d5952',textColor=this.theme==='dark'?'#ffffff':'#1f1f1f',bg=this.theme==='dark'?'#24211d':'#ffffff',edgeColor=this.theme==='dark'?'#9aa3ad':'#7d8794';
      const colGap=210,rowGap=70,topY=cy-(Math.max(1,messages.length)*rowGap+120)/2;
      const left=cx-(participants.length-1)*colGap/2;
      const created=[],edges=[],column=new Map();
      const makeNode=(id,text,x,y,w=150,h=44,hidden=false)=>{
        const node={id:newId(),type:'mindnode',mermaid:true,mermaidType:'sequence',mermaidRole:hidden?'sequence-anchor':'sequence-participant',mermaidId:id,nodeShape:hidden?'ellipse':'rounded',x,y,w,h,text:hidden?'':text,parentId:null,fontSize:15,color:hidden?'rgba(0,0,0,0)':stroke,textColor:hidden?'rgba(0,0,0,0)':textColor,bgColor:bg,bgOpacity:hidden?0:1};
        if(!hidden){const centerX=x+w/2;this.updateMindNodeMetrics(node);node.w=Math.max(138,node.w);node.h=Math.max(44,node.h);node.x=centerX-node.w/2;}
        created.push(node);return node;
      };
      participants.forEach((part,index)=>{
        const x=left+index*colGap;column.set(part.id,x);
        const header=makeNode(part.id,part.text||part.id,x-75,topY,150,44,false);
        const bottom=makeNode(`${part.id}_life_end`,'',x-5,topY+90+Math.max(1,messages.length)*rowGap,10,10,true);
        edges.push({id:newId(),type:'mindedge',fromId:header.id,toId:bottom.id,fromSide:'bottom',toSide:'top',style:'orthogonal',color:edgeColor,size:1.1,arrow:false,dashed:true,label:'',mermaidType:'sequence',mermaidRole:'sequence-lifeline'});
      });
      messages.forEach((msg,index)=>{
        const y=topY+90+index*rowGap,fromX=column.get(msg.from),toX=column.get(msg.to);
        if(fromX==null||toX==null)return;
        const a=makeNode(`msg_${index+1}_from`,'',fromX-5,y-5,10,10,true);
        let targetX=toX;
        if(msg.from===msg.to)targetX=toX+Math.min(110,colGap*.55);
        const b=makeNode(`msg_${index+1}_to`,'',targetX-5,y-5,10,10,true);
        const toRight=targetX>=fromX;
        const label=`${parsed.autonumber?`${index+1}. `:''}${msg.label||''}`;
        edges.push({id:newId(),type:'mindedge',fromId:a.id,toId:b.id,fromSide:toRight?'right':'left',toSide:toRight?'left':'right',style:'orthogonal',color:edgeColor,size:1.6,arrow:true,dashed:!!msg.dashed,label,mermaidType:'sequence',mermaidRole:'sequence-message'});
      });
      return{nodes:created,edges};
    }

    layoutMermaidGantt(parsed){
      const tasks=(parsed.tasks||[]).map(task=>({...task}));if(!tasks.length)return null;
      const toDay=value=>{const m=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!m)return null;return Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3]))/86400000;};
      const byId=new Map(tasks.map(task=>[task.id,task]));
      for(const task of tasks){const absolute=toDay(task.startRaw);if(absolute!=null)task.startDay=absolute;}
      for(let pass=0;pass<tasks.length+2;pass++){
        let changed=false;
        for(const task of tasks){
          if(task.startDay!=null||!task.after)continue;
          const parent=byId.get(task.after);
          if(parent?.startDay!=null){task.startDay=parent.startDay+Number(parent.durationDays||1);changed=true;}
        }
        if(!changed)break;
      }
      let fallback=Math.min(...tasks.map(task=>task.startDay).filter(Number.isFinite));
      if(!Number.isFinite(fallback))fallback=Math.floor(Date.now()/86400000);
      let cursor=fallback;
      for(const task of tasks){
        if(task.startDay==null)task.startDay=cursor;
        task.endDay=task.startDay+Number(task.durationDays||1);
        cursor=Math.max(cursor,task.endDay);
      }
      const minDay=Math.floor(Math.min(...tasks.map(task=>task.startDay)));
      const maxDay=Math.ceil(Math.max(...tasks.map(task=>task.endDay)));
      const span=Math.max(1,maxDay-minDay);
      const dayPx=Math.max(64,Math.min(118,900/span));
      const timelineWidth=span*dayPx;
      const sections=[];const sectionTasks=new Map();
      for(const task of tasks){if(!sectionTasks.has(task.section)){sectionTasks.set(task.section,[]);sections.push(task.section);}sectionTasks.get(task.section).push(task);}
      const sectionGap=14,taskH=28,laneGap=8,sectionPad=14;
      const sectionHeights=new Map();
      let chartH=0;
      for(const section of sections){const count=Math.max(1,sectionTasks.get(section).length);const h=sectionPad*2+count*taskH+Math.max(0,count-1)*laneGap;sectionHeights.set(section,h);chartH+=h+sectionGap;}
      chartH=Math.max(100,chartH-sectionGap);
      const cx=(this.width/2-this.offsetX)/this.scale,cy=(this.height/2-this.offsetY)/this.scale;
      const labelW=118,left=cx-(timelineWidth+labelW)/2+labelW,top=cy-chartH/2+20;
      const axisY=top-42,titleY=axisY-58;
      const dark=this.theme==='dark',stroke=dark?'#d8d3ca':'#5d5952',textColor=dark?'#ffffff':'#1f1f1f';
      const gridColor=dark?'#4a4d52':'#d9dde3',separatorColor=dark?'#3e4146':'#e6e8eb';
      const taskStroke=dark?'#7aa7ff':'#5f95f5',taskBg=dark?'#243247':'#edf4ff';
      const doneBg=dark?'#30343a':'#eef0f2',doneStroke=dark?'#7b8189':'#aeb5bd';
      const critBg=dark?'#4a2929':'#fff0f0',critStroke=dark?'#e07a7a':'#dc6666';
      const created=[],edges=[];
      const makeDecor=(id,text,x,y,w,h,opts={})=>{
        const node={id:newId(),type:'mindnode',mermaid:true,mermaidType:'gantt',mermaidRole:opts.role||'gantt-decor',mermaidDecorative:true,mermaidId:id,nodeShape:opts.shape||'rect',x,y,w,h,text:text||'',parentId:null,fontSize:opts.fontSize||12,color:opts.color??'rgba(0,0,0,0)',textColor:opts.textColor||textColor,bgColor:opts.bgColor||'transparent',bgOpacity:opts.bgOpacity??0};
        created.push(node);return node;
      };
      const makeAnchor=(id,x,y)=>{
        const node=makeDecor(id,'',x-2,y-2,4,4,{role:'gantt-anchor',shape:'ellipse',color:'rgba(0,0,0,0)',bgOpacity:0});
        return node;
      };
      const fmt=day=>{const d=new Date(Math.round(day)*86400000);return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;};

      makeDecor('__gantt_title',parsed.title||'甘特图',left, titleY, Math.max(260,timelineWidth),36,{role:'gantt-title',fontSize:16});
      const tickStep=Math.max(1,Math.ceil(span/10));
      const tickDays=[];
      for(let d=0;d<=span;d+=tickStep)tickDays.push(d);
      if(tickDays.at(-1)!==span)tickDays.push(span);
      for(const offset of tickDays){
        const x=left+offset*dayPx;
        makeDecor(`tick_${offset}`,fmt(minDay+offset),x-52,axisY-25,104,24,{role:'gantt-tick',fontSize:11});
        const a=makeAnchor(`grid_${offset}_a`,x,axisY+4),b=makeAnchor(`grid_${offset}_b`,x,top+chartH);
        edges.push({id:newId(),type:'mindedge',fromId:a.id,toId:b.id,fromSide:'bottom',toSide:'top',style:'orthogonal',color:gridColor,size:1,arrow:false,label:'',mermaidType:'gantt',mermaidRole:'gantt-grid'});
      }

      let y=top;
      for(let si=0;si<sections.length;si++){
        const section=sections[si],items=sectionTasks.get(section)||[],sectionH=sectionHeights.get(section)||70;
        makeDecor(`band_${si}`,'',left,y,timelineWidth,sectionH,{role:'gantt-band',bgColor:dark?(si%2?'#202226':'#1c1e22'):(si%2?'#f8fafc':'#fffdf7'),bgOpacity:.72});
        makeDecor(`section_${si}`,section,left-labelW-10,y+sectionH/2-18,labelW,36,{role:'gantt-section',fontSize:12});
        items.forEach((task,lane)=>{
          const x=left+(task.startDay-minDay)*dayPx;
          const naturalW=Math.max(20,Number(task.durationDays||1)*dayPx);
          const width=Math.max(28,naturalW-6);
          const flags=new Set(task.flags||[]);
          const isMilestone=flags.has('milestone');
          const node={id:newId(),type:'mindnode',mermaid:true,mermaidType:'gantt',mermaidRole:isMilestone?'gantt-milestone':'gantt-task',mermaidId:task.id,nodeShape:isMilestone?'diamond':'rounded',x:x+3,y:y+sectionPad+lane*(taskH+laneGap),w:isMilestone?28:width,h:taskH,text:isMilestone?'':task.label,parentId:null,fontSize:12,color:flags.has('crit')?critStroke:flags.has('done')?doneStroke:taskStroke,textColor,bgColor:flags.has('crit')?critBg:flags.has('done')?doneBg:taskBg,bgOpacity:1};
          if(isMilestone){node.y+=0;node.x=x+Math.max(0,naturalW/2-14);}
          created.push(node);
        });
        if(si<sections.length-1){
          const lineY=y+sectionH+sectionGap/2,a=makeAnchor(`sep_${si}_a`,left-labelW,lineY),b=makeAnchor(`sep_${si}_b`,left+timelineWidth,lineY);
          edges.push({id:newId(),type:'mindedge',fromId:a.id,toId:b.id,fromSide:'right',toSide:'left',style:'orthogonal',color:separatorColor,size:1,arrow:false,label:'',mermaidType:'gantt',mermaidRole:'gantt-separator'});
        }
        y+=sectionH+sectionGap;
      }
      return{nodes:created,edges};
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
      const ta=$('#mermaid-input'),text=ta?.value||'';
      const checked=globalThis.QuickdrawAI?.validateMermaid?.(text);
      if(!checked?.ok){this.toast(`Mermaid 文本无法解析：${checked?.error||'格式无效'}`);return;}
      if(this.mermaidEditMode&&checked.type!=='flowchart'){this.toast('编辑模式目前只支持 Flowchart；其他图表请作为新图导入。');return;}
      const parsed=checked.parsed;
      if(!parsed?.nodes?.length){this.toast('没有识别到可导入节点。');return;}
      const layout=this.layoutMermaidDiagram(parsed);if(!layout?.nodes?.length){this.toast('Mermaid 图表生成失败。');return;}
      if(this.mermaidEditMode){
        const ids=new Set(this.elements.filter(el=>el.type==='mindnode'&&el.mermaid&&(!el.mermaidType||el.mermaidType==='flowchart')).map(el=>el.id));
        this.elements=this.elements.filter(el=>!ids.has(el.id)&&!(el.type==='mindedge'&&(ids.has(el.fromId)||ids.has(el.toId))));
      }
      this.elements.push(...layout.nodes);this.elements.unshift(...layout.edges);this.setSelection(layout.nodes,false);this.commit();this.render();this.closeMermaidDialog();