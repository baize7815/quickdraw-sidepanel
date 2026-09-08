(() => {
  'use strict';

  const AI = globalThis.QuickdrawAI;
  const Store = globalThis.QuickdrawAITaskStore;
  const STAGE_STATUS = Object.freeze({
    queued: 'queued',
    'page-loading': 'connecting',
    hydrating: 'connecting',
    uploading: 'sending',
    sending: 'sending',
    generating: 'waiting',
    returning: 'waiting'
  });
  // Keep the output group bounded by the existing input-image limit. This is
  // deliberately local because the wire protocol still supports old single
  // image events and has no separate output-limit field.
  const MAX_OUTPUT_IMAGES = Number(AI.MAX_INPUT_IMAGES || 4);

  class QuickdrawAIRouter {
    constructor(options = {}) {
      this.store = new Store();
      this.assetStore = options.assetStore || (typeof options.getAsset === 'function' ? options : null);
      this.activeByProvider = new Map();
      this.timers = new Map();
      this.providers = { gpt: new globalThis.QuickdrawGPTProvider(this.assetStore) };
      if (globalThis.QuickdrawDoubaoProvider) this.providers.doubao = new globalThis.QuickdrawDoubaoProvider(this.assetStore);
      if (globalThis.QuickdrawGrokProvider) this.providers.grok = new globalThis.QuickdrawGrokProvider(this.assetStore);
      this.operationQueue = Promise.resolve();
      this.restorePassiveTaskIds = new Set();
      this.ready = this.restore();
    }

    serialize(operation) {
      const result = this.operationQueue.catch(() => {}).then(operation);
      this.operationQueue = result.catch(() => {});
      return result;
    }

    async restore() {
      await this.store.pruneHistory();
      const tasks = await this.store.list().catch(() => []);
      const now = Date.now();
      const restartable = [];
      for (const task of tasks) {
        if (task.status === 'importing') {
          await this.update(task, { status: task.kind === 'image-edit' ? 'image-ready' : 'pending', error: '上次导入未完成，结果已保留，可手动重试。', claimedBy: null, claimedAt: null, deadlineAt: null });
          continue;
        }
        if (task.status === 'paused') continue;
        if (!AI.isActiveTask(task)) continue;
        if (task.status === 'queued' || (task.status === 'connecting' && task.stage === 'page-loading')) {
          if (!this.activeByProvider.has(task.provider)) {
            this.activeByProvider.set(task.provider, task.taskId);
            restartable.push(task);
          }
          continue;
        }
        const resumable = task.status === 'waiting' || (task.status === 'sending' && ['sending', 'generating', 'returning'].includes(String(task.stage || '')));
        const passive = AI.shouldWaitForInPageContinuation?.(task, now);
        if ((!resumable || !AI.shouldResumeWithoutResend(task, now)) && !passive) {
          if (await this.recoverExpiredTask(task)) continue;
          const deadline = Math.min(...[Number(task.stageDeadlineAt || 0), Number(task.deadlineAt || 0)].filter(value => value > 0), Infinity);
          const label = this.providers[task.provider]?.getLabel?.() || 'AI';
          const error = (resumable || ['hydrating','uploading'].includes(String(task.stage || ''))) && deadline <= now ? `${label} 页面未找到本次任务，且恢复截止时间已过，未自动重发。` : '扩展恢复时任务未完成，未自动重发。';
          await this.update(task, { status: 'needs-attention', error, deadlineAt: null, stageDeadlineAt: 0 });
          await this.cleanupOwnedTab(task);
          continue;
        }
        if (!this.activeByProvider.has(task.provider)) this.activeByProvider.set(task.provider, task.taskId);
        this.scheduleTimeout(task);
      }
      await this.recoverWaitingTasks(await this.store.list());
      this.restorePassiveTaskIds.clear();
      for (const task of restartable) this.runProvider(task).catch(error => this.serialize(async () => {
        const current = await this.store.find(task.taskId);
        if (current && AI.isActiveTask(current)) await this.finishActive(current, 'needs-attention', String(error?.message || `${this.providers[current.provider]?.getLabel?.() || 'AI'} 页面恢复失败。`));
      })).catch(() => {});
    }

    async recoverWaitingTasks(tasks) {
      for (const task of tasks) {
        if (this.restorePassiveTaskIds.has(task.taskId)) continue;
        if (!AI.shouldResumeWithoutResend(task)) continue;
        if (!Number.isInteger(task.tabId)) {
          await this.update(task, { status: 'needs-attention', error: `${this.providers[task.provider]?.getLabel?.() || 'AI'} 任务缺少标签页，未自动重发。`, deadlineAt: null });
          await this.cleanupOwnedTab(task);
          this.release(task);
          continue;
        }
        try {
          await this.providers[task.provider].resume(task);
        } catch {
          await this.update(task, { status: 'needs-attention', error: `${this.providers[task.provider]?.getLabel?.() || 'AI'} 页面已刷新或无法恢复，未自动重发。`, deadlineAt: null });
          await this.cleanupOwnedTab(task);
          this.release(task);
        }
      }
    }

    async recoverExpiredTask(task) {
      const provider = this.providers[task?.provider];
      if (!provider?.probe || !Number.isInteger(task?.tabId)) return false;
      const oldStage = String(task.stage || '');
      const fallbackStage = ['page-loading','hydrating','uploading','sending','generating','returning'].includes(oldStage) ? oldStage : (task.status === 'sending' ? 'sending' : 'generating');
      const renewUntil = Date.now() + AI.stageTimeout(fallbackStage);
      let state;
      try { state = await provider.probe(task, { renewUntil }); } catch { return false; }
      if (!state || (!state.active && !state.requestFound)) return false;
      if (state.active) {
        const candidateStage = ['page-loading','hydrating','uploading','sending','generating','returning'].includes(String(state.stage || '')) ? String(state.stage) : fallbackStage;
        const stage = AI.stageOrder(candidateStage) >= AI.stageOrder(task.stage) ? candidateStage : fallbackStage;
        const status = STAGE_STATUS[stage] || task.status;
        const updated = await this.advanceStage(task, stage, {
          status,
          requestFingerprint: String(state.requestFingerprint || task.requestFingerprint || '').slice(0, 80),
          requestMessageId: String(state.requestMessageId || task.requestMessageId || '').slice(0, 240),
          stageProgress: Number.isFinite(state.progress) ? Math.max(0, Math.min(1, Number(state.progress))) : task.stageProgress
        }, { reset: true });
        this.activeByProvider.set(task.provider, task.taskId);
        this.restorePassiveTaskIds.add(updated.taskId);
        return true;
      }
      const stage = task.status === 'sending' && !state.hasReply ? 'sending' : 'generating';
      const status = STAGE_STATUS[stage] || task.status;
      await this.advanceStage(task, stage, {
        status,
        requestFingerprint: String(state.requestFingerprint || task.requestFingerprint || '').slice(0, 80),
        requestMessageId: String(state.requestMessageId || task.requestMessageId || '').slice(0, 240),
        baselineHashes: Array.isArray(task.baselineHashes) ? task.baselineHashes.slice(0, 80) : []
      }, { reset: true });
      this.activeByProvider.set(task.provider, task.taskId);
      return true;
    }

    async emit(task) {
      try { chrome.runtime.sendMessage({ type: 'qd-ai-task-updated', task }).catch(() => {}); } catch {}
    }

    async update(task, patch) {
      const next = { ...task, ...patch, updatedAt: Date.now() };
      const saved = await this.store.upsert(next);
      await this.emit(saved);
      return saved;
    }

    stagePatch(task, stage, patch = {}, options = {}) {
      const name = String(stage || '');
      if (!AI.STAGES?.[name]) return { ...patch };
      const now = Date.now();
      const same = task?.stage === name && Number(task?.stageDeadlineAt || 0) > now;
      const startedAt = same ? Number(task.stageStartedAt || now) : now;
      const stageDeadlineAt = same && !options.reset ? Number(task.stageDeadlineAt) : now + AI.stageTimeout(name);
      const status = patch.status || STAGE_STATUS[name] || task.status;
      return {
        ...patch,
        status,
        stage: name,
        stageStartedAt: startedAt,
        stageDeadlineAt,
        stageLastProgressAt: now,
        stageToken: same && task.stageToken ? task.stageToken : `${task.taskId}:${name}:${now}`,
        deadlineAt: stageDeadlineAt
      };
    }

    async advanceStage(task, stage, patch = {}, options = {}) {
      const name = String(stage || '');
      if (!AI.STAGES?.[name]) return this.update(task, patch);
      const currentOrder = AI.stageOrder(task?.stage);
      const nextOrder = AI.stageOrder(name);
      if (currentOrder >= 0 && nextOrder >= 0 && nextOrder < currentOrder) return task;
      const updated = await this.update(task, this.stagePatch(task, name, patch, options));
      this.scheduleTimeout(updated);
      return updated;
    }

    scheduleTimeout(task) {
      clearTimeout(this.timers.get(task.taskId));
      const deadlines = [Number(task.stageDeadlineAt || 0), Number(task.deadlineAt || 0)].filter(value => value > 0);
      if (!deadlines.length) return;
      const delay = Math.max(250, Math.min(...deadlines) - Date.now());
      const timer = setTimeout(() => this.timeoutTask(task.taskId).catch(() => {}), delay);
      this.timers.set(task.taskId, timer);
    }

    async stopListener(task) { await this.providers[task.provider]?.stop(task); }

    async cleanupInput(task) {
      if (task?.kind === 'image-edit' && this.assetStore?.deleteAsset) {
        const ids = Array.isArray(task.inputAssetIds) && task.inputAssetIds.length ? task.inputAssetIds : (Array.isArray(task.inputAssets) ? task.inputAssets.map(item => item?.assetId) : [task.inputAssetId]);
        for (const id of new Set(ids.filter(Boolean))) await this.assetStore.deleteAsset(id).catch(() => {});
      }
    }

    async cleanupOwnedTab(task) {
      if (!task || !this.providers[task.provider]?.cleanup) return false;
      const provider = this.providers[task.provider];
      const meta = provider.getTabMeta?.() || await provider.loadTabMeta?.();
      const candidate = meta?.taskId === task.taskId ? {
        ...task,
        tabId: Number.isInteger(task.tabId) ? task.tabId : meta.tabId,
        tabOwned: task.tabOwned === true || meta.ownedByExtension === true,
        tabOwnerToken: task.tabOwnerToken || meta.ownerToken || ''
      } : task;
      return provider.cleanup(candidate).catch(() => false);
    }

    async finishActive(task, status, error, options = {}) {
      await this.stopListener(task);
      const preservePage = status === 'needs-attention' && task.provider === 'gpt' && task.kind === 'image-edit';
      if (preservePage) await this.providers[task.provider]?.detach?.(task);
      else await this.cleanupOwnedTab(task);
      const finished = await this.update(task, { status, error: AI.limitText(error || '', 1_000), deadlineAt: null, stageDeadlineAt: 0, ...(options.patch || {}) });
      if (options.cleanupInput !== false) await this.cleanupInput(task);
      this.release(finished);
      return finished;
    }

    async timeoutTask(taskId) {
      return this.serialize(async () => {
      const task = await this.store.find(taskId);
      if (!AI.isActiveTask(task)) return;
      const deadlines = [Number(task.stageDeadlineAt || 0), Number(task.deadlineAt || 0)].filter(value => value > 0);
      if (!deadlines.length) { clearTimeout(this.timers.get(task.taskId)); this.timers.delete(task.taskId); return; }
      if (deadlines.length && Math.min(...deadlines) > Date.now()) { this.scheduleTimeout(task); return; }
      const error = task.stage === 'uploading' ? '图片上传长时间没有可验证进展，任务已停止，未自动重发。' : `${this.providers[task.provider]?.getLabel?.() || 'AI'} ${task.stage || '处理'}阶段超时，未自动重发。`;
      await this.finishActive(task, 'needs-attention', error);
      });
    }

    release(task) {
      clearTimeout(this.timers.get(task.taskId));
      this.timers.delete(task.taskId);
      if (this.activeByProvider.get(task.provider) === task.taskId) this.activeByProvider.delete(task.provider);
    }

    async submit(payload = {}) {
      await this.ready;
      const provider = AI.provider(payload.provider || 'gpt');
      const kind = payload.kind === 'image-edit' ? 'image-edit' : 'mindmap';
      const capability = kind === 'image-edit' ? 'image' : 'mermaid';
      if (!provider?.enabled || !provider.capabilities[capability]) return { ok: false, error: kind === 'image-edit' ? '当前 AI平台尚未接入图片编辑。' : '当前 AI平台尚未接入脑图。' };
      if (payload.taskId) {
        const previous = await this.store.find(payload.taskId);
        if (previous) return { ok: true, taskId: previous.taskId };
      }
      const storedTasks = await this.store.list();
      if (storedTasks.some(item => item.provider === provider.id && item.status === 'paused')) return { ok: false, error: `${provider.label} 登录或验证任务仍在暂停，请先打开${provider.label}并继续原任务。` };
      const pending = storedTasks.filter(item => ['ready','pending','image-ready','pending-image','importing'].includes(item.status));
      if (pending.length >= AI.MAX_TASKS - 1) return { ok: false, error: '待导入结果已满，请先导入已有结果。' };
      if (pending.some(item => item.tabOwned === true)) return { ok: false, error: '扩展临时 AI 标签页仍绑定待导入结果，请先完成导入。' };
      if (this.activeByProvider.has(provider.id)) return { ok: false, error: `${provider.label} 正在处理上一项任务，请等待结果或打开任务面板。` };
      let task;
      try {
        task = AI.createTask({ ...payload, provider: provider.id });
      } catch (error) {
        return { ok: false, error: String(error?.message || 'AI 任务参数无效。') };
      }
      task.stage = 'queued';
      task.stageStartedAt = Date.now();
      task.stageLastProgressAt = task.stageStartedAt;
      task.stageDeadlineAt = task.stageStartedAt + AI.stageTimeout('queued');
      task.deadlineAt = task.stageDeadlineAt;
      this.activeByProvider.set(provider.id, task.taskId);
      this.scheduleTimeout(task);
      try { await this.store.upsert(task); }
      catch (error) { this.release(task); return { ok: false, error: String(error?.message || 'AI 任务保存失败。') }; }
      await this.emit(task);
      this.runProvider(task).catch(error => this.serialize(async () => {
        const current = await this.store.find(task.taskId);
        if (!current || !AI.isActiveTask(current)) return;
        await this.finishActive(current, 'needs-attention', String(error?.message || `${this.providers[current.provider]?.getLabel?.() || 'AI'} 任务启动结果不明，请检查对应标签页。`));
      })).catch(() => {});
      return { ok: true, taskId: task.taskId };
    }

    async runProvider(task) {
      const initial = await this.store.find(task.taskId);
      if (!AI.isActiveTask(initial)) return;
      task = initial;
      const provider = this.providers[task.provider];
      const staged = await this.serialize(async () => {
        const latest = await this.store.find(task.taskId);
        if (!AI.isActiveTask(latest)) return null;
        return this.advanceStage(latest, 'page-loading', { status: 'connecting', error: '' }, { reset: true });
      });
      if (!staged) return;
      let tabId;
      try { tabId = await provider.prepare(task); }
      catch (error) {
        if (error?.code !== 'auth-required') throw error;
        await this.serialize(async () => {
          const latest = await this.store.find(task.taskId);
          if (!latest || !AI.isActiveTask(latest)) return;
          const meta = provider.getTabMeta?.() || await provider.loadTabMeta?.() || {};
          const paused = await this.update(latest, {
            status: 'paused', pauseReason: 'auth-required', pausedAt: Date.now(),
            tabId: Number.isInteger(error.tabId) ? error.tabId : meta.tabId,
            tabOwned: meta.ownedByExtension === true, tabOwnerToken: String(meta.ownerToken || ''),
            tabGroupId: Number.isInteger(meta.groupId) ? meta.groupId : null, tabGroupError: String(meta.groupError || ''),
            error: String(error.message || 'GPT 页面需要登录或完成验证，任务已暂停。'), deadlineAt: null, stageDeadlineAt: 0
          });
          this.release(paused);
        });
        return;
      }
      const current = await this.serialize(async () => {
        const latest = await this.store.find(task.taskId);
        if (latest?.status !== 'connecting') return null;
        const meta = provider.getTabMeta?.() || {};
        return this.advanceStage(latest, 'hydrating', {
          tabId,
          status: 'connecting',
          tabOwned: meta.ownedByExtension === true,
          tabOwnerToken: String(meta.ownerToken || ''),
          tabGroupId: Number.isInteger(meta.groupId) ? meta.groupId : null,
          tabGroupError: String(meta.groupError || ''),
          error: ''
        }, { reset: true });
      });
      if (current) {
        try { await provider.send(current); }
        catch (error) {
          if (error?.code !== 'auth-required') throw error;
          await this.serialize(async () => {
            const latest = await this.store.find(current.taskId);
            if (!latest || !AI.isActiveTask(latest)) return;
            const meta = provider.getTabMeta?.() || {};
            const paused = await this.update(latest, { status: 'paused', pauseReason: 'auth-required', pausedAt: Date.now(), tabId: Number.isInteger(error.tabId) ? error.tabId : latest.tabId, tabOwned: meta.ownedByExtension === true || latest.tabOwned === true, tabOwnerToken: String(meta.ownerToken || latest.tabOwnerToken || ''), error: String(error.message || `${provider.getLabel?.() || 'AI'} 页面需要登录或完成验证，任务已暂停。`), deadlineAt: null, stageDeadlineAt: 0 });
            this.release(paused);
          });
        }
      }
      else await this.cleanupOwnedTab(task);
    }

    isExtensionPageSender(sender) {
      try {
        const url = new URL(sender?.url);
        return sender.id === chrome.runtime.id && url.protocol === 'chrome-extension:' &&
          url.hostname === chrome.runtime.id && url.pathname === '/sidepanel.html';
      } catch { return false; }
    }

    async openProviderTab(message) {
      const task = message.taskId ? await this.store.find(message.taskId) : null;
      const provider = this.providers[task?.provider || message.provider || 'gpt'];
      if (!provider) return { ok: false, error: 'AI 平台未接入。' };
      const result = await provider.open(task);
      if (task && result?.ok && Number.isInteger(result.tabId)) {
        const meta = provider.getTabMeta?.() || {};
        if (task.tabId !== result.tabId || task.tabOwned !== (meta.ownedByExtension === true) || task.tabOwnerToken !== String(meta.ownerToken || '')) {
          result.task = await this.update(task, {
            tabId: result.tabId,
            tabOwned: meta.ownedByExtension === true,
            tabOwnerToken: String(meta.ownerToken || ''),
            tabGroupId: Number.isInteger(meta.groupId) ? meta.groupId : null,
            tabGroupError: String(meta.groupError || '')
          });
        } else result.task = task;
        if (meta.groupError) result.groupError = meta.groupError;
      }
      return result;
    }

    async handleMessage(message, sender) {
      if (!message || typeof message.type !== 'string') return undefined;
      if (message.type === 'qd-ai-provider-event') return this.serialize(() => this.handleProviderEvent(message, sender));
      if (!this.isExtensionPageSender(sender)) return { ok: false, error: '拒绝非画板页面消息。' };
      if (message.type === 'qd-ai-submit') return this.serialize(() => this.submit(message.payload || {}));
      if (message.type === 'qd-ai-claim-import') return this.serialize(() => this.claimImport(message));
      if (message.type === 'qd-ai-release-import') return this.serialize(() => this.releaseImport(message));
      if (message.type === 'qd-ai-mark-imported') return this.serialize(() => this.markImported(message));
      if (message.type === 'qd-ai-cancel') return this.serialize(() => this.cancelTask(message));
      if (message.type === 'qd-ai-resume') return this.serialize(() => this.resumePausedTask(message));
      if (message.type === 'qd-ai-retry-image') return this.serialize(() => this.retryImage(message));
      if (message.type === 'qd-ai-open-provider') return this.serialize(async () => { await this.ready; return this.openProviderTab(message); });
      if (message.type === 'qd-ai-list-tasks') return this.serialize(async () => { await this.ready; return { ok: true, tasks: await this.store.list() }; });
      return undefined;
    }

    normalizeImageResults(message) {
      const raw = Array.isArray(message?.images) && message.images.length
        ? message.images
        : [message || {}];
      const seen = new Set();
      const results = [];
      for (let order = 0; order < raw.length; order++) {
        const item = raw[order];
        if (!item || typeof item !== 'object') continue;
        const imageUrl = String(item.imageUrl || item.src || '').trim().slice(0, 2_000);
        const imageDataUrl = String(item.imageDataUrl || '').trim();
        const fingerprint = String(item.fingerprint || item.imageFingerprint || '').trim().slice(0, 240);
        const keys = [fingerprint && `fingerprint:${fingerprint}`, imageUrl && `url:${imageUrl}`, imageDataUrl && `data:${imageDataUrl}`].filter(Boolean);
        if (!keys.length || keys.some(key => seen.has(key))) continue;
        for (const key of keys) seen.add(key);
        results.push({
          imageUrl,
          imageDataUrl,
          fingerprint,
          imageWidth: Math.max(0, Math.min(16_384, Number(item.imageWidth ?? item.width) || 0)),
          imageHeight: Math.max(0, Math.min(16_384, Number(item.imageHeight ?? item.height) || 0)),
          imageType: String(item.imageType || item.type || '').slice(0, 80),
          order
        });
      }
      if (results.length > MAX_OUTPUT_IMAGES) throw new Error(`一次最多保存 ${MAX_OUTPUT_IMAGES} 张生成图片。`);
      return results;
    }

    outputImageRecord(assetId, materialized, item, order) {
      return {
        assetId: String(assetId || '').slice(0, 200),
        imageUrl: String(materialized?.imageUrl || item?.imageUrl || '').slice(0, 2_000),
        imageType: String(materialized?.type || item?.imageType || '').slice(0, 80),
        imageBytes: Math.max(0, Number(materialized?.bytes ?? materialized?.blob?.size) || 0),
        imageWidth: Math.max(0, Math.min(16_384, Number(materialized?.width || item?.imageWidth) || 0)),
        imageHeight: Math.max(0, Math.min(16_384, Number(materialized?.height || item?.imageHeight) || 0)),
        fingerprint: String(item?.fingerprint || '').slice(0, 240),
        order
      };
    }

    pendingImageRecord(item, error, provider) {
      const imageUrl = String(item?.imageUrl || '').slice(0, 2_000);
      let permissionOrigins = Array.isArray(error?.permissionOrigins) ? error.permissionOrigins : [];
      if (!permissionOrigins.length && imageUrl) {
        try { permissionOrigins = provider?.getOutputPermissionOrigins?.(imageUrl) || []; } catch {}
      }
      return {
        imageUrl,
        imageType: String(item?.imageType || '').slice(0, 80),
        imageWidth: Math.max(0, Math.min(16_384, Number(item?.imageWidth) || 0)),
        imageHeight: Math.max(0, Math.min(16_384, Number(item?.imageHeight) || 0)),
        fingerprint: String(item?.fingerprint || '').slice(0, 240),
        permissionOrigins: permissionOrigins.slice(0, 4).map(String),
        order: Number.isFinite(item?.order) ? Number(item.order) : 0
      };
    }

    imageTaskPatch(outputs, pending, errors, task, nextSeen = task.seenEventKeys || []) {
      const sortedOutputs = [...outputs].sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
      const sortedPending = [...pending].sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
      const first = sortedOutputs[0] || {};
      const origins = [];
      for (const item of sortedPending) for (const origin of item.permissionOrigins || []) if (/^https:\/\/(?:\*\.)?[a-z0-9.-]+\/\*$/i.test(origin) && !origins.includes(origin)) origins.push(origin);
      const hasPermissionError = errors.some(error => error?.code === 'image-origin-permission');
      return {
        status: 'pending-image',
        outputImages: sortedOutputs,
        outputAssetId: first.assetId || '',
        imageUrl: first.imageUrl || sortedPending[0]?.imageUrl || '',
        imagePermissionOrigins: origins.slice(0, 4),
        imageType: first.imageType || '', imageBytes: first.imageBytes || 0,
        imageWidth: first.imageWidth || 0, imageHeight: first.imageHeight || 0,
        pendingImageResults: sortedPending,
        error: hasPermissionError ? '部分图片来自未授权网站，请授予图片所在网站权限后重试。' : '部分图片无法读取，请检查图片地址后重试。',
        deadlineAt: null, stageDeadlineAt: 0, seenEventKeys: nextSeen
      };
    }

    async materializeImageResults(task, items, existingOutputs = []) {
      const provider = this.providers[task.provider];
      if (!this.assetStore || !provider?.materializeImage) throw new Error('图片资源存储不可用。');
      const outputs = [...(Array.isArray(existingOutputs) ? existingOutputs : [])];
      const pending = [];
      const errors = [];
      const createdAssetIds = [];
      for (const item of items) {
        try {
          const materialized = await provider.materializeImage(item);
          const assetId = await this.assetStore.putAsset(materialized.blob, {
            sourceUrl: materialized.imageUrl || item.imageUrl || '', imageType: materialized.type,
            imageBytes: materialized.bytes, imageWidth: materialized.width || item.imageWidth || 0,
            imageHeight: materialized.height || item.imageHeight || 0, generatedBy: task.taskId
          });
          createdAssetIds.push(assetId);
          outputs.push(this.outputImageRecord(assetId, materialized, item, item.order));
        } catch (error) {
          errors.push(error);
          pending.push(this.pendingImageRecord(item, error, provider));
        }
      }
      return { outputs, pending, errors, createdAssetIds };
    }

    async retryImage(message) {
      await this.ready;
      const task = await this.store.find(message.taskId);
      if (!task || task.kind !== 'image-edit' || task.status !== 'pending-image') return { ok: false, error: '图片任务不可重试。' };
      const pending = Array.isArray(task.pendingImageResults) && task.pendingImageResults.length
        ? task.pendingImageResults.map((item, order) => ({ ...item, order: Number.isFinite(item?.order) ? Number(item.order) : order }))
        : (task.imageUrl ? [{ imageUrl: task.imageUrl, order: 0 }] : []);
      if (!pending.length) return { ok: false, error: '图片任务缺少待读取地址。' };
      const existing = Array.isArray(task.outputImages) && task.outputImages.length
        ? task.outputImages
        : (task.outputAssetId ? [{ assetId: task.outputAssetId, imageUrl: task.imageUrl, imageType: task.imageType, imageBytes: task.imageBytes, imageWidth: task.imageWidth, imageHeight: task.imageHeight, order: 0 }] : []);
      let result;
      try { result = await this.materializeImageResults(task, pending, existing); }
      catch (error) { return { ok: false, error: String(error?.message || '图片读取失败，请检查权限后重试。') }; }
      const outputs = [...result.outputs].sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
      if (result.pending.length) {
        let updated;
        try { updated = await this.update(task, this.imageTaskPatch(outputs, result.pending, result.errors, task)); }
        catch (error) { for (const id of result.createdAssetIds) await this.assetStore.deleteAsset?.(id).catch?.(() => {}); return { ok: false, error: String(error?.message || '图片任务保存失败。') }; }
        return { ok: false, error: updated.error, task: updated, pendingImagePermission: result.errors.some(error => error?.code === 'image-origin-permission') };
      }
      const first = outputs[0] || {};
      let ready;
      try {
        ready = await this.update(task, {
          status: 'image-ready', outputImages: outputs, pendingImageResults: [], outputAssetId: first.assetId || '',
          imageUrl: first.imageUrl || '', imagePermissionOrigins: [], imageType: first.imageType || '', imageBytes: first.imageBytes || 0,
          imageWidth: first.imageWidth || 0, imageHeight: first.imageHeight || 0, error: '', deadlineAt: null, stageDeadlineAt: 0
        });
      } catch (error) {
        for (const id of result.createdAssetIds) await this.assetStore.deleteAsset?.(id).catch?.(() => {});
        return { ok: false, error: String(error?.message || '图片任务保存失败。') };
      }
      await this.cleanupInput(task);
      return { ok: true, task: ready };
    }

    async cancelTask(message) {
      await this.ready;
      const task = await this.store.find(message.taskId);
      if (!task || !AI.isActiveTask(task)) return { ok: true, alreadyFinished: true, task: task || { taskId: String(message.taskId || ''), status: 'cancelled' } };
      const cancelled = await this.finishActive(task, 'cancelled', '任务已取消。');
      return { ok: true, task: cancelled };
    }

    async resumePausedTask(message) {
      await this.ready;
      let task = await this.store.find(message.taskId);
      if (!task || task.status !== 'paused') return { ok: false, error: '任务未处于可继续状态。' };
      if (this.activeByProvider.has(task.provider) && this.activeByProvider.get(task.provider) !== task.taskId) return { ok: false, error: `${this.providers[task.provider]?.getLabel?.() || 'AI'} 正在处理其他任务，请稍候。` };
      const provider = this.providers[task.provider];
      if (!provider) return { ok: false, error: 'AI 平台未接入。' };
      try {
        let tab = null;
        if (Number.isInteger(task.tabId)) { try { tab = await chrome.tabs.get(task.tabId); } catch {} }
        if (tab && provider.isAllowedAuthUrl?.(tab.url || tab.pendingUrl)) return { ok: false, error: `请先在已打开的 ${provider.getLabel?.() || 'AI'} 标签页完成登录或验证。` };
        if (task.pauseReason === 'conversation-conflict' && (!tab || !provider.isAllowedUrl?.(tab.url || tab.pendingUrl))) {
          return { ok: false, error: '原豆包会话已不可用，请取消任务后重新开始；未重新上传或发送。' };
        }
        if (!tab || !provider.isAllowedUrl?.(tab.url || tab.pendingUrl)) {
          const tabId = await provider.ensureTab(task.sourceWindowId, task);
          const meta = provider.getTabMeta?.() || {};
          task = await this.update(task, {
            tabId,
            tabOwned: meta.ownedByExtension === true,
            tabOwnerToken: String(meta.ownerToken || ''),
            tabGroupId: Number.isInteger(meta.groupId) ? meta.groupId : null,
            tabGroupError: String(meta.groupError || '')
          });
        }
        this.activeByProvider.set(task.provider, task.taskId);
        if (['raw-image-unavailable', 'conversation-conflict'].includes(task.pauseReason)) {
          const current = await this.advanceStage(task, 'generating', { status: 'waiting', error: '', pauseReason: '', pausedAt: 0 }, { reset: true });
          await provider.resume(current);
          return { ok: true, task: current };
        }
        const current = await this.advanceStage(task, 'hydrating', { status: 'connecting', error: '', pauseReason: '', pausedAt: 0 }, { reset: true });
        await provider.send(current);
        return { ok: true, task: current };
      } catch (error) {
        const current = await this.store.find(task.taskId);
        if (current && task.pauseReason === 'conversation-conflict') {
          await this.stopListener(current).catch(() => {});
          await this.update(current, { status: 'paused', pauseReason: 'conversation-conflict', pausedAt: Date.now(), error: String(error?.message || '原会话恢复失败，页面已保留。'), deadlineAt: null, stageDeadlineAt: 0 });
          this.release(current);
          return { ok: false, error: String(error?.message || '原会话恢复失败，页面已保留。') };
        }
        if (current && AI.isActiveTask(current)) await this.finishActive(current, 'needs-attention', String(error?.message || `${provider.getLabel?.() || 'AI'} 任务恢复失败。`));
        return { ok: false, error: String(error?.message || `${provider.getLabel?.() || 'AI'} 任务恢复失败。`) };
      }
    }

    async handleProviderEvent(message, sender) {
      await this.ready;
      const task = await this.store.find(message.taskId);
      if (!task) return { ok: false, error: '任务不存在或已结束。' };
      const eventForKey = message.kind === 'image-reply' && Array.isArray(message.images)
        ? { ...message, imageUrl: message.imageUrl || message.images.map(item => item?.imageUrl || item?.src || '').filter(Boolean).join('|'), fingerprint: message.fingerprint || message.images.map(item => item?.fingerprint || item?.imageFingerprint || '').filter(Boolean).join('|') }
        : message;
      const key = AI.eventKey(eventForKey);
      if (!['connecting','sending','waiting'].includes(task.status)) {
        if (Array.isArray(task.seenEventKeys) && task.seenEventKeys.includes(key) && this.providers[task.provider]?.accepts(sender, task)) return { ok: true, duplicate: true };
        return { ok: false, error: '任务不存在或已结束。' };
      }
      const deadlines = [Number(task.stageDeadlineAt || 0), Number(task.deadlineAt || 0)].filter(value => value > 0);
      const authEvent = message.kind === 'needs-attention' && message.code === 'auth-required';
      const authPause = authEvent && task.status === 'connecting' && ['page-loading','hydrating'].includes(String(task.stage || ''));
      if (authEvent && !authPause) return { ok: true, stale: true };
      if (!authPause && deadlines.length && Math.min(...deadlines) <= Date.now()) return { ok: false, error: `任务已超时，拒绝过期 ${this.providers[task.provider]?.getLabel?.() || 'AI'} 事件。` };
      if (!this.providers[task.provider]?.accepts(sender, task)) return { ok: false, error: '拒绝未绑定 AI 标签页的消息。' };
      const seen = Array.isArray(task.seenEventKeys) ? task.seenEventKeys : [];
      if (seen.includes(key)) return { ok: true, duplicate: true };
      const nextSeen = [...seen.slice(-31), key];
      if (authPause) {
        await this.stopListener(task);
        const paused = await this.update(task, {
          status: 'paused',
          pauseReason: 'auth-required',
          pausedAt: Date.now(),
          error: AI.limitText(message.error || 'GPT 页面需要登录或完成验证，任务已暂停。', 1_000),
          deadlineAt: null,
          stageDeadlineAt: 0,
          seenEventKeys: nextSeen
        });
        this.release(task);
        return { ok: true, paused: true, task: paused };
      }
      if (message.kind === 'phase' || message.kind === 'progress') {
        const stage = String(message.stage || message.phase || '');
        if (!AI.STAGES?.[stage]) return { ok: false, error: `拒绝未知 ${this.providers[task.provider]?.getLabel?.() || 'AI'} 阶段。` };
        if (AI.stageOrder(stage) < AI.stageOrder(task.stage)) return { ok: true, stale: true };
        const status = STAGE_STATUS[stage] || task.status;
        const phasePatch = { status, seenEventKeys: nextSeen };
        const progress = message.progress == null ? null : Math.max(0, Math.min(1, Number(message.progress) || 0));
        const newStage = task.stage !== stage;
        const advanced = progress != null && progress > Number(task.stageProgress || 0);
        if (progress != null && (newStage || advanced)) phasePatch.stageProgress = progress;
        const updated = await this.advanceStage(task, stage, phasePatch, { reset: newStage || advanced });
        return { ok: true, task: updated };
      }
      if (message.kind === 'ready' || message.kind === 'resumed') {
        if (message.kind === 'resumed' && !['sending', 'waiting'].includes(task.status)) return { ok: false, error: '拒绝过期恢复事件。' };
        await this.update(task, { seenEventKeys: nextSeen, stageLastProgressAt: Date.now() });
        return { ok: true };
      }
      if (message.kind === 'send-confirmed') {
        if (!['connecting', 'sending', 'waiting'].includes(task.status) || !message.requestFingerprint) return { ok: false, error: '拒绝无效发送确认。' };
        const requestFingerprint = String(message.requestFingerprint || '').slice(0, 80);
        const requestMessageId = String(message.requestMessageId || '').slice(0, 240);
        if (task.status === 'waiting' && task.requestFingerprint === requestFingerprint) {
          if (requestMessageId && requestMessageId !== task.requestMessageId) await this.update(task, { requestMessageId, seenEventKeys: nextSeen });
          return { ok: true, duplicate: true };
        }
        const updated = await this.advanceStage(task, 'generating', { status: 'waiting', baselineHashes: Array.isArray(message.baselineHashes) ? message.baselineHashes.slice(0, 80) : [], requestFingerprint, requestMessageId, seenEventKeys: nextSeen }, { reset: true });
        return { ok: true };
      }
      if (message.kind === 'reply') {
        if (task.status !== 'waiting' || message.phase !== 'complete') return { ok: false, error: '拒绝未确认完成的回复。' };
        const rawReply = AI.limitText(message.text, AI.MAX_REPLY_LENGTH);
        const returning = await this.advanceStage(task, 'returning', { status: 'waiting', seenEventKeys: nextSeen }, { reset: true });
        const checked = AI.validateMermaid(message.text);
        if (!checked.ok) {
          const failed = await this.finishActive(returning, 'failed', `${this.providers[task.provider]?.getLabel?.() || 'AI'} 返回的 Mermaid 无法导入：${checked.error}`, { patch: { rawReply, seenEventKeys: nextSeen } });
          return { ok: false, error: failed.error };
        }
        const ready = await this.update(returning, { status: 'ready', rawReply, validatedMermaid: checked.source, deadlineAt: null, stageDeadlineAt: 0, error: '', seenEventKeys: nextSeen, stats: checked.stats });
        this.release(ready);
        return { ok: true };
      }
      if (message.kind === 'image-reply') {
        if (task.kind !== 'image-edit' || task.status !== 'waiting' || message.phase !== 'complete') return { ok: false, error: '拒绝未确认完成的图片回复。' };
        const returning = await this.advanceStage(task, 'returning', { status: 'waiting', seenEventKeys: nextSeen }, { reset: true });
        let items;
        try {
          items = this.normalizeImageResults(message);
          if (!items.length) throw new Error(`${this.providers[task.provider]?.getLabel?.() || 'AI'} 未返回图片。`);
        } catch (error) {
          const failed = await this.finishActive(returning, 'failed', error?.message || `${this.providers[task.provider]?.getLabel?.() || 'AI'} 返回图片无法导入。`, { patch: { seenEventKeys: nextSeen } });
          return { ok: false, error: failed.error };
        }
        let result;
        try { result = await this.materializeImageResults(returning, items); }
        catch (error) {
          const failed = await this.finishActive(returning, 'failed', error?.message || `${this.providers[task.provider]?.getLabel?.() || 'AI'} 返回图片无法导入。`, { patch: { seenEventKeys: nextSeen } });
          return { ok: false, error: failed.error };
        }
        if (result.pending.length) {
          try {
            const pending = await this.update(returning, this.imageTaskPatch(result.outputs, result.pending, result.errors, returning, nextSeen));
            this.release(pending);
            return { ok: true, pendingImagePermission: result.errors.some(error => error?.code === 'image-origin-permission'), task: pending };
          } catch (error) {
            for (const id of result.createdAssetIds) await this.assetStore.deleteAsset?.(id).catch?.(() => {});
            const failed = await this.finishActive(returning, 'failed', error?.message || '图片结果保存失败。', { patch: { seenEventKeys: nextSeen } });
            return { ok: false, error: failed.error };
          }
        }
        const outputs = [...result.outputs].sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
        const first = outputs[0] || {};
        let ready;
        try {
          ready = await this.update(returning, {
            status: 'image-ready', outputImages: outputs, pendingImageResults: [], outputAssetId: first.assetId || '',
            imageUrl: first.imageUrl || '', imagePermissionOrigins: [], imageType: first.imageType || '', imageBytes: first.imageBytes || 0,
            imageWidth: first.imageWidth || 0, imageHeight: first.imageHeight || 0,
            deadlineAt: null, stageDeadlineAt: 0, error: '', seenEventKeys: nextSeen
          });
        } catch (error) {
          for (const id of result.createdAssetIds) await this.assetStore.deleteAsset?.(id).catch?.(() => {});
          const failed = await this.finishActive(returning, 'failed', error?.message || '图片结果保存失败。', { patch: { seenEventKeys: nextSeen } });
          return { ok: false, error: failed.error };
        }
        // Inputs are released only after the complete output group has been
        // persisted. A failed delete is harmless here and can be retried by
        // later storage cleanup without losing the generated result.
        await this.cleanupInput(returning);
        this.release(ready);
        return { ok: true, task: ready };
      }
      if (message.kind === 'needs-attention') {
        if (message.code === 'conversation-conflict' && task.provider === 'doubao') {
          await this.stopListener(task);
          const paused = await this.update(task, { status: 'paused', pauseReason: 'conversation-conflict', pausedAt: Date.now(), error: AI.limitText(message.error || '豆包会话需要确认，页面和输入已保留。', 1_000), deadlineAt: null, stageDeadlineAt: 0, seenEventKeys: nextSeen });
          this.release(paused);
          return { ok: true, paused: true, task: paused };
        }
        if (message.code === 'raw-image-unavailable' && task.provider === 'doubao' && task.kind === 'image-edit') {
          await this.stopListener(task);
          const paused = await this.update(task, { status: 'paused', pauseReason: 'raw-image-unavailable', pausedAt: Date.now(), error: AI.limitText(message.error || '豆包原图暂不可读取。', 1_000), deadlineAt: null, stageDeadlineAt: 0, seenEventKeys: nextSeen });
          this.release(paused);
          return { ok: true, paused: true, task: paused };
        }
        const attention = await this.finishActive(task, 'needs-attention', message.error || `${this.providers[task.provider]?.getLabel?.() || 'AI'} 页面需要人工处理。`, { patch: { seenEventKeys: nextSeen } });
        return { ok: true };
      }
      return { ok: false, error: `未知 ${this.providers[task.provider]?.getLabel?.() || 'AI'} 事件。` };
    }

    async markImported(message) {
      await this.ready;
      const task = await this.store.find(message.taskId);
      if (!task && message.taskId && message.targetBoardId && message.ownerId) {
        const key = 'quickdraw_v2_file:' + String(message.targetBoardId);
        const saved = await chrome.storage.local.get(key);
        if (saved[key]?.aiTaskReceipts?.[message.taskId]) return { ok: true, task: { taskId: message.taskId, status: 'imported', importedIntoBoardId: message.targetBoardId } };
      }
      if (task?.status === 'imported') return { ok: true, task };
      const receiptRecovery = task?.status === 'needs-attention' && message.receipt === true;
      if (!task || !(receiptRecovery || ['ready', 'pending', 'image-ready', 'importing'].includes(task.status))) return { ok: false, error: '任务已经导入或不可导入。' };
      if (task.status === 'importing' && task.claimedBy && task.claimedBy !== message.ownerId) return { ok: false, error: '任务正在由另一个画板实例导入。' };
      const boardKey = 'quickdraw_v2_file:' + String(message.targetBoardId || '');
      const saved = await chrome.storage.local.get(boardKey);
      if (!saved[boardKey]?.aiTaskReceipts?.[task.taskId]) return { ok: false, error: '画板尚未保存此结果，请保存后再确认。' };
      const imported = await this.update(task, {
        status: 'imported',
        importedAt: Date.now(),
        importedIntoBoardId: String(message.targetBoardId || task.boardId),
        error: '',
        claimedBy: null,
        claimedAt: null
      });
      await this.cleanupOwnedTab(task);
      return { ok: true, task: imported };
    }

    async claimImport(message) {
      await this.ready;
      const task = await this.store.find(message.taskId);
      if (!task || !['ready', 'pending', 'image-ready'].includes(task.status)) return { ok: false, error: '任务已经导入或不可导入。' };
      const ownerId = String(message.ownerId || '');
      if (!ownerId) return { ok: false, error: '缺少导入实例。' };
      const claimed = await this.update(task, { status: 'importing', claimedBy: ownerId, claimedAt: Date.now() });
      return { ok: true, task: claimed };
    }

    async releaseImport(message) {
      await this.ready;
      const task = await this.store.find(message.taskId);
      if (!task || task.status !== 'importing' || task.claimedBy !== String(message.ownerId || '')) return { ok: false, error: '导入任务归属不匹配。' };
      const released = await this.update(task, { status: task.kind === 'image-edit' ? 'image-ready' : 'pending', claimedBy: null, claimedAt: null, error: AI.limitText(message.error || '导入未完成，可重试。', 1_000) });
      return { ok: true, task: released };
    }

    async handleTabRemoved(tabId) {
      return this.serialize(() => this._handleTabRemoved(tabId));
    }

    async _handleTabRemoved(tabId) {
      await this.ready;
      const tasks = await this.store.list();
      for (const task of tasks) {
        if (task.tabId === tabId && task.status === 'paused') {
          await this.update(task, { tabId: null, tabOwned: false, tabOwnerToken: '', tabGroupId: null, tabGroupError: '', error: `${this.providers[task.provider]?.getLabel?.() || 'AI'} 标签页已关闭，请重新打开后继续任务。` });
          continue;
        }
        if (task.tabId !== tabId || !['sending','waiting'].includes(task.status)) continue;
        await this.finishActive(task, 'needs-attention', `${this.providers[task.provider]?.getLabel?.() || 'AI'} 标签页已关闭，未自动重发。`);
      }

    }

    async handleTabUpdated(tabId, changeInfo, tab) {
      return this.serialize(() => this._handleTabUpdated(tabId, changeInfo, tab));
    }

    async _handleTabUpdated(tabId, changeInfo, tab) {
      await this.ready;
      if (changeInfo.status !== 'complete') return;
      const tasks = await this.store.list();
      for (const paused of tasks.filter(task => task.tabId === tabId && task.status === 'paused' && task.pauseReason === 'auth-required')) {
        const provider = this.providers[paused.provider];
        if (provider?.isAllowedUrl?.(tab?.url) && !provider.isAllowedAuthUrl?.(tab?.url)) {
          await this.resumePausedTask({ taskId: paused.taskId });
          return;
        }
      }
      for (const task of tasks) {
        const provider = this.providers[task.provider];
        if (!provider?.isAllowedUrl?.(tab?.url)) {
          if (task.tabId === tabId && ['sending','waiting'].includes(task.status)) await this.finishActive(task, 'needs-attention', `绑定标签页已离开 ${provider?.getLabel?.() || 'AI'}，未自动重发。`);
          continue;
        }
        if (task.tabId !== tabId || !AI.shouldResumeWithoutResend(task)) continue;
        try {
          await this.providers[task.provider].resume(task);
        } catch {
          await this.finishActive(task, 'needs-attention', `${provider.getLabel?.() || 'AI'} 页面刷新后无法恢复监听，未自动重发。`);
        }
      }
    }
  }

  globalThis.QuickdrawAIRouter = QuickdrawAIRouter;
  if (typeof module !== 'undefined' && module.exports) module.exports = QuickdrawAIRouter;
})();
