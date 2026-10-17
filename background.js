/* CaptionDrop's event-driven coordinator. No remote requests or continuous tasks. */
importScripts('core.js');
'use strict';
const Core = globalThis.CaptionDropCore;
const MEMORY_BUDGET = 8 * 1024 * 1024;
const MAX_RECORDS = 50;
const AUTO_SITES = 'cd:auto-sites';
const selectedFrames = new Map();
let storageQueue = Promise.resolve();
let registrationQueue = Promise.resolve();

async function selectedFrame(tabId) {
  if (selectedFrames.has(tabId)) return selectedFrames.get(tabId);
  const key = `cd:selection:${tabId}`;
  const frameId = (await chrome.storage.session.get(key))[key];
  if (Number.isInteger(frameId)) selectedFrames.set(tabId, frameId);
  return frameId;
}
async function reserveFrame(tabId, frameId) {
  selectedFrames.set(tabId, frameId);
  await chrome.storage.session.set({ [`cd:selection:${tabId}`]: frameId });
}
function releaseFrame(tabId) {
  selectedFrames.delete(tabId);
  return chrome.storage.session.remove(`cd:selection:${tabId}`);
}

function serialized(task) {
  const pending = storageQueue.then(task, task);
  storageQueue = pending.catch(() => {});
  return pending;
}
function sitePattern(url) {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? `${parsed.protocol}//${parsed.hostname}/*` : null;
  } catch { return null; }
}
function identityText(identity) {
  if (typeof identity !== 'string' || identity.length > 16000 || !identity.startsWith('[')) {
    throw new Error('This video could not be identified. Select it again.');
  }
  return identity;
}
function memoryContext(sender) {
  const privateSession = Boolean(sender.tab?.incognito || chrome.extension.inIncognitoContext);
  return { area: privateSession ? chrome.storage.session : chrome.storage.local,
    prefix: privateSession ? 'cd:private:' : 'cd:', privateSession };
}
async function memoryKey(identity, prefix) {
  return `${prefix}caption:${await Core.hashKey(identityText(identity))}`;
}
async function saveRecord(message, sender, update = false) {
  const { area, prefix } = memoryContext(sender);
  const key = await memoryKey(message.identity, prefix);
  return serialized(async () => {
    const indexKey = `${prefix}index`;
    const values = await area.get([key, indexKey]);
    const old = values[key];
    if (update && !old) return { ok: true, saved: false };
    if (!update) {
      if (typeof message.text !== 'string' || new TextEncoder().encode(message.text).byteLength > Core.MAX_FILE_BYTES) {
        throw new Error('Choose an SRT file smaller than 2 MiB.');
      }
      Core.parseSrt(message.text);
    }
    const record = {
      identity: message.identity,
      text: update ? old.text : message.text,
      fileName: String(update ? old.fileName : message.fileName || 'Subtitles.srt').slice(0, 160),
      style: Core.normalizeStyle(message.style || old?.style),
      enabled: message.enabled !== false,
      updatedAt: Date.now()
    };
    const bytes = new TextEncoder().encode(JSON.stringify(record)).byteLength;
    let index = (Array.isArray(values[indexKey]) ? values[indexKey] : []).filter(item => item.key !== key);
    const evicted = [];
    while (index.length && (index.length >= MAX_RECORDS || index.reduce((sum, item) => sum + item.bytes, 0) + bytes > MEMORY_BUDGET)) {
      evicted.push(index.shift().key);
    }
    if (bytes > MEMORY_BUDGET) throw new Error('The subtitle is too large to remember.');
    if (evicted.length) await area.remove(evicted);
    index.push({ key, bytes, updatedAt: record.updatedAt });
    await area.set({ [key]: record, [indexKey]: index });
    return { ok: true, saved: true };
  });
}
async function restoreRecord(message, sender) {
  const { area, prefix } = memoryContext(sender);
  const key = await memoryKey(message.identity, prefix);
  return serialized(async () => {
    const tabId = sender.tab?.id;
    const frameId = sender.frameId || 0;
    const reserved = await selectedFrame(tabId);
    if (reserved !== undefined && reserved !== frameId) return { ok: true, record: null };
    const record = (await area.get(key))[key];
    if (!record || record.identity !== message.identity || typeof record.text !== 'string') return { ok: true, record: null };
    await reserveFrame(tabId, frameId);
    return { ok: true, record: { ...record, style: Core.normalizeStyle(record.style) } };
  });
}
async function forgetRecord(message, sender) {
  const { area, prefix } = memoryContext(sender);
  const key = await memoryKey(message.identity, prefix);
  return serialized(async () => {
    const indexKey = `${prefix}index`;
    const values = await area.get(indexKey);
    await area.remove(key);
    await area.set({ [indexKey]: (values[indexKey] || []).filter(item => item.key !== key) });
    return { ok: true };
  });
}
async function framesFor(tabId) {
  return (await chrome.webNavigation.getAllFrames({ tabId })) || [];
}
async function injectFrame(tabId, frameId) {
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['core.js', 'content.js'] });
}
async function scanTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const frames = await framesFor(tabId);
  const topUrl = tab.url || frames.find(frame => frame.frameId === 0)?.url || '';
  if (!sitePattern(topUrl)) throw new Error('Open a video on a normal website, then click CaptionDrop. Chrome restricts extensions on this page.');
  const targets = frames.length ? frames : [{ frameId: 0, url: topUrl }];
  const scanned = await Promise.allSettled(targets.map(async frame => {
    if (!/^https?:/.test(frame.url) && frame.frameId !== 0) return { videos: [] };
    await injectFrame(tabId, frame.frameId);
    const result = await chrome.tabs.sendMessage(tabId, { type: 'CD_LIST', topUrl }, { frameId: frame.frameId });
    return { videos: (result.videos || []).map(video => ({ ...video, frameId: frame.frameId, frameUrl: frame.url })) };
  }));
  const videos = [];
  const blockedOrigins = new Set();
  scanned.forEach((result, i) => {
    if (result.status === 'fulfilled') videos.push(...result.value.videos);
    else if (sitePattern(targets[i].url)) blockedOrigins.add(sitePattern(targets[i].url));
  });
  const autoSites = (await chrome.storage.local.get(AUTO_SITES))[AUTO_SITES] || [];
  const pattern = sitePattern(topUrl);
  return { ok: true, videos, blockedOrigins: [...blockedOrigins], topUrl, origin: pattern,
    autoEnabled: autoSites.includes(pattern) && await chrome.permissions.contains({ origins: [pattern] }), incognito: tab.incognito };
}
async function loadVideo(message) {
  const tab = await chrome.tabs.get(message.tabId);
  // Validate before changing the selected player or its current subtitles.
  if (typeof message.text !== 'string' || new TextEncoder().encode(message.text).byteLength > Core.MAX_FILE_BYTES) {
    throw new Error('Choose an SRT file smaller than 2 MiB.');
  }
  Core.parseSrt(message.text);
  const targetFrame = Number(message.frameId || 0);
  const frames = await framesFor(message.tabId);
  await Promise.allSettled(frames.filter(frame => frame.frameId !== targetFrame).map(frame =>
    chrome.tabs.sendMessage(message.tabId, { type: 'CD_DISABLE_ALL' }, { frameId: frame.frameId })));
  await reserveFrame(message.tabId, targetFrame);
  return chrome.tabs.sendMessage(message.tabId, { type: 'CD_LOAD', videoId: message.videoId,
    text: message.text, fileName: message.fileName, remember: true, topUrl: tab.url }, { frameId: targetFrame });
}
function syncSites() {
  const task = async () => {
    const saved = (await chrome.storage.local.get(AUTO_SITES))[AUTO_SITES] || [];
    const allowed = [];
    for (const origin of saved) {
      if (await chrome.permissions.contains({ origins: [origin] })) allowed.push(origin);
    }
    const wanted = new Map();
    for (const origin of allowed) {
      wanted.set(`cd-${(await Core.hashKey(origin)).slice(0, 24)}`, origin);
    }
    const registered = await chrome.scripting.getRegisteredContentScripts();
    const stale = registered.filter(item => item.id.startsWith('cd-') && !wanted.has(item.id)).map(item => item.id);
    if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
    const existing = new Set(registered.map(item => item.id));
    const additions = [...wanted].filter(([id]) => !existing.has(id)).map(([id, origin]) => ({
      id, matches: [origin], js: ['core.js', 'content.js'], allFrames: true,
      matchOriginAsFallback: true, persistAcrossSessions: true, runAt: 'document_idle'
    }));
    if (additions.length) await chrome.scripting.registerContentScripts(additions);
  };
  const pending = registrationQueue.then(task, task);
  registrationQueue = pending.catch(() => {});
  return pending;
}
async function enableAuto(message) {
  const origins = [...new Set((message.origins || []).filter(origin => sitePattern(origin) === origin))];
  if (!origins.length) throw new Error('This website cannot use automatic loading.');
  for (const origin of origins) {
    if (!await chrome.permissions.contains({ origins: [origin] })) throw new Error('Allow site access to enable automatic loading.');
  }
  await serialized(async () => {
    const stored = (await chrome.storage.local.get(AUTO_SITES))[AUTO_SITES] || [];
    await chrome.storage.local.set({ [AUTO_SITES]: [...new Set([...stored, ...origins])] });
  });
  await syncSites();
  return { ok: true };
}
async function handle(message, sender) {
  switch (message.type) {
    case 'CD_SCAN': return scanTab(message.tabId);
    case 'CD_LOAD_VIDEO': return loadVideo(message);
    case 'CD_ENABLE_AUTO': return enableAuto(message);
    case 'CD_SYNC_SITES': await syncSites(); return { ok: true };
    case 'CD_CONTEXT': {
      const tab = sender.tab;
      const topUrl = tab?.url || sender.url || '';
      const pattern = sitePattern(topUrl);
      const sites = (await chrome.storage.local.get(AUTO_SITES))[AUTO_SITES] || [];
      return { ok: true, topUrl, incognito: Boolean(tab?.incognito), autoEnabled: Boolean(pattern)
        && sites.includes(pattern) && await chrome.permissions.contains({ origins: [pattern] }) };
    }
    case 'CD_SAVE': return saveRecord(message, sender);
    case 'CD_UPDATE': return saveRecord(message, sender, true);
    case 'CD_RESTORE': return restoreRecord(message, sender);
    case 'CD_FORGET': return forgetRecord(message, sender);
    default: return { ok: false, error: 'Unknown CaptionDrop action.' };
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !message?.type?.startsWith('CD_')) return;
  if (['CD_SCAN', 'CD_LOAD_VIDEO', 'CD_ENABLE_AUTO', 'CD_SYNC_SITES'].includes(message.type)
    && !sender.url?.startsWith(chrome.runtime.getURL(''))) {
    respond({ ok: false, error: 'Open CaptionDrop from the browser toolbar to use this action.' });
    return;
  }
  handle(message, sender).then(respond).catch(error => respond({ ok: false, error: error.message || 'CaptionDrop could not complete this action.' }));
  return true;
});
chrome.runtime.onInstalled.addListener(() => { void syncSites().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { void syncSites().catch(() => {}); });
chrome.permissions.onRemoved.addListener(() => { void syncSites().catch(() => {}); });
chrome.tabs.onRemoved.addListener(tabId => { void releaseFrame(tabId).catch(() => {}); });
chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId === 0) void releaseFrame(details.tabId).catch(() => {});
});
async function onSiteNavigation(details) {
  if (details.frameId !== 0) return;
  await releaseFrame(details.tabId);
  const frames = await framesFor(details.tabId);
  await Promise.allSettled(frames.map(frame => chrome.tabs.sendMessage(details.tabId,
    { type: 'CD_CHECK_RESTORE', topUrl: details.url }, { frameId: frame.frameId })));
}
chrome.webNavigation.onHistoryStateUpdated.addListener(details => { void onSiteNavigation(details).catch(() => {}); });
chrome.webNavigation.onReferenceFragmentUpdated.addListener(details => { void onSiteNavigation(details).catch(() => {}); });
chrome.windows.onRemoved.addListener(async () => {
  const windows = await chrome.windows.getAll();
  if (windows.some(window => window.incognito)) return;
  const values = await chrome.storage.session.get(null);
  const privateKeys = Object.keys(values).filter(key => key.startsWith('cd:private:'));
  if (privateKeys.length) await chrome.storage.session.remove(privateKeys);
});
