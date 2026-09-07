(() => {
  'use strict';

  const BASE_URL = 'https://www.koukoutu.com';
  const TOOL_TYPE = 'rmbg';
  const CAPTCHA_WASM_URL = 'vendor/koukoutu-recaptcha.wasm';
  const MAX_MOUSE_EVENTS = 96;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  class KoukoutuError extends Error {
    constructor(message, code = 'koukoutu-error', detail = null) {
      super(message);
      this.name = 'KoukoutuError';
      this.code = code;
      this.detail = detail;
    }
  }

  class QuickdrawKoukoutuClient {
    constructor() {
      this.mouseEvents = [];
      this.wasmBytes = null;
      this.captureMouseEvent = this.captureMouseEvent.bind(this);
      document.addEventListener('mousemove', this.captureMouseEvent, true);
      document.addEventListener('mousedown', this.captureMouseEvent, true);
      document.addEventListener('mouseup', this.captureMouseEvent, true);
    }

    captureMouseEvent(event) {
      const type = event.type === 'mousemove' ? 1 : event.type === 'mousedown' ? 2 : 3;
      this.mouseEvents.push({
        type,
        x: Math.round(event.clientX),
        y: Math.round(event.clientY),
        time: Math.round(Date.now() / 1000)
      });
      if (this.mouseEvents.length > MAX_MOUSE_EVENTS) {
        this.mouseEvents.splice(0, this.mouseEvents.length - MAX_MOUSE_EVENTS);
      }
    }

    async postForm(path, fields) {
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) form.append(key, String(value ?? ''));
      const response = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        body: form,
        credentials: 'omit',
        headers: { accept: 'application/json, text/plain, */*' }
      });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new KoukoutuError(`抠图服务返回了无法识别的内容（HTTP ${response.status}）。`, 'invalid-response', text.slice(0, 500));
      }
      if (!response.ok) {
        throw new KoukoutuError(`抠图服务请求失败（HTTP ${response.status}）。`, 'http-error', data);
      }
      return data;
    }

    extensionForBlob(blob) {
      const type = String(blob?.type || '').toLowerCase();
      if (type.includes('jpeg')) return 'jpg';
      if (type.includes('webp')) return 'webp';
      if (type.includes('gif')) return 'gif';
      if (type.includes('bmp')) return 'bmp';
      return 'png';
    }

    normalizeRemoteUrl(value) {
      if (!value) return '';
      return value.startsWith('//') ? `https:${value}` : value;
    }

    async requestUploadSignature(blob) {
      const data = await this.postForm('/api/oss/signature', {
        action: 'ucoss',
        type: TOOL_TYPE,
        token: '',
        reqType: 'PUT',
        userid: 'PUT',
        fileExt: this.extensionForBlob(blob)
      });
      const message = data?.message;
      if (!data?.success || data?.action !== 'ucoss' || message?.code !== 200 || !message.host || !message.key || !message.token) {
        throw new KoukoutuError(this.messageFrom(data, '无法获取匿名上传凭证。'), 'signature-error', data);
      }
      return message;
    }

    async uploadImage(blob, signature) {
      const imageUrl = `${this.normalizeRemoteUrl(signature.host)}${signature.key}`;
      const response = await fetch(imageUrl, {
        method: 'PUT',
        body: blob,
        credentials: 'omit',
        headers: {
          Authorization: signature.token,
          'Content-Type': 'application/octet-stream'
        }
      });
      if (!response.ok) {
        throw new KoukoutuError(`图片上传失败（HTTP ${response.status}）。`, 'upload-error');
      }
      return imageUrl;
    }

    captchaEvents() {
      const actual = this.mouseEvents.slice(-MAX_MOUSE_EVENTS);
      const moves = actual.filter(event => event.type === 1);
      if (moves.length >= 40) return actual;

      // The commissioned web flow expects a short mouse trail. When the panel has
      // just opened, interpolate the user's latest pointer location so the locally
      // bundled verifier receives the same event shape as the website.
      const anchor = actual[actual.length - 1] || {
        x: Math.round(innerWidth * 0.55),
        y: Math.round(innerHeight * 0.45),
        time: Math.round(Date.now() / 1000)
      };
      const startX = Math.max(8, anchor.x - 210);
      const startY = Math.max(8, anchor.y - 36);
      const generated = [];
      for (let index = 0; index < 40; index += 1) {
        const ratio = index / 39;
        generated.push({
          type: 1,
          x: Math.round(startX + (anchor.x - startX) * ratio),
          y: Math.round(startY + (anchor.y - startY) * ratio + Math.sin(ratio * Math.PI * 2) * 18),
          time: anchor.time - 6 + Math.floor(index / 8)
        });
      }
      const clickEvents = actual.filter(event => event.type !== 1).slice(-4);
      if (!clickEvents.some(event => event.type === 2)) generated.push({ ...anchor, type: 2 });
      if (!clickEvents.some(event => event.type === 3)) generated.push({ ...anchor, type: 3 });
      return [...generated, ...clickEvents];
    }

    async loadWasmBytes() {
      if (!this.wasmBytes) {
        const response = await fetch(chrome.runtime.getURL(CAPTCHA_WASM_URL));
        if (!response.ok) throw new KoukoutuError('验证码组件加载失败。', 'captcha-wasm-missing');
        this.wasmBytes = await response.arrayBuffer();
      }
      return this.wasmBytes;
    }

    async createCaptchaCode() {
      const bytes = await this.loadWasmBytes();
      let instance;
      const imports = {
        wasi_snapshot_preview1: {
          fd_close: () => 0,
          fd_seek: () => 0,
          fd_write: (_fd, _iovs, _count, writtenPointer) => {
            if (instance && writtenPointer) {
              new DataView(instance.exports.memory.buffer).setUint32(writtenPointer, 0, true);
            }
            return 0;
          }
        },
        env: {
          emscripten_memcpy_big: (destination, source, count) => {
            new Uint8Array(instance.exports.memory.buffer).copyWithin(destination, source, source + count);
            return destination;
          },
          emscripten_resize_heap: () => 0,
          setTempRet0: () => {}
        }
      };
      instance = (await WebAssembly.instantiate(bytes.slice(0), imports)).instance;
      const api = instance.exports;
      api.__wasm_call_ctors();

      const browserInfo = JSON.stringify({
        ua: navigator.userAgent,
        lang: navigator.language,
        w: innerWidth,
        h: innerHeight,
        tz: new Date().getTimezoneOffset()
      });
      this.callWithString(api, 'record_browser_info', browserInfo);
      for (const event of this.captchaEvents()) {
        api.add_mouse_event(event.type, event.x, event.y, event.time);
      }

      const pointer = api.get_code();
      const memory = new Uint8Array(api.memory.buffer);
      let end = pointer;
      while (end < memory.length && memory[end] !== 0) end += 1;
      const code = new TextDecoder().decode(memory.subarray(pointer, end));
      if (!code) throw new KoukoutuError('验证码生成失败。', 'captcha-empty');
      return code;
    }

    callWithString(api, functionName, value) {
      const bytes = new TextEncoder().encode(`${value}\0`);
      const stack = api.stackSave();
      const pointer = api.stackAlloc(bytes.length);
      try {
        new Uint8Array(api.memory.buffer, pointer, bytes.length).set(bytes);
        api[functionName](pointer);
      } finally {
        api.stackRestore(stack);
      }
    }

    async createTask(imageUrl, width, height) {
      const data = await this.postForm('/api/segment', {
        image: imageUrl,
        type: TOOL_TYPE,
        width,
        height,
        action: 'zero',
        token: '',
        captchacode: await this.createCaptchaCode(),
        filename: '',
        model: '3',
        edge_enhancement: '0',
        aiShadow: '0',
        modelname: ''
      });
      if (!data?.success || !data?.message?.taskId) {
        throw new KoukoutuError(this.messageFrom(data, '抠图任务创建失败。'), 'segment-error', data);
      }
      return String(data.message.taskId);
    }

    async waitForResult(taskId, onProgress) {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        await sleep(1000);
        const data = await this.postForm('/api/query', { type: TOOL_TYPE, taskId, token: '' });
        const message = data?.message;
        onProgress?.({
          state: 'processing',
          progress: Number(message?.process ?? message?.progress ?? 0),
          position: Number(message?.position ?? 0)
        });
        if (data?.success && message?.code === 200 && message?.resultpath) return message.resultpath;
        if (message?.code === 500) {
          throw new KoukoutuError(this.messageFrom(data, '抠图处理失败。'), 'processing-error', data);
        }
      }
      throw new KoukoutuError('抠图等待超时，请稍后重试。', 'timeout');
    }

    async downloadResult(resultUrl) {
      const response = await fetch(this.normalizeRemoteUrl(resultUrl), { credentials: 'omit' });
      if (!response.ok) throw new KoukoutuError(`抠图结果下载失败（HTTP ${response.status}）。`, 'download-error');
      const blob = await response.blob();
      if (blob.type.startsWith('image/')) return blob;

      // The result CDN currently serves valid WebP bytes as
      // application/octet-stream. Detect the file by its magic bytes instead
      // of trusting the response header or URL suffix.
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const ascii = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
      let mime = '';
      if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') mime = 'image/webp';
      else if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 3) === 'PNG') mime = 'image/png';
      else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) mime = 'image/jpeg';
      else if (bytes.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) mime = 'image/gif';
      else if (bytes.length >= 2 && ascii(0, 2) === 'BM') mime = 'image/bmp';
      if (!mime) throw new KoukoutuError('抠图结果不是有效图片。', 'invalid-result');
      return new Blob([bytes], { type: mime });
    }

    messageFrom(data, fallback) {
      const message = data?.message;
      if (typeof message === 'string' && message.trim()) {
        if (message.includes('captchacode')) return '匿名验证失败，请移动鼠标后重试。';
        return message;
      }
      if (message?.message) return String(message.message);
      if (message?.detailinfo) return String(message.detailinfo);
      return fallback;
    }

    async removeBackground(blob, dimensions, onProgress) {
      if (!(blob instanceof Blob) || !blob.type.startsWith('image/')) {
        throw new KoukoutuError('请选择有效图片。', 'invalid-image');
      }
      if (Math.min(dimensions?.width || 0, dimensions?.height || 0) < 24) {
        throw new KoukoutuError('图片尺寸太小，宽和高都需要至少 24 像素。', 'image-too-small');
      }
      onProgress?.({ state: 'signature' });
      const signature = await this.requestUploadSignature(blob);
      onProgress?.({ state: 'uploading' });
      const imageUrl = await this.uploadImage(blob, signature);
      onProgress?.({ state: 'creating' });
      const taskId = await this.createTask(imageUrl, dimensions.width, dimensions.height);
      const resultUrl = await this.waitForResult(taskId, onProgress);
      onProgress?.({ state: 'downloading', progress: 100 });
      return this.downloadResult(resultUrl);
    }
  }

  globalThis.QuickdrawKoukoutuClient = QuickdrawKoukoutuClient;
  globalThis.KoukoutuError = KoukoutuError;
})();
