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
const handoffQueues = new Map();

async function selectedFrame(tabId) {
  if (selectedFrames.has(tabId)) return selectedFrames.get(tabId);
  if (chrome.extension.inIncognitoContext) return undefined;
  const key = `cd:selection:${tabId}`;
  const frameId = (await chrome.storage.session.get(key))[key];
  if (Number.isInteger(frameId)) selectedFrames.set(tabId, frameId);
  return frameId;
}
async function reserveFrame(tabId, frameId, privateSession = chrome.extension.inIncognitoContext) {
  selectedFrames.set(tabId, frameId);
  if (!privateSession) await chrome.storage.session.set({ [`cd:selection:${tabId}`]: frameId });
}
function releaseFrame(tabId) {
  selectedFrames.delete(tabId);
  if (chrome.extension.inIncognitoContext) return Promise.resolve();
  return chrome.storage.session.remove(`cd:selection:${tabId}`);
}

function serialized(task) {
  const pending = storageQueue.then(task, task);
  storageQueue = pending.catch(() => {});
  return pending;
}
function serializedHandoff(tabId, task) {
  const pending = (handoffQueues.get(tabId) || Promise.resolve()).then(task, task);
  handoffQueues.set(tabId, pending);
  return pending.finally(() => {
    if (handoffQueues.get(tabId) === pending) handoffQueues.delete(tabId);
  });
}

