/* CaptionDrop's event-driven coordinator. No remote requests or continuous tasks. */
importScripts('core.js');
'use strict';
const Core = globalThis.CaptionDropCore;
const MEMORY_BUDGET = 8 * 1024 * 1024;
const MAX_RECORDS = 50;
const AUTO_SITES = 'cd:auto-sites';
const STORAGE_VERSION = 'cd:storage-version';
const STORAGE_SCHEMA = 3;
const encoder = new TextEncoder();
const selectedFrames = new Map();
const selectedDocuments = new Map();
let storageQueue = Promise.resolve();
let registrationQueue = Promise.resolve();
const handoffQueues = new Map();
const pickerWindows = new Map();
const pickerRequests = new Map();
const navigationBroadcasts = new Map();

async function selectedFrame(tabId) {
  if (selectedFrames.has(tabId)) return selectedFrames.get(tabId);
  if (chrome.extension.inIncognitoContext) return undefined;
  const key = `cd:selection:${tabId}`;
  const frameId = (await chrome.storage.session.get(key))[key];
  if (Number.isInteger(frameId)) selectedFrames.set(tabId, frameId);
  return frameId;
}
async function reserveFrame(tabId, frameId, privateSession = chrome.extension.inIncognitoContext, documentId) {
  selectedFrames.set(tabId, frameId);
  selectedDocuments.set(tabId, documentId);
  if (!privateSession) await chrome.storage.session.set({ [`cd:selection:${tabId}`]: frameId, [`cd:selection-document:${tabId}`]: documentId || null });
}
async function reservedDocument(tabId) {
  if (selectedDocuments.has(tabId) || chrome.extension.inIncognitoContext) return selectedDocuments.get(tabId);
  const key = `cd:selection-document:${tabId}`;
  return (await chrome.storage.session.get(key))[key] || undefined;
}
async function activeFrame(tabId, frameId, documentId) {
  let frame;
  try { frame = await chrome.webNavigation.getFrame({ tabId, frameId, ...(documentId ? { documentId } : {}) }); } catch {}
  if (!frame?.documentId || !frame.url || frame.documentLifecycle !== 'active'
    || documentId && frame.documentId !== documentId) {
    throw new Error('This video page is no longer active. Scan again and select a video.');
  }
  return frame;
}
function releaseFrame(tabId) {
  selectedFrames.delete(tabId);
  selectedDocuments.delete(tabId);
  if (chrome.extension.inIncognitoContext) return Promise.resolve();
  return chrome.storage.session.remove([`cd:selection:${tabId}`, `cd:selection-document:${tabId}`]);
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
function settingsKey(key) { return key.replace(':caption:', ':settings:'); }
function recordKeys(key) { return [key, settingsKey(key)]; }
function storageBytes(key, value) {
  // Chromium escapes HTML openers/separators and uses scientific notation
  // sooner than JavaScript (notably for millisecond timestamps).
  let numberAdjustment = 0;
  const json = JSON.stringify(value, (_name, item) => {
    if (typeof item === 'number' && Number.isFinite(item)
      && !(Number.isInteger(item) && item >= -2147483648 && item <= 2147483647)) {
      const magnitude = Math.abs(item);
      let encoded = magnitude >= 1e12 || magnitude > 0 && magnitude < 1e-6 ? item.toExponential() : String(item);
      if (!/[.e]/.test(encoded)) encoded += '.0';
      numberAdjustment += encoded.length - String(item).length;
    }
    return item;
  }).replace(/[<\u2028\u2029]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return encoder.encode(key).byteLength + encoder.encode(json).byteLength + numberAdjustment;
}
function indexBytes(indexKey, index) {
  return storageBytes(indexKey, index) + index.reduce((sum, item) => sum + item.bytes + (item.settingsBytes || 0), 0);
}
function validScope(scope) { return typeof scope === 'string' && /^[0-9a-f]{64}$/.test(scope); }
function validIndex(index, prefix) {
  if (!Array.isArray(index)) return false;
  const pattern = new RegExp(`^${prefix}caption:[0-9a-f]{64}$`);
  const keys = new Set();
  for (const item of index) {
    if (!item || typeof item.key !== 'string' || !pattern.test(item.key) || keys.has(item.key)
      || !Number.isFinite(item.bytes) || item.bytes <= 0 || item.bytes > MEMORY_BUDGET
      || item.settingsBytes !== undefined && !(Number.isFinite(item.settingsBytes) && item.settingsBytes >= 0)
      || item.scope !== undefined && !validScope(item.scope)) return false;
    keys.add(item.key);
  }
  return true;
}
async function readIndex(area, prefix) {
  const indexKey = `${prefix}index`;
  const index = (await area.get(indexKey))[indexKey];
  return validIndex(index, prefix) ? index : repairIndex(area, prefix, index);
}
async function repairIndex(area, prefix, damaged) {
  // Rebuild a damaged index from the records themselves. Records it no longer
  // lists stay restorable instead of becoming unreachable on the next save.
  const indexKey = `${prefix}index`;
  const keys = await area.getKeys();
  const recordPattern = new RegExp(`^${prefix}caption:[0-9a-f]{64}$`);
  const records = keys.filter(key => recordPattern.test(key));
  const values = records.length ? await area.get([...records, ...records.map(settingsKey)]) : {};
  const order = (Array.isArray(damaged) ? damaged : []).map(item => item?.key);
  const garbage = keys.filter(key => key.startsWith(`${prefix}settings:`) && !records.includes(key.replace(':settings:', ':caption:')));
  const index = [];
  for (const key of records) {
    const record = values[key];
    if (!record || typeof record.text !== 'string') { garbage.push(...recordKeys(key)); continue; }
    const settings = values[settingsKey(key)];
    index.push({ key, bytes: storageBytes(key, record), ...(settings ? { settingsBytes: storageBytes(settingsKey(key), settings) } : {}),
      ...(validScope(record.scope) ? { scope: record.scope } : {}),
      updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : 0 });
  }
  // Keep the surviving least-recently-used order; records it lost sort by age first.
  const rank = item => order.includes(item.key) ? order.indexOf(item.key) : -1;
  index.sort((left, right) => rank(left) - rank(right) || left.updatedAt - right.updatedAt);
  // Repair cannot authorize cross-site eviction. Preserve readable records;
  // subsequent saves enforce the limits using only their own site's entries.
  await area.set({ ...Object.fromEntries(garbage.map(key => [key, null])), [indexKey]: index });
  if (garbage.length) await area.remove(garbage).catch(() => {});
  return index;
}
async function strayKeys(area, prefix, index, scope) {
  // Records missing from a valid index can never be restored. Under quota
  // pressure only the saving site's strays may be cleared. Unknown legacy
  // ownership is protected just like another site's captions.
  if (!validScope(scope)) return [];
  const listed = new Set(index.map(item => item.key));
  const keys = (await area.getKeys()).filter(key => key.startsWith(`${prefix}caption:`) && !listed.has(key));
  const records = keys.length ? await area.get(keys) : {};
  return keys.filter(key => records[key]?.scope === scope).flatMap(recordKeys);
}
async function commitIndexed(area, indexKey, index, changes, evicted, protectedKey, scope) {
  const full = () => new Error('Caption memory is full. Forget a saved subtitle and try again. Captions remain loaded for this visit.');
  const evict = () => {
    const position = index.findIndex(item => item.key !== protectedKey && validScope(scope) && item.scope === scope);
    if (position < 0) return false;
    evicted.push(...recordKeys(index.splice(position, 1)[0].key));
    return true;
  };
  while (index.length > MAX_RECORDS || indexBytes(indexKey, index) > MEMORY_BUDGET) {
    if (!evict()) throw full();
  }
  let straysCleared = false;
  for (;;) {
    try {
      await commitRecord(area, { ...changes, [indexKey]: index }, evicted);
      return;
    } catch (error) {
      if (!/quota/i.test(error.message || '')) throw error;
      if (!straysCleared) {
        straysCleared = true;
        const stray = (await strayKeys(area, indexKey.slice(0, -'index'.length), index, scope))
          .filter(key => !Object.hasOwn(changes, key) && !evicted.includes(key));
        if (stray.length) { evicted.push(...stray); continue; }
      }
      // Each retry atomically clears another old entry. Failed writes preserve
      // both the previous captions and index, including failed replacements.
      if (!evict()) throw full();
    }
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
  const tab = await chrome.tabs.get(sender.tab.id);
  if (tab.url) return tab.url;
  const root = (await framesFor(sender.tab.id)).find(frame => frame.frameId === 0);
  return root?.url || (sender.frameId === 0 ? sender.url : '');
}
async function scopedPage(sender) {
  contentSender(sender);
  if (!sender.documentId) {
    throw new Error('This video page is no longer active. Scan again and select a video.');
  }
  const frame = await activeFrame(sender.tab.id, sender.frameId, sender.documentId);
  const topUrl = sender.frameId === 0 ? frame.url : await topUrlFor(sender);
  if (!topUrl) throw new Error('The top-level video page could not be identified.');
  return { frame, topUrl };
}
async function evictionScope({ frame, topUrl }) {
  const origins = [new URL(topUrl).origin, new URL(frame.url).origin];
  if (origins.includes('null')) throw new Error('This video page could not be identified.');
  // Neither media URLs nor message fields confer eviction rights. Include both
  // origins so an embedded player cannot clear its host's or another host's data.
  return Core.hashKey(JSON.stringify(origins));
}
async function scopedIdentity(message, sender, page) {
  contentSender(sender);
  const identity = identityText(message.identity);
  let parts;
  try { parts = JSON.parse(identity); } catch { throw new Error('This video could not be identified. Select it again.'); }
  if (!Array.isArray(parts) || parts.length !== 5 || parts[0] !== 'captiondrop-v1'
    || !parts.slice(1, 4).every(part => typeof part === 'string')
    || !Number.isInteger(parts[4]) || parts[4] < 0) {
    throw new Error('This video could not be identified. Select it again.');
  }
  const { frame, topUrl } = page || await scopedPage(sender);
  const expected = Core.videoKey({ pageUrl: frame.url, topUrl, src: parts[3], ordinal: parts[4] });
  if (identity === expected) return expected;
  // Embedded frames name their top-level page by token. Storage keys always
  // use the full identity, so both forms address the same saved captions.
  if (sender.frameId !== 0) {
    const topToken = page?.topToken || await Core.topToken(topUrl);
    if (identity === Core.videoKey({ pageUrl: frame.url, topToken, src: parts[3], ordinal: parts[4] })) return expected;
  }
  throw new Error('The saved video must belong to the current page.');
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
  const page = await scopedPage(sender);
  const identity = await scopedIdentity(message, sender, page);
  const scope = await evictionScope(page);
  const key = await memoryKey(identity, prefix);
  return serialized(async () => {
    const indexKey = `${prefix}index`;
    let index = await readIndex(area, prefix);
    const old = index.find(item => item.key === key);
    if (update && !old) return { ok: true, saved: false };
    const settings = settingsKey(key);
    if (update) {
      const previous = (await area.get(settings))[settings];
      const record = { style: Core.normalizeStyle(message.style || previous?.style), enabled: message.enabled !== false, updatedAt: Date.now() };
      index = index.filter(item => item.key !== key);
      index.push({ ...old, settingsBytes: storageBytes(settings, record), updatedAt: record.updatedAt });
      await commitIndexed(area, indexKey, index, { [settings]: record }, [], key, scope);
      return { ok: true, saved: true };
    }
    if (typeof message.text !== 'string' || message.text.length > Core.MAX_TEXT_LENGTH) {
      throw new Error('The decoded subtitle text is too large. Choose an SRT file smaller than 2 MiB.');
    }
    Core.parseSrt(message.text);
    const record = {
      scope,
      text: message.text,
      fileName: String(message.fileName || 'Subtitles.srt').slice(0, 160),
      style: Core.normalizeStyle(message.style),
      enabled: message.enabled !== false,
      updatedAt: Date.now()
    };
    const bytes = storageBytes(key, record);
    const appearance = { style: record.style, enabled: record.enabled, updatedAt: record.updatedAt };
    index = index.filter(item => item.key !== key);
    if (bytes > MEMORY_BUDGET) throw new Error('The subtitle is too large to remember.');
    index.push({ key, scope, bytes, settingsBytes: storageBytes(settings, appearance), updatedAt: record.updatedAt });
    await commitIndexed(area, indexKey, index, { [key]: record, [settings]: appearance }, [], key, scope);
    return { ok: true, saved: true };
  });
}
async function restoreRecords(message, sender) {
  const { area, prefix } = memoryContext(sender);
  contentSender(sender);
  if (memoryContext(sender).privateSession) return { ok: true, record: null, private: true };
  const identities = message.identities;
  if (!Array.isArray(identities) || !identities.length || identities.length > 256
    || identities.some(identity => typeof identity !== 'string')
    || identities.reduce((sum, identity) => sum + identity.length, 0) > Core.MAX_TEXT_LENGTH) {
    throw new Error('The video selection is too large. Select a video manually.');
  }
  return serializedHandoff(sender.tab.id, async () => {
    const page = await scopedPage(sender);
    page.topToken = sender.frameId === 0 ? '' : await Core.topToken(page.topUrl);
    const scoped = await Promise.all(identities.map(identity => scopedIdentity({ identity }, sender, page)));
    const keys = await Promise.all(scoped.map(identity => memoryKey(identity, prefix)));
    return serialized(async () => {
      const tabId = sender.tab?.id;
      const frameId = sender.frameId || 0;
      const reserved = await selectedFrame(tabId);
      if (reserved !== undefined && reserved !== frameId) {
        const frames = await framesFor(tabId);
        const owner = frames.find(frame => frame.frameId === reserved);
        const ownerDocument = await reservedDocument(tabId);
        if (owner && ownerDocument && (!owner.documentId || owner.documentId === ownerDocument)) return { ok: true, record: null, retry: true };
        await releaseFrame(tabId);
      }
      const index = await readIndex(area, prefix);
      const savedKeys = new Set(index.map(item => item.key));
      for (let position = 0; position < keys.length; position++) {
        const key = keys[position];
        if (!savedKeys.has(key)) continue;
        const values = await area.get(recordKeys(key));
        const record = values[key];
        if (!record || typeof record.text !== 'string') continue;
        await reserveFrame(tabId, frameId, undefined, sender.documentId);
        const settings = values[settingsKey(key)];
        const restored = { ...record, ...settings, style: Core.normalizeStyle(settings?.style || record.style) };
        delete restored.scope;
        return { ok: true, identity: identities[position], record: restored };
      }
      return { ok: true, record: null, empty: !index.length };
    });
  });
}
async function restoreRecord(message, sender) {
  const { identity, empty, ...result } = await restoreRecords({ identities: [message.identity] }, sender);
  return result;
}
async function forgetRecord(message, sender) {
  const { area, prefix } = memoryContext(sender);
  contentSender(sender);
  if (memoryContext(sender).privateSession) return { ok: true, private: true };
  const identity = await scopedIdentity(message, sender);
  const key = await memoryKey(identity, prefix);
  return serialized(async () => {
    const indexKey = `${prefix}index`;
    const index = await readIndex(area, prefix);
    await area.remove(recordKeys(key));
    await area.set({ [indexKey]: index.filter(item => item.key !== key) });
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
  const topToken = await Core.topToken(topUrl);
  const scanned = await Promise.allSettled(targets.map(async frame => {
    if (!/^https?:/.test(frame.url) && frame.frameId !== 0) return { videos: [] };
    await injectFrame(tabId, frame.frameId);
    const result = await chrome.tabs.sendMessage(tabId, { type: 'CD_LIST', topToken }, { frameId: frame.frameId });
    return { videos: (result.videos || []).map(video => ({ ...video, documentId: frame.documentId, frameId: frame.frameId, frameUrl: frame.url })) };
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
    autoEnabled: !tab.incognito && !chrome.extension.inIncognitoContext && autoSites.includes(pattern) && await chrome.permissions.contains({ origins: [pattern] }), incognito: tab.incognito || chrome.extension.inIncognitoContext, memoryAvailable };
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
    const frame = await activeFrame(message.tabId, targetFrame, message.documentId);
    const result = await chrome.tabs.sendMessage(message.tabId, { type: 'CD_LOAD', videoId: message.videoId,
      expectedIdentity: message.identity, expectedSource: message.src,
      text: message.text, fileName: message.fileName, remember: !privateSession && memoryAvailable, topToken: await Core.topToken(tab.url) },
    { frameId: targetFrame, documentId: frame.documentId });
    if (!result?.ok) return result || { ok: false, error: 'The selected video could not load these subtitles.' };
    await reserveFrame(message.tabId, targetFrame, privateSession, frame.documentId);
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
async function enableAuto(message, sender = {}) {
  if (memoryContext(sender).privateSession || (Number.isInteger(message.tabId) && (await chrome.tabs.get(message.tabId)).incognito)) {
    throw new Error('Automatic loading is unavailable in private windows.');
  }
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
  // Reuse one picker window and coalesce repeated requests, so a page cannot
  // open window after window without the user.
  const now = performance.now();
  if (now - (pickerRequests.get(sender.tab.id) ?? -Infinity) < 1000) return { ok: true };
  pickerRequests.set(sender.tab.id, now);
  const query = new URLSearchParams({
    tabId: String(sender.tab.id), frameId: String(sender.frameId), videoId: message.videoId
  });
  const url = `${chrome.runtime.getURL('popup.html')}?${query}`;
  const incognito = Boolean(sender.tab.incognito);
  if (pickerWindows.has(incognito)) {
    try {
      const picker = await chrome.windows.get(pickerWindows.get(incognito), { populate: true });
      if (picker.tabs?.[0]) {
        await chrome.tabs.update(picker.tabs[0].id, { url });
        await chrome.windows.update(picker.id, { focused: true });
        return { ok: true };
      }
    } catch { /* The user closed the previous picker. */ }
  }
  const picker = await chrome.windows.create({ url, type: 'popup', width: 400, height: 620, incognito });
  if (Number.isInteger(picker?.id)) pickerWindows.set(incognito, picker.id);
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

  const version = (await chrome.storage.local.get(STORAGE_VERSION))[STORAGE_VERSION];
  if (version === STORAGE_SCHEMA) return;
  // A newer release may store fields that this migration would drop.
  if (Number.isFinite(version) && version > STORAGE_SCHEMA) {
    throw new Error('Saved captions come from a newer CaptionDrop version. Update CaptionDrop to use them.');
  }
  if (version === 2) {
    // Already sanitized; ownership is additive. Keep existing captions and their
    // separate appearance settings intact, with unknown ownership protected.
    await chrome.storage.local.set({ [STORAGE_VERSION]: STORAGE_SCHEMA });
    return;
  }

  const stored = await chrome.storage.local.get(null);
  const privateLocalKeys = Object.keys(stored).filter(key => key.startsWith('cd:private:'));
  const recordKeys = Object.keys(stored).filter(key => /^cd:caption:[a-f0-9]{64}$/.test(key));

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
      ...(validScope(old.scope) ? { scope: old.scope } : {}),
      text: old.text, fileName: String(old.fileName || 'Subtitles.srt').slice(0, 160),
      style: Core.normalizeStyle(old.style), enabled: old.enabled !== false,
      updatedAt: Number.isFinite(old.updatedAt) ? old.updatedAt : 0
    };
    const existing = records.get(key);
    if (!existing || record.updatedAt > existing.updatedAt || (record.updatedAt === existing.updatedAt && oldKey === key)) records.set(key, record);
  }
  const retained = [...records].sort((left, right) => left[1].updatedAt - right[1].updatedAt);
  const appearanceFor = record => ({ style: record.style, enabled: record.enabled, updatedAt: record.updatedAt });
  // Migration has no saving-site authority, so it must not prune readable
  // captions to satisfy a budget. New saves make room only within their scope.
  const discarded = [...new Set([...recordKeys, ...privateLocalKeys])];
  const changes = Object.fromEntries(discarded.map(key => [key, null]));
  const index = [];
  for (const [key, record] of retained) {
    changes[key] = record;
    changes[settingsKey(key)] = appearanceFor(record);
    index.push({ key, ...(validScope(record.scope) ? { scope: record.scope } : {}),
      bytes: storageBytes(key, record), settingsBytes: storageBytes(settingsKey(key), appearanceFor(record)), updatedAt: record.updatedAt });
  }
  changes['cd:index'] = index;
  changes[STORAGE_VERSION] = STORAGE_SCHEMA;
  await chrome.storage.local.set(changes);
  const removed = discarded.filter(key => !records.has(key) || !retained.some(([kept]) => kept === key));
  if (removed.length) await chrome.storage.local.remove(removed).catch(() => {});
}

async function onPageNavigation(sender) {
  contentSender(sender);
  const tabId = sender.tab.id;
  const frames = await framesFor(tabId);
  await serializedHandoff(tabId, async () => {
    const reserved = await selectedFrame(tabId);
    if (sender.frameId === 0 || reserved === sender.frameId
      || (reserved !== undefined && !frames.some(frame => frame.frameId === reserved))) await releaseFrame(tabId);
  });
  // Prompt a tab's frames at most once per quarter second. A trailing prompt
  // carries the latest top-level page after rapid successive navigations.
  const state = navigationBroadcasts.get(tabId) || { last: -Infinity, timer: 0 };
  navigationBroadcasts.set(tabId, state);
  const wait = state.last + 250 - performance.now();
  if (wait <= 0) {
    state.last = performance.now();
    await promptFrames(tabId, sender);
  } else if (!state.timer) {
    state.timer = setTimeout(() => {
      state.timer = 0;
      state.last = performance.now();
      void promptFrames(tabId, sender).catch(() => {});
    }, wait);
  }
  return { ok: true };
}
async function promptFrames(tabId, sender) {
  const tab = await chrome.tabs.get(tabId);
  const frames = await framesFor(tabId);
  const topToken = await Core.topToken(tab.url || sender.tab.url || frames.find(frame => frame.frameId === 0)?.url);
  await Promise.allSettled(frames.map(frame => chrome.tabs.sendMessage(tabId,
    { type: 'CD_CHECK_RESTORE', topToken }, { frameId: frame.frameId })));
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
  const recordAction = ['CD_SAVE', 'CD_UPDATE', 'CD_RESTORE', 'CD_RESTORE_BATCH', 'CD_FORGET'].includes(message.type);
  if (!memoryAvailable && ((recordAction && !memoryContext(sender).privateSession)
    || ['CD_ENABLE_AUTO', 'CD_SYNC_SITES'].includes(message.type))) {
    throw new Error(`Saved captions are unavailable: ${lastStorageError?.message || 'Browser storage could not be prepared.'}`);
  }
  switch (message.type) {
    case 'CD_SCAN': return scanTab(message.tabId, memoryAvailable);
    case 'CD_LOAD_VIDEO': return loadVideo(message, memoryAvailable);
    case 'CD_ENABLE_AUTO': return enableAuto(message, sender);
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
      const incognito = memoryContext(sender).privateSession;
      return { ok: true, topToken: await Core.topToken(topUrl), incognito, memoryAvailable, autoEnabled: !incognito && memoryAvailable && Boolean(pattern)
        && sites.includes(pattern) && await chrome.permissions.contains({ origins: [pattern] }) };
    }
    case 'CD_SAVE': return saveRecord(message, sender);
    case 'CD_UPDATE': return saveRecord(message, sender, true);
    case 'CD_RESTORE': return restoreRecord(message, sender);
    case 'CD_RESTORE_BATCH': return restoreRecords(message, sender);
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
chrome.tabs.onRemoved.addListener(tabId => {
  clearTimeout(navigationBroadcasts.get(tabId)?.timer);
  navigationBroadcasts.delete(tabId);
  pickerRequests.delete(tabId);
  void releaseFrame(tabId).catch(() => {});
});
