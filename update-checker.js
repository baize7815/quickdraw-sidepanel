(() => {
  'use strict';
  const API = 'https://api.github.com/repos/baize7815/quickdraw-sidepanel/releases/latest';
  function versionParts(value) {
    const text = String(value || '').replace(/^v/, '');
    if (!/^\d+(?:\.\d+){0,3}$/.test(text)) throw new Error('发行版版本号无效。');
    return text.split('.').map(Number);
  }
  function newer(remote, local) {
    const a = versionParts(remote), b = versionParts(local);
    for (let index = 0; index < 4; index++) {
      if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0);
    }
    return false;
  }
  function releaseInfo(release, current) {
    const version = String(release.tag_name || '').replace(/^v/, '');
    versionParts(version);
    const name = `quickdraw-sidepanel-v${version}.zip`;
    const asset = (release.assets || []).find(item => item.name === name);
    const expected = `https://github.com/baize7815/quickdraw-sidepanel/releases/download/${encodeURIComponent(release.tag_name)}/${name}`;
    return { version, available: !release.draft && !release.prerelease && newer(version, current),
      downloadUrl: asset?.browser_download_url === expected ? expected : '',
      releaseUrl: `https://github.com/baize7815/quickdraw-sidepanel/releases/tag/${encodeURIComponent(release.tag_name)}` };
  }
  async function check(current, fetcher = globalThis.fetch) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetcher(API, { signal: controller.signal, cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/vnd.github+json' } });
      if (!response.ok) throw new Error(response.status === 404 ? '暂无公开发行版。' : response.status === 403 || response.status === 429 ? 'GitHub 请求受限，请稍后手动重试。' : `检查更新失败（HTTP ${response.status}）。`);
      return releaseInfo(await response.json(), current);
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('检查更新超时，请稍后重试。');
      throw error;
    } finally { clearTimeout(timer); }
  }
  const api = { check, newer, releaseInfo };
  globalThis.QuickdrawUpdates = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