async function commitRecord(area, changes, evicted) {
  // Replace evicted values with null in the same batch as the new record and
  // index. Quota is checked against the resulting values, so a rejected write
  // never deletes existing captions just to make room for its replacement.
  const cleared = Object.fromEntries(evicted.map(key => [key, null]));
  await area.set({ ...cleared, ...changes });
  if (evicted.length) {
    // Cleanup is optional: any remaining nulls contain no subtitle data and are
    // absent from the committed index.
    await area.remove(evicted).catch(() => {});
  }
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
function contentSender(sender) {
  if (!Number.isInteger(sender.tab?.id) || sender.tab.id < 0
    || !Number.isInteger(sender.frameId) || sender.frameId < 0
    || typeof sender.url !== 'string' || sender.url.startsWith(chrome.runtime.getURL(''))) {
    throw new Error('This action must come from an active video page.');
  }
}
async function topUrlFor(sender) {
  if (sender.tab?.url) return sender.tab.url;
  const tab = await chrome.tabs.get(sender.tab.id);
  if (tab.url) return tab.url;
  const root = (await framesFor(sender.tab.id)).find(frame => frame.frameId === 0);
  return root?.url || (sender.frameId === 0 ? sender.url : '');
}
async function scopedIdentity(message, sender) {
  contentSender(sender);
  const identity = identityText(message.identity);
  let parts;
  try { parts = JSON.parse(identity); } catch { throw new Error('This video could not be identified. Select it again.'); }
  if (!Array.isArray(parts) || parts.length !== 5 || parts[0] !== 'captiondrop-v1'
    || !parts.slice(1, 4).every(part => typeof part === 'string')
    || !Number.isInteger(parts[4]) || parts[4] < 0) {
    throw new Error('This video could not be identified. Select it again.');
  }
  const topUrl = await topUrlFor(sender);
  if (!topUrl) throw new Error('The top-level video page could not be identified.');
  const expected = Core.videoKey({ pageUrl: sender.url, topUrl, src: parts[3], ordinal: parts[4] });
  if (identity !== expected) throw new Error('The saved video must belong to the current page.');
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
  contentSender(sender);
  if (memoryContext(sender).privateSession) return { ok: true, saved: false, private: true };
  const identity = await scopedIdentity(message, sender);
  const key = await memoryKey(identity, prefix);
  return serialized(async () => {
    const indexKey = `${prefix}index`;
    const values = await area.get([key, indexKey]);
    const old = values[key];
    if (update && !old) return { ok: true, saved: false };
    if (!update) {
      if (typeof message.text !== 'string' || message.text.length > Core.MAX_TEXT_LENGTH) {
        throw new Error('The decoded subtitle text is too large. Choose an SRT file smaller than 2 MiB.');
      }
      Core.parseSrt(message.text);
    }
    const record = {
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
    index.push({ key, bytes, updatedAt: record.updatedAt });
    await commitRecord(area, { [key]: record, [indexKey]: index }, evicted);
    return { ok: true, saved: true };
  });
}
async function restoreRecord(message, sender) {
  const { area, prefix } = memoryContext(sender);
  contentSender(sender);
  if (memoryContext(sender).privateSession) return { ok: true, record: null, private: true };
  return serializedHandoff(sender.tab?.id, async () => {
    const identity = await scopedIdentity(message, sender);
    const key = await memoryKey(identity, prefix);
    return serialized(async () => {
      const tabId = sender.tab?.id;
      const frameId = sender.frameId || 0;
      const reserved = await selectedFrame(tabId);
      if (reserved !== undefined && reserved !== frameId) {
        const frames = await framesFor(tabId);
        if (frames.some(frame => frame.frameId === reserved)) return { ok: true, record: null, retry: true };
        await releaseFrame(tabId);
      }
      const record = (await area.get(key))[key];
      if (!record || typeof record.text !== 'string') return { ok: true, record: null };
      await reserveFrame(tabId, frameId);
      return { ok: true, record: { ...record, style: Core.normalizeStyle(record.style) } };
    });
  });
}
async function forgetRecord(message, sender) {
  const { area, prefix } = memoryContext(sender);
  contentSender(sender);
  if (memoryContext(sender).privateSession) return { ok: true, private: true };
  const identity = await scopedIdentity(message, sender);
  const key = await memoryKey(identity, prefix);
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
async function scanTab(tabId, memoryAvailable = true) {
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
  let autoSites = [];
  if (memoryAvailable) {
    try { autoSites = (await chrome.storage.local.get(AUTO_SITES))[AUTO_SITES] || []; }
    catch { memoryAvailable = false; }
  }
  const pattern = sitePattern(topUrl);
  return { ok: true, videos, blockedOrigins: [...blockedOrigins], topUrl, origin: pattern,
    autoEnabled: autoSites.includes(pattern) && await chrome.permissions.contains({ origins: [pattern] }), incognito: tab.incognito, memoryAvailable };
}
async function loadVideo(message, memoryAvailable = true) {
  return serializedHandoff(message.tabId, async () => {
    const tab = await chrome.tabs.get(message.tabId);
    // Validate before changing the selected player or its current subtitles.
    if (typeof message.text !== 'string' || message.text.length > Core.MAX_TEXT_LENGTH) {
      throw new Error('The decoded subtitle text is too large. Choose an SRT file smaller than 2 MiB.');
    }
    Core.parseSrt(message.text);
    const privateSession = memoryContext({ tab }).privateSession;
    const targetFrame = Number(message.frameId || 0);
    const result = await chrome.tabs.sendMessage(message.tabId, { type: 'CD_LOAD', videoId: message.videoId,
      text: message.text, fileName: message.fileName, remember: !privateSession && memoryAvailable, topUrl: tab.url }, { frameId: targetFrame });
    if (!result?.ok) return result || { ok: false, error: 'The selected video could not load these subtitles.' };
    await reserveFrame(message.tabId, targetFrame, privateSession);
    const frames = await framesFor(message.tabId);
    await Promise.allSettled(frames.filter(frame => frame.frameId !== targetFrame).map(frame =>
      chrome.tabs.sendMessage(message.tabId, { type: 'CD_DISABLE_ALL' }, { frameId: frame.frameId })));
    return result;
  });
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
async function openPicker(message, sender) {
  if (!Number.isInteger(sender.tab?.id) || sender.tab.id < 0
    || !Number.isInteger(sender.frameId) || sender.frameId < 0
    || typeof message.videoId !== 'string' || !/^cd-video-\d+$/.test(message.videoId)) {
    throw new Error('Select a video from CaptionDrop to choose a subtitle file.');
  }
  const query = new URLSearchParams({
    tabId: String(sender.tab.id), frameId: String(sender.frameId), videoId: message.videoId
  });
  await chrome.windows.create({
    url: `${chrome.runtime.getURL('popup.html')}?${query}`,
    type: 'popup', width: 400, height: 620, incognito: Boolean(sender.tab.incognito)
  });
  return { ok: true };
}
async function initializeStorage() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const session = await chrome.storage.session.get(null);
  const oldPrivateKeys = Object.keys(session).filter(key => key.startsWith('cd:private:'));
  if (oldPrivateKeys.length) await chrome.storage.session.remove(oldPrivateKeys);
  // Only the regular worker owns persistent caption migration. Split workers
  // share local storage, so a private startup must never rewrite its snapshot.
  if (chrome.extension.inIncognitoContext) return;

  const stored = await chrome.storage.local.get(null);
  const privateLocalKeys = Object.keys(stored).filter(key => key.startsWith('cd:private:'));
  const recordKeys = Object.keys(stored).filter(key => /^cd:caption:[a-f0-9]{64}$/.test(key));
  if (!privateLocalKeys.length && !recordKeys.some(key => stored[key] && Object.hasOwn(stored[key], 'identity'))) return;

  const records = new Map();
  for (const oldKey of recordKeys) {
    const old = stored[oldKey];
    if (!old || typeof old.text !== 'string') continue;
    let key = oldKey;
    if (typeof old.identity === 'string') {
      try {
        const parts = JSON.parse(old.identity);
        if (Array.isArray(parts) && parts.length === 5 && parts[0] === 'captiondrop-v1'
          && /^(?:youtube|bilibili):/.test(parts[2]) && parts[4] !== 0
          && oldKey === `cd:caption:${await Core.hashKey(old.identity)}`) {
          parts[4] = 0;
          key = `cd:caption:${await Core.hashKey(JSON.stringify(parts))}`;
        }
      } catch { /* Keep captions addressable even if old identity metadata was damaged. */ }
    }
    const record = {
      text: old.text, fileName: String(old.fileName || 'Subtitles.srt').slice(0, 160),
      style: Core.normalizeStyle(old.style), enabled: old.enabled !== false,
      updatedAt: Number.isFinite(old.updatedAt) ? old.updatedAt : 0
    };
    const existing = records.get(key);
    if (!existing || record.updatedAt > existing.updatedAt || (record.updatedAt === existing.updatedAt && oldKey === key)) records.set(key, record);
  }
  const retained = [...records].sort((left, right) => left[1].updatedAt - right[1].updatedAt);
  let bytes = retained.reduce((sum, [, record]) => sum + new TextEncoder().encode(JSON.stringify(record)).byteLength, 0);
  while (retained.length && (retained.length > MAX_RECORDS || bytes > MEMORY_BUDGET)) {
    bytes -= new TextEncoder().encode(JSON.stringify(retained.shift()[1])).byteLength;
  }
  const discarded = [...new Set([...recordKeys, ...privateLocalKeys])];
  const changes = Object.fromEntries(discarded.map(key => [key, null]));
  const index = [];
  for (const [key, record] of retained) {
    changes[key] = record;
    index.push({ key, bytes: new TextEncoder().encode(JSON.stringify(record)).byteLength, updatedAt: record.updatedAt });
  }
  changes['cd:index'] = index;
  await chrome.storage.local.set(changes);
  const removed = discarded.filter(key => !records.has(key) || !retained.some(([kept]) => kept === key));
  if (removed.length) await chrome.storage.local.remove(removed).catch(() => {});
}

async function onPageNavigation(sender) {
  contentSender(sender);
  const tabId = sender.tab.id;
  const tab = await chrome.tabs.get(tabId);
  const frames = await framesFor(tabId);
  await serializedHandoff(tabId, async () => {
    const reserved = await selectedFrame(tabId);
    if (sender.frameId === 0 || reserved === sender.frameId
      || (reserved !== undefined && !frames.some(frame => frame.frameId === reserved))) await releaseFrame(tabId);
  });
  await Promise.allSettled(frames.map(frame => chrome.tabs.sendMessage(tabId,
    { type: 'CD_CHECK_RESTORE', topUrl: tab.url || sender.tab.url || frames.find(frame => frame.frameId === 0)?.url }, { frameId: frame.frameId })));
  return { ok: true };
}

let storageReady;
let lastStorageError;
function ensureStorage() {
  if (!storageReady) {
    const pending = initializeStorage().then(() => { lastStorageError = null; return true; }, error => { lastStorageError = error; return false; });
    storageReady = pending;
    void pending.then(ready => { if (!ready && storageReady === pending) storageReady = undefined; });
  }
  return storageReady;
}
void ensureStorage();
async function handle(message, sender) {
  let memoryAvailable = await ensureStorage();
  const recordAction = ['CD_SAVE', 'CD_UPDATE', 'CD_RESTORE', 'CD_FORGET'].includes(message.type);
  if (!memoryAvailable && ((recordAction && !memoryContext(sender).privateSession)
    || ['CD_ENABLE_AUTO', 'CD_SYNC_SITES'].includes(message.type))) {
    throw new Error(`Saved captions are unavailable: ${lastStorageError?.message || 'Browser storage could not be prepared.'}`);
  }
  switch (message.type) {
    case 'CD_SCAN': return scanTab(message.tabId, memoryAvailable);
    case 'CD_LOAD_VIDEO': return loadVideo(message, memoryAvailable);
    case 'CD_ENABLE_AUTO': return enableAuto(message);
    case 'CD_SYNC_SITES': await syncSites(); return { ok: true };
    case 'CD_OPEN_PICKER': return openPicker(message, sender);
    case 'CD_NAVIGATED': return onPageNavigation(sender);
    case 'CD_CONTEXT': {
      const tab = sender.tab;
      const topUrl = Number.isInteger(tab?.id) ? await topUrlFor(sender) : sender.url || '';
      const pattern = sitePattern(topUrl);
      let sites = [];
      if (memoryAvailable) {
        try { sites = (await chrome.storage.local.get(AUTO_SITES))[AUTO_SITES] || []; }
        catch { memoryAvailable = false; }
      }
      if (Number.isInteger(tab?.id) && sender.frameId === 0) await releaseFrame(tab.id);
      const incognito = memoryContext(sender).privateSession;
      return { ok: true, topUrl, incognito, memoryAvailable, autoEnabled: !incognito && memoryAvailable && Boolean(pattern)
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
chrome.runtime.onInstalled.addListener(() => { void ensureStorage().then(ready => ready && syncSites()).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { void ensureStorage().then(ready => ready && syncSites()).catch(() => {}); });
chrome.permissions.onRemoved.addListener(() => { void ensureStorage().then(ready => ready && syncSites()).catch(() => {}); });
chrome.tabs.onRemoved.addListener(tabId => { void releaseFrame(tabId).catch(() => {}); });
