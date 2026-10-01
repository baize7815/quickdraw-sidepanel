(() => {
  'use strict';

  const MAX_INPUT_BYTES = 12 * 1024 * 1024;
  const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;
  const MIN_DIMENSION = 64;
  const MAX_DIMENSION = 16_384;
  const GPT_IMAGE_ORIGINS = Object.freeze([
    'https://*.oaiusercontent.com/*',
    'https://oaidalleapiprodscus.blob.core.windows.net/*'
  ]);

  function imageOrigin(url) {
    try {
      const parsed = new URL(String(url || ''));
      return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port ? parsed.origin : '';
    } catch {
      return '';
    }
  }

  function isAllowedImageUrl(url) {
    const text = String(url || '');
    if (text.startsWith('blob:') || text.startsWith('data:image/')) return true;
    try {
      const parsed = new URL(text);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return false;
      const host = parsed.hostname.toLowerCase();
      return host === 'chatgpt.com' || host === 'chat.openai.com' || host.endsWith('.oaiusercontent.com') || host === 'oaidalleapiprodscus.blob.core.windows.net';
    } catch {
      return false;
    }
  }

  function guessType(bytes) {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
    if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
    return '';
  }

  async function inspectBlob(blob, { maxBytes = MAX_OUTPUT_BYTES, requireDimensions = false } = {}) {
    if (!blob || typeof blob.size !== 'number') throw new Error('图片资源无效。');
    if (blob.size <= 0 || blob.size > maxBytes) throw new Error('图片资源过大或为空。');
    const declaredType = String(blob.type || '').toLowerCase().split(';')[0];
    const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const sniffedType = guessType(bytes);
    const type = sniffedType || declaredType;
    if (!sniffedType || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)) throw new Error('返回资源不是受支持的图片。');
    if (declaredType.startsWith('image/') && declaredType !== type) throw new Error('图片类型声明与文件内容不一致。');
    let width = 0;
    let height = 0;
    if (globalThis.createImageBitmap) {
      try {
        const bitmap = await createImageBitmap(blob);
        width = bitmap.width;
        height = bitmap.height;
        bitmap.close?.();
      } catch {}
    }
    if (width && height && (width < MIN_DIMENSION || height < MIN_DIMENSION || width > MAX_DIMENSION || height > MAX_DIMENSION)) throw new Error('图片尺寸不在支持范围内。');
    if (requireDimensions && (!width || !height)) throw new Error('无法确认图片尺寸。');
    return { blob, type, bytes: blob.size, width, height };
  }

  function candidateKey(candidate = {}) {
    return String(candidate.imageUrl || candidate.src || candidate.url || candidate.fingerprint || '').slice(0, 2_000);
  }

  async function blobToDataUrl(blob, { maxBytes = MAX_OUTPUT_BYTES } = {}) {
    const checked = await inspectBlob(blob, { maxBytes });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const chunkSize = 32 * 1024;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return `data:${checked.type};base64,${btoa(binary)}`;
  }

  async function dataUrlToBlob(value, { maxBytes = MAX_OUTPUT_BYTES } = {}) {
    const text = String(value || '');
    const match = text.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/i);
    if (!match) throw new Error('图片消息编码无效。');
    const estimatedBytes = Math.floor(match[2].length * 3 / 4);
    if (estimatedBytes <= 0 || estimatedBytes > maxBytes + 2) throw new Error('图片资源过大或为空。');
    let binary;
    try { binary = atob(match[2]); } catch { throw new Error('图片消息编码无效。'); }
    if (binary.length > maxBytes) throw new Error('图片资源过大或为空。');
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return inspectBlob(new Blob([bytes], { type: match[1].toLowerCase() }), { maxBytes });
  }

  const api = { MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, MIN_DIMENSION, MAX_DIMENSION, GPT_IMAGE_ORIGINS, imageOrigin, isAllowedImageUrl, inspectBlob, blobToDataUrl, dataUrlToBlob, candidateKey };
  globalThis.QuickdrawAIImage = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
