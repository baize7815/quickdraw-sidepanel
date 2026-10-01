(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.QDCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const clone = value => JSON.parse(JSON.stringify(value));

  function newId(prefix = 'e') {
    return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
  }

  function pointSegmentDistance(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (!lengthSquared) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function buildElementPatch(before, after) {
    const beforeById = new Map((before || []).map(item => [item.id, item]));
    const afterById = new Map((after || []).map(item => [item.id, item]));
    const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
    const changes = [];
    for (const id of ids) {
      const previous = beforeById.get(id) || null;
      const next = afterById.get(id) || null;
      if (JSON.stringify(previous) !== JSON.stringify(next)) {
        changes.push({ id, before: previous ? clone(previous) : null, after: next ? clone(next) : null });
      }
    }
    const beforeOrder = (before || []).map(item => item.id);
    const afterOrder = (after || []).map(item => item.id);
    if (!changes.length && JSON.stringify(beforeOrder) === JSON.stringify(afterOrder)) return null;
    return { changes, beforeOrder, afterOrder };
  }

  function applyElementPatch(current, patch, direction) {
    const useBefore = direction === 'undo';
    const items = new Map((current || []).map(item => [item.id, clone(item)]));
    for (const change of patch.changes || []) {
      const value = useBefore ? change.before : change.after;
      if (value) items.set(change.id, clone(value));
      else items.delete(change.id);
    }
    const order = useBefore ? patch.beforeOrder : patch.afterOrder;
    const result = [];
    for (const id of order || []) {
      if (items.has(id)) {
        result.push(items.get(id));
        items.delete(id);
      }
    }
    result.push(...items.values());
    return result;
  }

  function hashString(value) {
    let hash = 2166136261;
    const text = String(value);
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function safeFilename(value, fallback = 'Quickdraw') {
    const text = String(value || fallback).replace(/[\\/:*?"<>|]/g, '_').trim();
    return text || fallback;
  }

  return { clone, newId, pointSegmentDistance, buildElementPatch, applyElementPatch, hashString, safeFilename };
});
