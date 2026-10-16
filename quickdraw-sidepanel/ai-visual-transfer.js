(() => {
  'use strict';
  async function cleanup(store, ids) {
    for (const id of ids || []) {
      try { await store?.deleteAsset?.(id); } catch {}
    }
  }
  async function stage(store, sourceAssetIds, verify) {
    if (!store?.getAsset || !store?.putAsset || !Array.isArray(sourceAssetIds) || !sourceAssetIds.length) throw new Error('AI 图片任务缺少可复制的输入资源。');
    const copies=[];
    try {
      for (let order=0;order<sourceAssetIds.length;order++) {
        const assetId=sourceAssetIds[order];
        const record=await store.getAsset(assetId);
        if (!record?.blob) throw new Error('AI 输入图片资源已失效。');
        if (verify) await verify(record.blob);
        const copied=await store.putAsset(record.blob,{aiInput:true,visualEditorTaskInput:true,aiInputOrder:order});
        if (!copied || copied===assetId) throw new Error('无法安全隔离 AI 图片输入资源。');
        copies.push(copied);
      }
      return copies;
    } catch (error) {
      await cleanup(store,copies);
      throw error;
    }
  }
  const api=Object.freeze({stage,cleanup});
  globalThis.QuickdrawVisualTransfer=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})();