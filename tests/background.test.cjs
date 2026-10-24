'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const Core = require('../core.js');

const ROOT = path.resolve(__dirname, '..');
const EXTENSION_ID = 'captiondrop-test-extension';
const SMALL_SRT = '1\n00:00:00,000 --> 00:00:05,000\nHello captions';
const PAGE_URL = 'https://example.com/watch?id=one';
const identity = (name, { pageUrl = PAGE_URL, topUrl = PAGE_URL, src = `https://cdn.example.com/${encodeURIComponent(name)}.mp4`, ordinal = 0 } = {}) => Core.videoKey({ pageUrl, topUrl, src, ordinal });
const contentSender = (overrides = {}) => ({
  id: EXTENSION_ID,
  url: 'https://example.com/watch?id=one',
  tab: { id: 12, url: 'https://example.com/watch?id=one', incognito: false },
  frameId: 0,
  documentId: 'current-document',
  ...overrides,
});
const uiSender = {
  id: EXTENSION_ID,
  url: `chrome-extension://${EXTENSION_ID}/popup.html`,
};

function makeEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); },
    async emit(...args) { await Promise.all(listeners.map((listener) => listener(...args))); },
  };
}

function storageArea(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async setAccessLevel({ accessLevel }) { this.accessLevel = accessLevel; },
    async get(keys) {
      if (keys === null || keys === undefined) return structuredClone(data);
      const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const result = {};
      for (const name of names) {
        if (Object.hasOwn(data, name)) result[name] = structuredClone(data[name]);
        else if (keys && !Array.isArray(keys) && typeof keys === 'object') result[name] = structuredClone(keys[name]);
      }
      return result;
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async getKeys() { return Object.keys(data); },
    async remove(keys) {
      for (const key of typeof keys === 'string' ? [keys] : keys) delete data[key];
    },
  };
}

function worker(options = {}) {
  const local = options.storage?.local || storageArea(options.local);
  const session = options.storage?.session || storageArea(options.session);
  const permitted = new Set(options.permitted || []);
  const scripts = new Map((options.scripts || []).map((script) => [script.id, structuredClone(script)]));
  const sentToTabs = [];
  const createdWindows = [];
  const openWindows = new Set();
  const focusedWindows = [];
  const updatedTabs = [];
  const documents = new Map();
  let windows = [{ id: 1, incognito: false }];
  const chrome = {
    runtime: {
      id: EXTENSION_ID,
      getURL(file) { return `chrome-extension://${EXTENSION_ID}/${file}`; },
      onMessage: makeEvent(), onInstalled: makeEvent(), onStartup: makeEvent(),
    },
    extension: { inIncognitoContext: Boolean(options.incognito) },
    storage: { local, session },
    permissions: {
      async contains({ origins }) { return origins.every((origin) => permitted.has(origin)); },
      onRemoved: makeEvent(),
    },
    scripting: {
      async getRegisteredContentScripts() { return [...scripts.values()].map((script) => structuredClone(script)); },
      async registerContentScripts(additions) {
        for (const script of additions) {
          if (scripts.has(script.id)) throw new Error('Duplicate content script ID');
          scripts.set(script.id, structuredClone(script));
        }
      },
      async unregisterContentScripts({ ids }) { for (const id of ids) scripts.delete(id); },
      async executeScript() { return []; },
    },
    tabs: {
      async get(tabId) { return { id: tabId, url: PAGE_URL, incognito: Boolean(options.incognito) }; },
      async sendMessage(tabId, message, details) {
        sentToTabs.push(structuredClone({ tabId, message, details }));
        return { ok: true, videos: [] };
      },
      async update(tabId, changes) { updatedTabs.push(structuredClone({ tabId, ...changes })); return { id: tabId }; },
      onRemoved: makeEvent(),
    },
    webNavigation: {
      async getFrame({ documentId }) { return documentId ? documents.get(documentId) : { documentId: 'current-document', url: PAGE_URL, documentLifecycle: 'active' }; },
      async getAllFrames() { return [{ frameId: 0, documentId: 'current-document', url: PAGE_URL }, { frameId: 7, documentId: 'current-document', url: PAGE_URL }]; },
      onCommitted: makeEvent(),
      onHistoryStateUpdated: makeEvent(),
      onReferenceFragmentUpdated: makeEvent(),
    },
    windows: {
      async getAll() { return structuredClone(windows); },
      async get(windowId) {
        if (!openWindows.has(windowId)) throw new Error(`No window with id: ${windowId}.`);
        return { id: windowId, tabs: [{ id: 900 + windowId }] };
      },
      async create(options) {
        createdWindows.push(structuredClone(options));
        const id = 80 + createdWindows.length - 1;
        openWindows.add(id);
        return { id };
      },
      async update(windowId, changes) { focusedWindows.push({ windowId, ...changes }); return { id: windowId }; },
      onRemoved: makeEvent(),
    },
  };
  const context = vm.createContext({ chrome, URL, URLSearchParams, TextEncoder, TextDecoder, crypto: webcrypto, console,
    performance, setTimeout, clearTimeout });
  context.importScripts = (...files) => {
    for (const file of files) vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  async function send(message, sender = contentSender()) {
    documents.set(sender.documentId, { documentId: sender.documentId, url: sender.url, documentLifecycle: 'active' });
    const listener = chrome.runtime.onMessage.listeners[0];
    return new Promise((resolve, reject) => {
      let responded = false;
      const respond = (response) => {
        responded = true;
        resolve(JSON.parse(JSON.stringify(response)));
      };
      try {
        const asynchronous = listener(structuredClone(message), structuredClone(sender), respond);
        if (asynchronous !== true && !responded) resolve(undefined);
      } catch (error) { reject(error); }
    });
  }
  return {
    chrome, local, session, permitted, scripts, sentToTabs, createdWindows, openWindows, focusedWindows, updatedTabs, send,
    // Navigation callbacks intentionally return immediately. Advancing one
    // event-loop turn lets their async Chrome API work settle without a sleep.
    async idle() { await new Promise((resolve) => setImmediate(resolve)); },
    setWindows(value) { windows = value; },
  };
}

const saveMessage = (name, changes = {}) => ({
  type: 'CD_SAVE', identity: identity(name), text: SMALL_SRT, fileName: `${name}.srt`,
  style: { size: 32, color: '#aabbcc', background: '#102030', x: 0.3, y: 0.75 }, enabled: true,
  ...changes,
});
const restoreMessage = (name) => ({ type: 'CD_RESTORE', identity: identity(name) });

test('persistent records are addressed by hashes and do not retain readable video identities', async () => {
  const app = worker();
  const pageUrl = `${PAGE_URL}&auth_secret=proofRawSecret`;
  const videoIdentity = identity('url-secret', { pageUrl, topUrl: pageUrl, src: 'https://cdn.example.com/video.mp4?credential=proofRawSecret' });
  const sender = contentSender({ url: pageUrl, tab: { id: 12, url: pageUrl, incognito: false } });
  assert.equal((await app.send(saveMessage('url-secret', { identity: videoIdentity }), sender)).ok, true);
  const restored = await app.send({ type: 'CD_RESTORE', identity: videoIdentity }, sender);
  assert.equal(restored.record.text, SMALL_SRT);
  assert.equal(Object.hasOwn(restored.record, 'identity'), false);
  assert.equal(Object.hasOwn(restored.record, 'scope'), false, 'internal eviction ownership must not be disclosed to content');
  assert.equal(JSON.stringify(app.local.data).includes('proofRawSecret'), false);
  assert.equal(app.local.accessLevel, 'TRUSTED_CONTEXTS');
});

test('a content sender cannot read, overwrite, update, or forget another page association', async () => {
  const app = worker();
  await app.send(saveMessage('victim'));
  const before = structuredClone(app.local.data);
  const unrelated = contentSender({ url: 'https://unrelated.example/', tab: { id: 99, url: 'https://unrelated.example/', incognito: false } });
  for (const message of [restoreMessage('victim'), saveMessage('victim', { text: SMALL_SRT.replace('Hello', 'Injected') }),
    { type: 'CD_UPDATE', identity: identity('victim'), enabled: false }, { type: 'CD_FORGET', identity: identity('victim') }]) {
    const result = await app.send(message, unrelated);
    assert.equal(result.ok, false);
    assert.match(result.error, /current page/);
  }
  assert.deepEqual(app.local.data, before);
  assert.equal((await app.send(restoreMessage('victim'), uiSender)).ok, false);
});

test('embedded-only access derives a trusted top URL even when tab URL metadata is hidden', async () => {
  const app = worker();
  const embed = 'https://player.example.org/embed/one';
  const sender = contentSender({ frameId: 7, url: embed, tab: { id: 12, incognito: false } });
  app.chrome.tabs.get = async tabId => ({ id: tabId, incognito: false });
  app.chrome.webNavigation.getAllFrames = async () => [{ frameId: 0, url: PAGE_URL }, { frameId: 7, url: embed }];
  const embeddedIdentity = identity('embedded', { pageUrl: embed });
  const context = await app.send({ type: 'CD_CONTEXT' }, sender);
  assert.equal(context.topToken, await Core.topToken(PAGE_URL));
  assert.equal(JSON.stringify(context).includes(PAGE_URL), false, 'embedded frames must not learn the top-level URL');
  assert.equal((await app.send(saveMessage('embedded', { identity: embeddedIdentity }), sender)).ok, true);
  assert.equal((await app.send({ type: 'CD_RESTORE', identity: embeddedIdentity }, sender)).record.text, SMALL_SRT);
});

test('startup migration strips plaintext metadata and removes historical private storage before serving records', async () => {
  const pageUrl = `${PAGE_URL}&auth_secret=migrationRawSecret`;
  const videoIdentity = identity('legacy', { pageUrl, topUrl: pageUrl });
  const key = `cd:caption:${await Core.hashKey(videoIdentity)}`;
  const record = { identity: videoIdentity, text: SMALL_SRT, fileName: 'legacy.srt', style: Core.DEFAULT_STYLE, enabled: true, updatedAt: 123 };
  const app = worker({ local: { [key]: record, 'cd:index': [{ key, bytes: 999, updatedAt: 123 }], 'cd:private:old-local': { text: 'old private copy' } },
    session: { 'cd:private:old-session': { text: 'old private copy' }, unrelatedSessionValue: 'keep' } });
  const sender = contentSender({ url: pageUrl, tab: { id: 12, url: pageUrl, incognito: false } });
  const restored = await app.send({ type: 'CD_RESTORE', identity: videoIdentity }, sender);
  assert.equal(restored.record.fileName, 'legacy.srt');
  assert.equal(Object.hasOwn(restored.record, 'identity'), false);
  assert.equal(JSON.stringify(app.local.data).includes('migrationRawSecret'), false);
  assert.equal(Object.keys(app.local.data).some(key => key.startsWith('cd:private:')), false);
  assert.equal(Object.keys(app.session.data).some(key => key.startsWith('cd:private:')), false);
  assert.equal(app.session.data.unrelatedSessionValue, 'keep');
  assert.equal(app.local.data['cd:index'][0].bytes, Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(app.local.data[key])));
});

test('the ownership schema upgrade preserves separate appearance settings and the original caption record', async () => {
  const key = `cd:caption:${await Core.hashKey(identity('v2-appearance'))}`;
  const settings = key.replace(':caption:', ':settings:');
  const initial = { 'cd:storage-version': 2,
    [key]: { text: SMALL_SRT, fileName: 'v2.srt', style: { size: 24 }, enabled: true, updatedAt: 1 },
    [settings]: { style: { size: 48, color: '#aabbcc' }, enabled: false, updatedAt: 42 },
    'cd:index': [{ key, bytes: 999, settingsBytes: 400, updatedAt: 42 }] };
  const app = worker({ local: initial });
  const restored = await app.send(restoreMessage('v2-appearance'));
  assert.equal(restored.record.style.size, 48);
  assert.equal(restored.record.style.color, '#aabbcc');
  assert.equal(restored.record.enabled, false);
  assert.equal(restored.record.text, SMALL_SRT);
  assert.deepEqual(app.local.data, { ...initial, 'cd:storage-version': 3 });
});

test('a private worker never snapshots or migrates the shared regular-caption cache', async () => {
  const videoIdentity = identity('legacy');
  const key = `cd:caption:${await Core.hashKey(videoIdentity)}`;
  const initial = { [key]: { identity: videoIdentity, text: SMALL_SRT, fileName: 'legacy.srt', updatedAt: 123 } };
  const local = storageArea(initial);
  let reads = 0;
  let writes = 0;
  const get = local.get.bind(local);
  const set = local.set.bind(local);
  local.get = async keys => { reads += 1; return get(keys); };
  local.set = async values => { writes += 1; return set(values); };
  const privateWorker = worker({ incognito: true, storage: { local, session: storageArea({ 'cd:private:legacy': { text: 'old private caption' } }) } });
  assert.deepEqual(await privateWorker.send(restoreMessage('legacy')), { ok: true, record: null, private: true });
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.deepEqual(local.data, initial);
  assert.equal(privateWorker.session.data['cd:private:legacy'], undefined);
  const normal = worker({ storage: privateWorker.chrome.storage });
  assert.equal((await normal.send(restoreMessage('legacy'))).record.fileName, 'legacy.srt');
  assert.equal(Object.hasOwn(local.data[key], 'identity'), false);
});

test('provider ordinal migration merges duplicate associations and preserves the latest saved captions', async () => {
  const pageUrl = 'https://www.youtube.com/watch?v=testVideo123';
  const canonical = identity('provider', { pageUrl, topUrl: pageUrl });
  const parts = JSON.parse(canonical);
  parts[4] = 3;
  const oldIdentity = JSON.stringify(parts);
  const canonicalKey = `cd:caption:${await Core.hashKey(canonical)}`;
  const oldKey = `cd:caption:${await Core.hashKey(oldIdentity)}`;
  for (const legacyNewer of [true, false]) {
    const app = worker({ local: {
      [canonicalKey]: { identity: canonical, text: SMALL_SRT, fileName: 'canonical.srt', updatedAt: legacyNewer ? 10 : 20 },
      [oldKey]: { identity: oldIdentity, text: SMALL_SRT, fileName: 'legacy.srt', updatedAt: legacyNewer ? 20 : 10 },
      'cd:index': [{ key: oldKey, bytes: 999, updatedAt: 10 }, { key: canonicalKey, bytes: 999, updatedAt: 20 }],
    } });
    const sender = contentSender({ url: pageUrl, tab: { id: 12, url: pageUrl, incognito: false } });
    const result = await app.send({ type: 'CD_RESTORE', identity: canonical }, sender);
    assert.equal(result.record.fileName, legacyNewer ? 'legacy.srt' : 'canonical.srt');
    assert.equal(app.local.data[oldKey], undefined);
    assert.equal(app.local.data['cd:index'].length, 1);
    assert.equal(Object.hasOwn(app.local.data[canonicalKey], 'identity'), false);
  }
});

test('a failed migration leaves old records intact, blocks unsanitized reads, and retries successfully', async () => {
  const videoIdentity = identity('legacy');
  const key = `cd:caption:${await Core.hashKey(videoIdentity)}`;
  const initial = { [key]: { identity: videoIdentity, text: SMALL_SRT, fileName: 'legacy.srt', updatedAt: 123 } };
  const local = storageArea(initial);
  const set = local.set.bind(local);
  let first = true;
  local.set = async values => {
    if (first) { first = false; throw new Error('Temporary disk write failure'); }
    return set(values);
  };
  const app = worker({ storage: { local, session: storageArea() } });
  const failed = await app.send(restoreMessage('legacy'));
  assert.equal(failed.ok, false);
  assert.match(failed.error, /unavailable/);
  assert.deepEqual(app.local.data, initial);
  assert.equal((await app.send(restoreMessage('legacy'))).record.fileName, 'legacy.srt');
  assert.equal(Object.hasOwn(app.local.data[key], 'identity'), false);
});

test('unavailable storage does not prevent scanning or page-only manual captions', async () => {
  const local = storageArea();
  let unavailable = true;
  local.setAccessLevel = async () => { if (unavailable) throw new Error('Storage temporarily unavailable'); };
  const app = worker({ storage: { local, session: storageArea() } });
  assert.equal((await app.send({ type: 'CD_SCAN', tabId: 12 }, uiSender)).ok, true);
  const context = await app.send({ type: 'CD_CONTEXT' });
  assert.equal(context.ok, true);
  assert.equal(context.memoryAvailable, false);
  assert.equal((await app.send({ type: 'CD_LOAD_VIDEO', tabId: 12, frameId: 0, videoId: 'cd-video-1', text: SMALL_SRT }, uiSender)).ok, true);
  assert.equal(app.sentToTabs.find(item => item.message.type === 'CD_LOAD').message.remember, false);
  assert.equal((await app.send(restoreMessage('anything'))).ok, false);
  unavailable = false;
  assert.equal((await app.send(saveMessage('recovered'))).ok, true);
  assert.equal((await app.send(restoreMessage('recovered'))).record.text, SMALL_SRT);
});

test('manual loading can initialize content context without a tab-lock deadlock', { timeout: 2000 }, async () => {
  const app = worker();
  app.chrome.tabs.sendMessage = async (tabId, message) => {
    if (message.type === 'CD_LOAD') {
      assert.equal((await app.send({ type: 'CD_CONTEXT' })).ok, true);
      assert.equal((await app.send(saveMessage('during-initialization'))).ok, true);
    }
    return { ok: true };
  };
  assert.equal((await app.send({ type: 'CD_LOAD_VIDEO', tabId: 12, frameId: 0, videoId: 'cd-video-1', text: SMALL_SRT }, uiSender)).ok, true);
  assert.equal(app.session.data['cd:selection:12'], 0);
});

test('worker saves, restores, updates, and forgets caption contents and appearance', async () => {
  const app = worker();
  assert.deepEqual(await app.send(saveMessage('first')), { ok: true, saved: true });
  let response = await app.send(restoreMessage('first'));
  assert.equal(response.record.text, SMALL_SRT);
  assert.equal(response.record.fileName, 'first.srt');
  assert.equal(response.record.style.size, 32);
  assert.equal(response.record.style.x, 0.3);
  const update = await app.send({ type: 'CD_UPDATE', identity: identity('first'), style: { size: 42, color: '#ff0000', background: '#ffffff', x: 0.6, y: 0.4 }, enabled: false });
  assert.deepEqual(update, { ok: true, saved: true });
  response = await app.send(restoreMessage('first'));
  assert.equal(response.record.text, SMALL_SRT);
  assert.equal(response.record.style.size, 42);
  assert.equal(response.record.enabled, false);
  assert.equal((await app.send({ type: 'CD_UPDATE', identity: identity('missing'), style: { size: 40 } })).saved, false);
  assert.equal((await app.send(restoreMessage('missing'))).record, null);
  assert.equal((await app.send({ type: 'CD_FORGET', identity: identity('first') })).ok, true);
  assert.equal((await app.send(restoreMessage('first'))).record, null);
  assert.equal(Object.values(app.local.data).some((value) => value?.text === SMALL_SRT), false);
});

test('a malformed or oversized replacement cannot overwrite the remembered subtitle', async () => {
  const app = worker();
  await app.send(saveMessage('existing'));
  const malformed = await app.send(saveMessage('existing', { text: 'not a subtitle', fileName: 'broken.srt', style: { size: 64 } }));
  assert.equal(malformed.ok, false);
  assert.match(malformed.error, /timing|subtitle|\.srt/i);
  const oversized = await app.send(saveMessage('existing', { text: 'x'.repeat(2 * 1024 * 1024 + 1) }));
  assert.equal(oversized.ok, false);
  assert.match(oversized.error, /2 MiB/);
  const response = await app.send(restoreMessage('existing'));
  assert.equal(response.record.text, SMALL_SRT);
  assert.equal(response.record.fileName, 'existing.srt');
  assert.equal(response.record.style.size, 32);
});

test('a bad file is rejected before a different frame or player is selected', async () => {
  const app = worker();
  const response = await app.send({ type: 'CD_LOAD_VIDEO', tabId: 12, frameId: 7, videoId: 'other', text: 'bad file' }, uiSender);
  assert.equal(response.ok, false);
  assert.equal(app.sentToTabs.length, 0, 'validation must precede any disable/load message');
});

test('a player that disappears during file selection preserves the previous frame and its reservation', async () => {
  for (const disconnected of [false, true]) {
    const app = worker();
    const embedded = contentSender({ frameId: 7 });
    await app.send(saveMessage('active'));
    assert.ok((await app.send(restoreMessage('active'), embedded)).record);
    app.chrome.tabs.sendMessage = async (tabId, message, details) => {
      app.sentToTabs.push(structuredClone({ tabId, message, details }));
      if (message.type === 'CD_LOAD') {
        if (disconnected) throw new Error('The selected frame no longer exists.');
        return { ok: false, error: 'This video is no longer available.' };
      }
      return { ok: true };
    };
    const response = await app.send({ type: 'CD_LOAD_VIDEO', tabId: 12, frameId: 0,
      videoId: 'cd-video-1', text: SMALL_SRT, fileName: 'replacement.srt' }, uiSender);
    assert.equal(response.ok, false);
    assert.equal(app.sentToTabs.some(item => item.message.type === 'CD_DISABLE_ALL'), false);
    assert.equal(app.session.data['cd:selection:12'], 7);
    assert.ok((await app.send(restoreMessage('active'), embedded)).record);
  }
});

test('concurrent player handoffs load successfully before disabling the previous frame and keep the latest selection', async () => {
  const app = worker();
  let finishFirst;
  const firstLoad = new Promise(resolve => { finishFirst = resolve; });
  app.chrome.tabs.sendMessage = async (tabId, message, details) => {
    app.sentToTabs.push(structuredClone({ tabId, message, details }));
    if (message.type === 'CD_LOAD' && details.frameId === 7) await firstLoad;
    return { ok: true };
  };
  const first = app.send({ type: 'CD_LOAD_VIDEO', tabId: 12, frameId: 7, videoId: 'cd-video-1', text: SMALL_SRT }, uiSender);
  const second = app.send({ type: 'CD_LOAD_VIDEO', tabId: 12, frameId: 0, videoId: 'cd-video-2', text: SMALL_SRT }, uiSender);
  while (!app.sentToTabs.length) await app.idle();
  for (let turn = 0; turn < 10; turn += 1) await app.idle();
  assert.deepEqual(app.sentToTabs.map(item => item.message.type), ['CD_LOAD']);
  finishFirst();
  assert.deepEqual((await Promise.all([first, second])).map(result => result.ok), [true, true]);
  assert.deepEqual(app.sentToTabs.map(item => [item.message.type, item.details.frameId]), [
    ['CD_LOAD', 7], ['CD_DISABLE_ALL', 0], ['CD_LOAD', 0], ['CD_DISABLE_ALL', 7],
  ]);
  assert.equal(app.session.data['cd:selection:12'], 0);
});

test('a handoff can persist the target subtitles while an automatic restore is queued', { timeout: 2000 }, async () => {
  const app = worker();
  await app.send(saveMessage('other-frame'));
  app.chrome.tabs.sendMessage = async (tabId, message) => {
    if (message.type === 'CD_LOAD') assert.equal((await app.send(saveMessage('new-player'))).ok, true);
    return { ok: true };
  };
  const handoff = app.send({ type: 'CD_LOAD_VIDEO', tabId: 12, frameId: 0, videoId: 'cd-video-1', text: SMALL_SRT }, uiSender);
  const restoring = app.send(restoreMessage('other-frame'), contentSender({ frameId: 7 }));
  assert.equal((await handoff).ok, true);
  assert.deepEqual(await restoring, { ok: true, record: null, retry: true });
  assert.equal((await app.send(restoreMessage('new-player'))).record.fileName, 'new-player.srt');
});

test('valid UTF-16 subtitles below the original file limit survive worker loading and saving', async () => {
  const text = Array.from({ length: 10000 }, (_, i) => {
    const seconds = i * 2;
    const timestamp = value => `${String(Math.floor(value / 3600)).padStart(2, '0')}:${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')},000`;
    return `${i + 1}\n${timestamp(seconds)} --> ${timestamp(seconds + 1)}\n${'字'.repeat(60)}`;
  }).join('\n\n');
  const originalBytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  assert.ok(originalBytes.length < 2 * 1024 * 1024);
  assert.ok(Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024);
  const app = worker();
  const load = await app.send({ type: 'CD_LOAD_VIDEO', tabId: 12, frameId: 0, videoId: 'cd-video-1', text }, uiSender);
  assert.equal(load.ok, true);
  const save = await app.send(saveMessage('utf16', { text }));
  assert.equal(save.ok, true);
  assert.equal((await app.send(restoreMessage('utf16'))).record.text, text);
});

test('both worker entrypoints reject decoded subtitle text beyond the supported code-unit bound', async () => {
  const app = worker();
  const text = `1\n00:00:00,000 --> 00:00:05,000\n${'字'.repeat(2 * 1024 * 1024)}`;
  const load = await app.send({ type: 'CD_LOAD_VIDEO', tabId: 12, frameId: 0, videoId: 'cd-video-1', text }, uiSender);
  const save = await app.send(saveMessage('too-large', { text }));
  assert.equal(load.ok, false);
  assert.equal(save.ok, false);
  assert.match(load.error, /too large/);
  assert.match(save.error, /too large/);
  assert.equal(app.sentToTabs.length, 0);
  assert.equal(Object.values(app.local.data).some(value => value?.text), false);
});

test('the record-count budget evicts the oldest record without dropping the newest', async () => {
  const app = worker();
  for (let i = 0; i < 51; i += 1) assert.equal((await app.send(saveMessage(`count-${i}`))).ok, true);
  const records = Object.values(app.local.data).filter((value) => value && typeof value.text === 'string');
  assert.equal(records.length, 50);
  assert.equal((await app.send(restoreMessage('count-0'))).record, null);
  assert.equal((await app.send(restoreMessage('count-50'))).record.fileName, 'count-50.srt');
  assert.equal((await app.send(restoreMessage('count-1'))).record.fileName, 'count-1.srt');
});

test('forged saves can evict only their own origin pair even with victim media and scope metadata', async () => {
  const app = worker();
  await app.send(saveMessage('victim'));
  const victimKey = app.local.data['cd:index'][0].key;
  const victim = structuredClone(app.local.data[victimKey]);
  const victimSettings = structuredClone(app.local.data[victimKey.replace(':caption:', ':settings:')]);
  const pageUrl = 'https://compromised.example/watch';
  const sender = contentSender({ url: pageUrl, tab: { id: 99, url: pageUrl, incognito: false } });
  const forgedIdentity = i => identity(`forged-${i}`, { pageUrl, topUrl: pageUrl,
    src: `https://example.com/victim-${i}.mp4`, ordinal: i });
  for (let i = 0; i < 55; i++) {
    const result = await app.send(saveMessage(`forged-${i}`, { identity: forgedIdentity(i),
      scope: victim.scope, origin: 'https://example.com', topUrl: PAGE_URL }), sender);
    assert.equal(result.saved, true, result.error);
  }
  assert.equal(app.local.data['cd:index'].length, 50);
  assert.deepEqual(app.local.data[victimKey], victim);
  assert.deepEqual(app.local.data[victimKey.replace(':caption:', ':settings:')], victimSettings);
  assert.equal((await app.send(restoreMessage('victim'))).record.fileName, 'victim.srt');
  assert.equal((await app.send({ type: 'CD_RESTORE', identity: forgedIdentity(0) }, sender)).record, null);
  assert.equal((await app.send({ type: 'CD_RESTORE', identity: forgedIdentity(54) }, sender)).record.fileName, 'forged-54.srt');
  assert.equal(app.local.data['cd:index'].filter(item => item.scope === victim.scope).length, 1);
});

test('a full cache belonging to another site rejects a forged save without changing any record', async () => {
  const app = worker();
  for (let i = 0; i < 50; i++) await app.send(saveMessage(`victim-${i}`));
  const before = structuredClone(app.local.data);
  const pageUrl = 'https://compromised.example/watch';
  const sender = contentSender({ url: pageUrl, tab: { id: 99, url: pageUrl, incognito: false } });
  const result = await app.send(saveMessage('forged', { identity: identity('forged', { pageUrl, topUrl: pageUrl }) }), sender);
  assert.equal(result.ok, false);
  assert.match(result.error, /memory is full/i);
  assert.deepEqual(app.local.data, before);
});

test('eviction ownership distinguishes schemes and ports while allowing other pages on the same origin', async () => {
  const first = worker();
  for (let i = 0; i < 50; i++) assert.equal((await first.send(saveMessage(`origin-${i}`))).saved, true);
  const saved = structuredClone(first.local.data);
  for (const pageUrl of ['http://example.com/watch', 'https://example.com:8443/watch']) {
    const app = worker({ local: saved });
    const sender = contentSender({ url: pageUrl, tab: { id: 99, url: pageUrl, incognito: false } });
    const result = await app.send(saveMessage('different-origin', { identity: identity('different-origin', { pageUrl, topUrl: pageUrl }) }), sender);
    assert.equal(result.ok, false, pageUrl);
    assert.match(result.error, /memory is full/i);
    assert.deepEqual(app.local.data, saved, pageUrl);
  }
  const sameOrigin = worker({ local: saved });
  const pageUrl = 'https://example.com/another-page';
  const sender = contentSender({ url: pageUrl, tab: { id: 99, url: pageUrl, incognito: false } });
  assert.equal((await sameOrigin.send(saveMessage('same-origin', { identity: identity('same-origin', { pageUrl, topUrl: pageUrl }) }), sender)).saved, true);
  assert.equal((await sameOrigin.send(restoreMessage('origin-0'))).record, null);
  assert.equal((await sameOrigin.send(restoreMessage('origin-1'))).record.fileName, 'origin-1.srt');
});

test('opaque frame or top-level origins cannot save or alter caption memory', async () => {
  const app = worker();
  await app.send(saveMessage('opaque-victim'));
  const before = structuredClone(app.local.data);
  for (const { pageUrl, topUrl, frameId } of [
    { pageUrl: 'data:text/html,<video>', topUrl: 'data:text/html,<video>', frameId: 0 },
    { pageUrl: 'about:blank', topUrl: PAGE_URL, frameId: 7 },
    { pageUrl: 'https://player.example.net/embed', topUrl: 'data:text/html,<iframe>', frameId: 7 },
  ]) {
    app.chrome.tabs.get = async tabId => ({ id: tabId, url: topUrl, incognito: false });
    const sender = contentSender({ url: pageUrl, frameId, tab: { id: 99, url: topUrl, incognito: false } });
    const result = await app.send(saveMessage('opaque', { identity: identity('opaque', { pageUrl, topUrl }) }), sender);
    assert.equal(result.ok, false, `${topUrl} / ${pageUrl}`);
    assert.match(result.error, /could not be identified/i);
    assert.deepEqual(app.local.data, before);
  }
});

test('the byte budget evicts same-site captions while preserving older captions from other sites', async () => {
  const app = worker();
  const text = `1\n00:00:00,000 --> 00:00:05,000\n${'z'.repeat(1500000)}`;
  for (let i = 0; i < 3; i++) assert.equal((await app.send(saveMessage(`victim-large-${i}`, { text }))).saved, true);
  const protectedKeys = app.local.data['cd:index'].map(item => item.key);
  const protectedValues = await app.local.get(protectedKeys.flatMap(key => [key, key.replace(':caption:', ':settings:')]));
  const pageUrl = 'https://compromised.example/watch';
  const sender = contentSender({ url: pageUrl, tab: { id: 99, url: pageUrl, incognito: false } });
  const attackIdentity = i => identity(`large-${i}`, { pageUrl, topUrl: pageUrl });
  for (let i = 0; i < 4; i++) {
    const result = await app.send(saveMessage(`large-${i}`, { identity: attackIdentity(i), text }), sender);
    assert.equal(result.saved, true, result.error);
  }
  assert.deepEqual(await app.local.get(Object.keys(protectedValues)), protectedValues);
  assert.equal((await app.send({ type: 'CD_RESTORE', identity: attackIdentity(0) }, sender)).record, null);
  assert.equal((await app.send({ type: 'CD_RESTORE', identity: attackIdentity(3) }, sender)).record.text, text);
  assert.equal(Object.values(app.local.data).filter(value => typeof value?.text === 'string').length, 5);
});

test('quota retries and appearance updates cannot evict another site or an unowned legacy caption', async () => {
  const legacyIdentity = identity('legacy-quota');
  const legacyKey = `cd:caption:${await Core.hashKey(legacyIdentity)}`;
  const app = worker({ local: { 'cd:storage-version': 2,
    [legacyKey]: { text: SMALL_SRT, fileName: 'legacy.srt', updatedAt: 1 },
    'cd:index': [{ key: legacyKey, bytes: 999, updatedAt: 1 }] } });
  await app.send(saveMessage('victim-quota'));
  const victimKey = app.local.data['cd:index'].find(item => item.key !== legacyKey).key;
  const pageUrl = 'https://compromised.example/watch';
  const sender = contentSender({ url: pageUrl, tab: { id: 99, url: pageUrl, incognito: false } });
  const attackerIdentity = name => identity(name, { pageUrl, topUrl: pageUrl });
  for (const name of ['attacker-old', 'attacker-current']) {
    assert.equal((await app.send(saveMessage(name, { identity: attackerIdentity(name) }), sender)).saved, true);
  }
  const oldKey = `cd:caption:${await Core.hashKey(attackerIdentity('attacker-old'))}`;
  const protectedKeys = [legacyKey, victimKey].flatMap(key => [key, key.replace(':caption:', ':settings:')]);
  const protectedValues = await app.local.get(protectedKeys);
  const set = app.local.set.bind(app.local);
  let attempts = 0;
  app.local.set = async values => {
    attempts++;
    for (const key of protectedKeys) assert.equal(Object.hasOwn(values, key), false, 'quota retry must not clear another scope');
    if (values[oldKey] !== null) throw new Error('QUOTA_BYTES quota exceeded');
    return set(values);
  };
  assert.equal((await app.send(saveMessage('attacker-new', { identity: attackerIdentity('attacker-new') }), sender)).saved, true);
  assert.equal(attempts, 2);
  assert.deepEqual(await app.local.get(protectedKeys), protectedValues);
  assert.equal(app.local.data[oldKey], undefined);

  const before = structuredClone(app.local.data);
  attempts = 0;
  app.local.set = async values => {
    attempts++;
    for (const key of protectedKeys) assert.equal(Object.hasOwn(values, key), false);
    throw new Error('QUOTA_BYTES quota exceeded');
  };
  const update = await app.send({ type: 'CD_UPDATE', identity: attackerIdentity('attacker-current'), style: { size: 48 } }, sender);
  assert.equal(update.ok, false);
  assert.match(update.error, /memory is full/i);
  assert.equal(attempts, 2, 'only the other attacker caption is eligible for a retry');
  assert.deepEqual(app.local.data, before, 'failed updates preserve captions, appearance, and the index atomically');
});

test('legacy captions stay protected after appearance updates until an exact full resave establishes ownership', async () => {
  const local = { 'cd:storage-version': 2, 'cd:index': [] };
  for (let i = 0; i < 50; i++) {
    const key = `cd:caption:${await Core.hashKey(identity(`legacy-${i}`))}`;
    local[key] = { text: SMALL_SRT, fileName: `legacy-${i}.srt`, updatedAt: i };
    local['cd:index'].push({ key, bytes: 999, updatedAt: i });
  }
  const app = worker({ local });
  assert.equal((await app.send(restoreMessage('legacy-0'))).record.fileName, 'legacy-0.srt');
  assert.equal((await app.send({ type: 'CD_UPDATE', identity: identity('legacy-0'), enabled: false })).saved, true);
  const before = structuredClone(app.local.data);
  const result = await app.send(saveMessage('new-at-capacity'));
  assert.equal(result.ok, false);
  assert.match(result.error, /memory is full/i);
  assert.deepEqual(app.local.data, before);
  assert.equal((await app.send(saveMessage('legacy-0'))).saved, true);
  assert.equal((await app.send(saveMessage('new-at-capacity'))).saved, true);
  assert.equal((await app.send(restoreMessage('legacy-0'))).record, null);
  for (let i = 1; i < 50; i++) assert.equal((await app.send(restoreMessage(`legacy-${i}`))).record.fileName, `legacy-${i}.srt`);
});

test('origin-pair isolation separates embedded players from the host and from other embedding sites', async () => {
  const app = worker();
  await app.send(saveMessage('host-caption'));
  const hostKey = app.local.data['cd:index'][0].key;
  const embedUrl = 'https://player.example.net/embed/one';
  const embedSender = contentSender({ url: embedUrl, frameId: 7, documentId: 'embed-document' });
  const embedIdentity = name => identity(name, { pageUrl: embedUrl });
  assert.equal((await app.send(saveMessage('embed-caption', { identity: embedIdentity('embed-caption') }), embedSender)).saved, true);
  const embedKey = `cd:caption:${await Core.hashKey(embedIdentity('embed-caption'))}`;
  assert.notEqual(app.local.data[embedKey].scope, app.local.data[hostKey].scope);
  const protectedValues = await app.local.get([hostKey, embedKey]);
  const otherTopUrl = 'https://compromised.example/watch';
  app.chrome.tabs.get = async tabId => ({ id: tabId, url: otherTopUrl, incognito: false });
  for (let i = 0; i < 55; i++) {
    const message = saveMessage(`other-host-${i}`, { identity: identity(`other-host-${i}`, { pageUrl: embedUrl, topUrl: otherTopUrl }),
      scope: app.local.data[embedKey].scope, topUrl: PAGE_URL });
    assert.equal((await app.send(message, embedSender)).saved, true);
  }
  assert.deepEqual(await app.local.get(Object.keys(protectedValues)), protectedValues);
  assert.equal(app.local.data['cd:index'].length, 50);
});

test('worker restart and damaged-index repair retain eviction ownership', async () => {
  const first = worker();
  await first.send(saveMessage('restart-victim'));
  const pageUrl = 'https://compromised.example/watch';
  const sender = contentSender({ url: pageUrl, tab: { id: 99, url: pageUrl, incognito: false } });
  const attackerIdentity = i => identity(`restart-${i}`, { pageUrl, topUrl: pageUrl });
  await first.send(saveMessage('restart-0', { identity: attackerIdentity(0) }), sender);
  const victimKey = `cd:caption:${await Core.hashKey(identity('restart-victim'))}`;
  const victim = structuredClone(first.local.data[victimKey]);
  const saved = structuredClone(first.local.data);
  for (const damaged of [false, true]) {
    const local = structuredClone(saved);
    if (damaged) local['cd:index'] = 'damaged';
    const restarted = worker({ local });
    for (let i = 1; i < 52; i++) {
      assert.equal((await restarted.send(saveMessage(`restart-${i}`, { identity: attackerIdentity(i) }), sender)).saved, true);
    }
    assert.deepEqual(restarted.local.data[victimKey], victim);
    assert.equal(restarted.local.data['cd:index'].find(item => item.key === victimKey).scope, victim.scope);
    assert.equal((await restarted.send(restoreMessage('restart-victim'))).record.fileName, 'restart-victim.srt');
  }
});

test('the aggregate 8 MiB budget evicts old large files and remains restorable', async () => {
  const app = worker();
  const bigText = `1\n00:00:00,000 --> 00:00:05,000\n${'z'.repeat(1500000)}`;
  for (let i = 0; i < 6; i += 1) assert.equal((await app.send(saveMessage(`large-${i}`, { text: bigText }))).ok, true);
  const records = Object.values(app.local.data).filter((value) => value && typeof value.text === 'string');
  const actualBytes = records.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record)), 0);
  assert.ok(actualBytes <= 8 * 1024 * 1024);
  assert.ok(records.length < 6);
  assert.equal((await app.send(restoreMessage('large-0'))).record, null);
  assert.equal((await app.send(restoreMessage('large-5'))).record.text.length, bigText.length);
});

test('concurrent writes maintain the cache limit and keep each saved record indexed once', async () => {
  const app = worker();
  const responses = await Promise.all(Array.from({ length: 53 }, (_, i) => app.send(saveMessage(`parallel-${i}`))));
  assert.ok(responses.every((response) => response.ok));
  const records = Object.values(app.local.data).filter((value) => value && typeof value.text === 'string');
  assert.equal(records.length, 50);
  const indexes = Object.values(app.local.data).filter(Array.isArray);
  assert.equal(indexes.length, 1);
  assert.equal(indexes[0].length, 50);
  assert.equal(new Set(indexes[0].map((item) => item.key)).size, 50);
  assert.ok(indexes[0].every((item) => app.local.data[item.key]?.text));
  assert.ok(indexes[0].every((item) => !Object.hasOwn(app.local.data[item.key], 'identity')));
});

test('a rejected replacement write preserves every saved record and its index at the eviction limit', async () => {
  const app = worker();
  for (let i = 0; i < 50; i += 1) await app.send(saveMessage(`existing-${i}`));
  const original = structuredClone(app.local.data);
  app.local.set = async () => { throw new Error('Storage write failed'); };
  const result = await app.send(saveMessage('failed-replacement'));
  assert.equal(result.ok, false);
  assert.match(result.error, /Storage write failed/);
  assert.deepEqual(app.local.data, original);
});

test('a permanent quota rejection preserves old records through bounded atomic retries', async () => {
  const app = worker();
  for (let i = 0; i < 50; i += 1) await app.send(saveMessage(`existing-${i}`));
  const original = structuredClone(app.local.data);
  let calls = 0;
  app.local.set = async () => {
    calls += 1;
    throw new Error('QUOTA_BYTES quota exceeded');
  };
  const result = await app.send(saveMessage('failed-replacement'));
  assert.equal(result.ok, false);
  assert.match(result.error, /memory is full/i);
  assert.equal(calls, 50);
  assert.deepEqual(app.local.data, original);
});

test('a quota-limited replacement succeeds after evicting only the required old record', async () => {
  const app = worker();
  for (let i = 0; i < 50; i += 1) await app.send(saveMessage(`existing-${i}`));
  const oldestKey = app.local.data['cd:index'][0].key;
  const size = data => Buffer.byteLength(JSON.stringify(data));
  const quota = size(app.local.data) + 256;
  const set = app.local.set.bind(app.local);
  let calls = 0;
  app.local.set = async values => {
    calls += 1;
    assert.equal(values[oldestKey], null, 'the old value must be cleared in the same write');
    const withoutClearing = { ...values };
    delete withoutClearing[oldestKey];
    assert.ok(size({ ...app.local.data, ...withoutClearing }) > quota, 'writing the new record alone would exceed quota');
    assert.ok(size({ ...app.local.data, ...values }) <= quota, 'the full batch must fit without deleting first');
    return set(values);
  };
  assert.equal((await app.send(saveMessage('replacement'))).ok, true);
  assert.equal(calls, 1);
  assert.equal(app.local.data['cd:index'].length, 50);
  assert.equal(Object.values(app.local.data).filter(value => typeof value?.text === 'string').length, 50);
  assert.equal((await app.send(restoreMessage('replacement'))).record.fileName, 'replacement.srt');
});

test('failed tombstone cleanup preserves the committed new record and retains no evicted subtitle text', async () => {
  const app = worker();
  for (let i = 0; i < 50; i += 1) await app.send(saveMessage(`existing-${i}`));
  const oldestKey = app.local.data['cd:index'][0].key;
  app.local.remove = async () => { throw new Error('Cleanup failed'); };
  assert.equal((await app.send(saveMessage('replacement'))).ok, true);
  assert.equal(app.local.data[oldestKey], null);
  assert.equal(app.local.data['cd:index'].some(item => item.key === oldestKey), false);
  assert.equal((await app.send(restoreMessage('existing-0'))).record, null);
  assert.equal((await app.send(restoreMessage('replacement'))).record.fileName, 'replacement.srt');
});

test('private subtitle actions never persist captions and ordinary window closes cannot affect them', async () => {
  const app = worker({ session: { unrelatedSessionValue: 'keep me' } });
  const privateSender = contentSender({ tab: { id: 25, url: 'https://example.com/watch?id=one', incognito: true } });
  const privateText = SMALL_SRT.replace('Hello captions', 'Private captions');
  await app.send(saveMessage('shared-identity'));
  assert.deepEqual(await app.send(saveMessage('shared-identity', { text: privateText }), privateSender), { ok: true, saved: false, private: true });
  assert.equal((await app.send(restoreMessage('shared-identity'))).record.text, SMALL_SRT);
  assert.deepEqual(await app.send(restoreMessage('shared-identity'), privateSender), { ok: true, record: null, private: true });
  assert.deepEqual(await app.send({ type: 'CD_UPDATE', identity: identity('shared-identity') }, privateSender), { ok: true, saved: false, private: true });
  assert.equal((await app.send({ type: 'CD_FORGET', identity: identity('shared-identity') }, privateSender)).ok, true);
  assert.equal(JSON.stringify(app.local.data).includes('Private captions'), false);
  assert.equal(JSON.stringify(app.session.data).includes('Private captions'), false);
  await app.chrome.windows.onRemoved.emit(3);
  await app.chrome.windows.onRemoved.emit(2);
  assert.equal((await app.send(restoreMessage('shared-identity'), privateSender)).record, null);
  assert.equal(app.session.data.unrelatedSessionValue, 'keep me');
  assert.equal((await app.send(restoreMessage('shared-identity'))).record.text, SMALL_SRT);
});

test('an Incognito worker loads page-only captions without storage even if its sender omits the private flag', async () => {
  const app = worker({ incognito: true });
  assert.equal((await app.send(saveMessage('split-worker'))).saved, false);
  assert.equal(Object.keys(app.local.data).length, 0);
  assert.equal((await app.send(restoreMessage('split-worker'))).record, null);
  const load = await app.send({ type: 'CD_LOAD_VIDEO', tabId: 12, frameId: 0, videoId: 'cd-video-1', text: SMALL_SRT }, uiSender);
  assert.equal(load.ok, true);
  assert.equal(app.sentToTabs.find(item => item.message.type === 'CD_LOAD').message.remember, false);
  assert.equal(Object.keys(app.session.data).length, 0);
  assert.equal((await app.send({ type: 'CD_CONTEXT' })).incognito, true);
  assert.equal((await app.send({ type: 'CD_CONTEXT' })).autoEnabled, false);
});

test('automatic restore reserves one frame per tab and releases it on root navigation or tab closure', async () => {
  const app = worker();
  await app.send(saveMessage('root'));
  await app.send(saveMessage('embedded'));
  const root = contentSender();
  const embedded = contentSender({ frameId: 7, url: PAGE_URL });
  const otherTab = contentSender({ frameId: 7, tab: { id: 99, url: 'https://example.com/watch?id=one', incognito: false } });
  assert.ok((await app.send(restoreMessage('root'), root)).record);
  assert.equal((await app.send(restoreMessage('embedded'), embedded)).record, null);
  assert.ok((await app.send(restoreMessage('embedded'), otherTab)).record, 'other tabs have independent reservations');
  await app.send({ type: 'CD_NAVIGATED' }, embedded);
  assert.equal((await app.send(restoreMessage('embedded'), embedded)).record, null, 'subframe navigation must not clear the root reservation');
  await app.send({ type: 'CD_NAVIGATED' }, root);
  assert.ok((await app.send(restoreMessage('embedded'), embedded)).record);
  assert.equal((await app.send(restoreMessage('root'), root)).record, null);
  await app.chrome.tabs.onRemoved.emit(12);
  assert.ok((await app.send(restoreMessage('root'), root)).record);
});

test('a missing association does not reserve its frame and block a valid restore elsewhere', async () => {
  const app = worker();
  await app.send(saveMessage('available'));
  assert.equal((await app.send(restoreMessage('missing'))).record, null);
  assert.ok((await app.send(restoreMessage('available'), contentSender({ frameId: 7 }))).record);
});

test('an equivalent iframe replacement can restore when the reserved owner no longer exists', async () => {
  const app = worker();
  await app.send(saveMessage('embedded'));
  assert.ok((await app.send(restoreMessage('embedded'), contentSender({ frameId: 7 }))).record);
  app.chrome.webNavigation.getAllFrames = async () => [
    { frameId: 0, url: 'https://example.com/watch?id=one' },
    { frameId: 8, url: PAGE_URL },
  ];
  const replacement = contentSender({ frameId: 8 });
  assert.ok((await app.send(restoreMessage('embedded'), replacement)).record);
  assert.equal(app.session.data['cd:selection:12'], 8);
});

test('a temporarily blocked restore requests a retry and succeeds after its owner disappears', async () => {
  const app = worker();
  await app.send(saveMessage('first'));
  await app.send(saveMessage('next'));
  assert.ok((await app.send(restoreMessage('first'), contentSender({ frameId: 7 }))).record);
  const blocked = await app.send(restoreMessage('next'));
  assert.deepEqual(blocked, { ok: true, record: null, retry: true });
  app.chrome.webNavigation.getAllFrames = async () => [{ frameId: 0, url: 'https://example.com/watch?id=one' }];
  assert.ok((await app.send(restoreMessage('next'))).record);
  assert.equal(app.session.data['cd:selection:12'], 0);
});

test('a delayed stale-frame restore cannot overwrite a newer manual handoff reservation', async () => {
  const app = worker();
  await app.send(saveMessage('previous'));
  await app.send(saveMessage('replacement'));
  assert.ok((await app.send(restoreMessage('previous'), contentSender({ frameId: 7 }))).record);
  let releaseFrames;
  const frameLookup = new Promise(resolve => { releaseFrames = resolve; });
  app.chrome.webNavigation.getAllFrames = async () => {
    await frameLookup;
    return [{ frameId: 0, url: 'https://example.com/watch?id=one' }, { frameId: 8, url: PAGE_URL }];
  };
  const restoring = app.send(restoreMessage('replacement'), contentSender({ frameId: 8 }));
  await app.idle();
  const manual = app.send({ type: 'CD_LOAD_VIDEO', tabId: 12, frameId: 0, videoId: 'cd-video-1', text: SMALL_SRT }, uiSender);
  await app.idle();
  assert.equal(app.sentToTabs.some(item => item.message.type === 'CD_LOAD'), false);
  releaseFrames();
  assert.ok((await restoring).record);
  assert.equal((await manual).ok, true);
  assert.equal(app.session.data['cd:selection:12'], 0);
});

test('selected child-frame navigation releases its reservation and prompts other frames to retry', async () => {
  const app = worker();
  await app.send(saveMessage('embedded'));
  assert.ok((await app.send(restoreMessage('embedded'), contentSender({ frameId: 7 }))).record);
  await app.send({ type: 'CD_NAVIGATED' }, contentSender({ frameId: 7 }));
  await app.idle();
  assert.equal(app.session.data['cd:selection:12'], undefined);
  assert.deepEqual(app.sentToTabs.map(item => [item.message.type, item.details.frameId]), [
    ['CD_CHECK_RESTORE', 0], ['CD_CHECK_RESTORE', 7],
  ]);
});

test('an activated child frame prompts retries if the selected owner was removed', async () => {
  const app = worker();
  await app.send(saveMessage('embedded'));
  assert.ok((await app.send(restoreMessage('embedded'), contentSender({ frameId: 7 }))).record);
  app.chrome.webNavigation.getAllFrames = async () => [
    { frameId: 0, url: 'https://example.com/watch?id=one' },
    { frameId: 8, url: PAGE_URL },
  ];
  await app.send({ type: 'CD_NAVIGATED' }, contentSender({ frameId: 8 }));
  await app.idle();
  assert.equal(app.session.data['cd:selection:12'], undefined);
  assert.deepEqual(app.sentToTabs.map(item => [item.message.type, item.details.frameId]), [
    ['CD_CHECK_RESTORE', 0], ['CD_CHECK_RESTORE', 8],
  ]);
});

test('frame reservations survive a service-worker restart while the selected page stays open', async () => {
  const firstWorker = worker();
  await firstWorker.send(saveMessage('root'));
  await firstWorker.send(saveMessage('embedded'));
  assert.ok((await firstWorker.send(restoreMessage('root'))).record);

  // A fresh VM has no JS globals from its predecessor. Only Chrome's session
  // and local storage survive this simulated service-worker suspension.
  const restartedWorker = worker({ storage: firstWorker.chrome.storage });
  const embedded = contentSender({ frameId: 7, url: PAGE_URL });
  assert.equal((await restartedWorker.send(restoreMessage('embedded'), embedded)).record, null);
  assert.ok((await restartedWorker.send(restoreMessage('root'))).record);

  await restartedWorker.chrome.tabs.onRemoved.emit(12);
  await restartedWorker.idle();
  const afterTabClosure = worker({ storage: firstWorker.chrome.storage });
  assert.ok((await afterTabClosure.send(restoreMessage('embedded'), embedded)).record);
});

test('only activated-page navigation releases selection and notifies that tab using the browser URL', async () => {
  for (const newUrl of ['https://example.com/watch?id=next', 'https://example.com/#/watch/next']) {
    const app = worker();
    await app.send(saveMessage('root'));
    const nextSender = contentSender({ frameId: 7, tab: { id: 12, url: newUrl, incognito: false } });
    const nextIdentity = identity('next-embedded', { topUrl: newUrl });
    app.chrome.tabs.get = async tabId => ({ id: tabId, url: newUrl, incognito: false });
    await app.send(saveMessage('next-embedded', { identity: nextIdentity }), nextSender);
    assert.ok((await app.send(restoreMessage('root'))).record);
    for (const name of ['onCommitted', 'onHistoryStateUpdated', 'onReferenceFragmentUpdated']) {
      assert.equal(app.chrome.webNavigation[name].listeners.length, 0);
      await app.chrome.webNavigation[name].emit({ tabId: 999, frameId: 0, url: 'https://unrelated.example/' });
    }
    await app.idle();
    assert.equal(app.sentToTabs.length, 0, 'unrelated browsing must not wake frame coordination');
    app.chrome.tabs.get = async tabId => ({ id: tabId, url: newUrl, incognito: false });
    assert.equal((await app.send({ type: 'CD_NAVIGATED', url: 'https://forged.example/', tabId: 999 }, contentSender({ url: newUrl, tab: { id: 12, url: newUrl, incognito: false } }))).ok, true);
    const topToken = await Core.topToken(newUrl);
    assert.deepEqual(app.sentToTabs.map(({ tabId, message, details }) => ({
      tabId, frameId: details.frameId, type: message.type, topToken: message.topToken,
    })).sort((a, b) => a.frameId - b.frameId), [
      { tabId: 12, frameId: 0, type: 'CD_CHECK_RESTORE', topToken },
      { tabId: 12, frameId: 7, type: 'CD_CHECK_RESTORE', topToken },
    ]);
    assert.equal(JSON.stringify(app.sentToTabs).includes(newUrl), false);
    assert.ok((await app.send({ type: 'CD_RESTORE', identity: nextIdentity }, nextSender)).record);
  }
});

test('automatic registration includes only enabled and permitted origins, and revocation removes it', async () => {
  const enabled = 'https://enabled.example/*';
  const revoked = 'https://revoked.example/*';
  const grantedOnly = 'https://granted-only.example/*';
  const app = worker({
    local: { 'cd:auto-sites': [enabled, revoked] },
    permitted: [enabled, grantedOnly],
    scripts: [{ id: 'cd-old-obsolete', matches: [revoked] }, { id: 'unrelated-script', matches: ['https://unrelated.example/*'] }],
  });
  assert.equal((await app.send({ type: 'CD_SYNC_SITES' }, uiSender)).ok, true);
  let ownScripts = [...app.scripts.values()].filter((script) => script.id.startsWith('cd-'));
  assert.deepEqual(ownScripts.flatMap((script) => script.matches), [enabled]);
  assert.ok(app.scripts.has('unrelated-script'));
  assert.equal((await app.send({ type: 'CD_ENABLE_AUTO', origins: [grantedOnly] }, uiSender)).ok, true);
  ownScripts = [...app.scripts.values()].filter((script) => script.id.startsWith('cd-'));
  assert.deepEqual(ownScripts.flatMap((script) => script.matches).sort(), [enabled, grantedOnly].sort());
  app.permitted.delete(enabled);
  await app.chrome.permissions.onRemoved.emit({ origins: [enabled] });
  // The event deliberately schedules work without holding Chrome's event open.
  // A subsequent sync joins the same queue and lets us await its completion.
  await app.send({ type: 'CD_SYNC_SITES' }, uiSender);
  ownScripts = [...app.scripts.values()].filter((script) => script.id.startsWith('cd-'));
  assert.deepEqual(ownScripts.flatMap((script) => script.matches), [grantedOnly]);
});

test('automatic loading requires granted access and rejects browser pages or wildcard requests', async () => {
  const app = worker();
  const ungranted = await app.send({ type: 'CD_ENABLE_AUTO', origins: ['https://example.com/*'] }, uiSender);
  assert.equal(ungranted.ok, false);
  assert.match(ungranted.error, /access/i);
  const invalid = await app.send({ type: 'CD_ENABLE_AUTO', origins: ['chrome://extensions/*', '*://*/*'] }, uiSender);
  assert.equal(invalid.ok, false);
  assert.equal(app.scripts.size, 0);
  assert.equal(Object.values(app.local.data).some(value => value?.text), false);
});

test('page context reports automatic loading only while its enabled origin still has access', async () => {
  const origin = 'https://example.com/*';
  const app = worker({ local: { 'cd:auto-sites': [origin] }, permitted: [origin] });
  const allowed = await app.send({ type: 'CD_CONTEXT' });
  assert.equal(allowed.autoEnabled, true);
  assert.equal(allowed.topToken, await Core.topToken('https://example.com/watch?id=one'));
  app.permitted.delete(origin);
  assert.equal((await app.send({ type: 'CD_CONTEXT' })).autoEnabled, false);
});

test('the extension interface remains authorized when Chrome opens it in a browser tab', async () => {
  const app = worker({ permitted: ['https://example.com/*'] });
  const extensionTab = { ...uiSender, tab: { id: 80, url: uiSender.url, incognito: false } };
  assert.equal((await app.send({ type: 'CD_ENABLE_AUTO', origins: ['https://example.com/*'] }, extensionTab)).ok, true);
  assert.equal(app.scripts.size, 1);
});

test('the secure subtitle picker opens an extension window targeted only from trusted sender fields', async () => {
  const app = worker();
  const sender = contentSender({ frameId: 7 });
  const result = await app.send({ type: 'CD_OPEN_PICKER', videoId: 'cd-video-12', tabId: 999, frameId: 400 }, sender);
  assert.deepEqual(result, { ok: true });
  assert.equal(app.createdWindows.length, 1);
  const created = app.createdWindows[0];
  const url = new URL(created.url);
  assert.equal(url.protocol, 'chrome-extension:');
  assert.equal(url.host, EXTENSION_ID);
  assert.equal(url.pathname, '/popup.html');
  assert.deepEqual(Object.fromEntries(url.searchParams), { tabId: '12', frameId: '7', videoId: 'cd-video-12' });
  assert.deepEqual({ ...created, url: undefined }, { url: undefined, type: 'popup', width: 400, height: 620, incognito: false });
  assert.equal(app.sentToTabs.length, 0);
});

test('the secure subtitle picker preserves incognito context and rejects invalid callers or video IDs', async () => {
  const app = worker();
  const privateSender = contentSender({ tab: { id: 25, incognito: true }, frameId: 0 });
  assert.equal((await app.send({ type: 'CD_OPEN_PICKER', videoId: 'cd-video-1' }, privateSender)).ok, true);
  assert.equal(app.createdWindows[0].incognito, true);
  const invalid = [
    [{ type: 'CD_OPEN_PICKER', videoId: 'cd-video-1' }, uiSender],
    [{ type: 'CD_OPEN_PICKER', videoId: 'cd-video-1' }, contentSender({ frameId: -1 })],
    [{ type: 'CD_OPEN_PICKER', videoId: 'cd-video-1' }, contentSender({ tab: { id: -1 } })],
    [{ type: 'CD_OPEN_PICKER', videoId: '../popup.html' }, contentSender()],
    [{ type: 'CD_OPEN_PICKER', videoId: 'cd-video-1&tabId=999' }, contentSender()],
  ];
  for (const [message, sender] of invalid) assert.equal((await app.send(message, sender)).ok, false);
  assert.equal(await app.send({ type: 'CD_OPEN_PICKER', videoId: 'cd-video-1' }, { ...contentSender(), id: 'other-extension' }), undefined);
  assert.equal(app.createdWindows.length, 1);
});

test('website content cannot invoke privileged toolbar actions or impersonate another extension', async () => {
  const app = worker({ permitted: ['https://example.com/*'] });
  const response = await app.send({ type: 'CD_ENABLE_AUTO', origins: ['https://example.com/*'] });
  assert.equal(response.ok, false);
  assert.match(response.error, /toolbar|CaptionDrop/i);
  assert.equal(await app.send(saveMessage('foreign'), { ...contentSender(), id: 'other-extension' }), undefined);
  assert.equal(app.scripts.size, 0);
  assert.equal(Object.keys(app.local.data).length, 0);
});

test('provider save, restore, update and forget use the current document URL after history navigation', async () => {
  for (const pageUrl of ['https://www.youtube.com/watch?v=nextVideo123', 'https://www.bilibili.com/video/BV1GJ411x7h7/?p=2']) {
    const app = worker();
    const sender = contentSender(); // Chrome's sender URL and tab snapshot stay stale.
    app.chrome.webNavigation.getFrame = async details => {
      assert.deepEqual({ ...details }, { documentId: sender.documentId, tabId: sender.tab.id, frameId: sender.frameId });
      return { documentId: sender.documentId, documentLifecycle: 'active', url: pageUrl };
    };
    const videoIdentity = identity('next', { pageUrl, topUrl: pageUrl });
    assert.equal((await app.send(saveMessage('next', { identity: videoIdentity }), sender)).ok, true);
    assert.equal((await app.send({ type: 'CD_RESTORE', identity: videoIdentity }, sender)).record.text, SMALL_SRT);
    assert.equal((await app.send({ type: 'CD_UPDATE', identity: videoIdentity, style: { size: 48 } }, sender)).saved, true);
    assert.equal((await app.send({ type: 'CD_RESTORE', identity: videoIdentity }, sender)).record.style.size, 48);
    assert.equal((await app.send({ type: 'CD_FORGET', identity: videoIdentity }, sender)).ok, true);
  }
});

test('missing, replaced, cached and discarded documents cannot access saved captions', async () => {
  const app = worker();
  await app.send(saveMessage('document'));
  const before = structuredClone(app.local.data);
  for (const frame of [null, { documentId: 'different-document', url: PAGE_URL, documentLifecycle: 'active' },
    { documentId: 'current-document', url: PAGE_URL, documentLifecycle: 'cached' }]) {
    app.chrome.webNavigation.getFrame = async () => frame;
    for (const message of [restoreMessage('document'), saveMessage('document'),
      { type: 'CD_UPDATE', identity: identity('document') }, { type: 'CD_FORGET', identity: identity('document') }]) {
      assert.equal((await app.send(message)).ok, false);
    }
  }
  app.chrome.webNavigation.getFrame = async () => { throw new Error('No such document'); };
  assert.equal((await app.send(restoreMessage('document'))).ok, false);
  assert.deepEqual(app.local.data, before);
});

test('settings updates read and write only metadata while preserving the subtitle and prior appearance', async () => {
  const app = worker();
  await app.send(saveMessage('large', { text: `${SMALL_SRT}${'x'.repeat(1000000)}` }));
  const keysRead = [];
  const writes = [];
  const get = app.local.get.bind(app.local);
  const set = app.local.set.bind(app.local);
  app.local.get = async keys => { keysRead.push(keys); return get(keys); };
  app.local.set = async values => { writes.push(structuredClone(values)); return set(values); };
  assert.equal((await app.send({ type: 'CD_UPDATE', identity: identity('large'), enabled: false })).saved, true);
  assert.equal(keysRead.flat().some(key => key === null || key.startsWith('cd:caption:')), false);
  assert.ok(Buffer.byteLength(JSON.stringify(writes)) < 2000);
  const restored = await app.send(restoreMessage('large'));
  assert.equal(restored.record.style.size, 32);
  assert.equal(restored.record.enabled, false);
  assert.equal(restored.record.text.length, SMALL_SRT.length + 1000000);
});

test('a migrated worker restart reads the schema marker without reading every subtitle', async () => {
  const first = worker();
  await first.send(saveMessage('restart'));
  const reads = [];
  const get = first.local.get.bind(first.local);
  first.local.get = async keys => { reads.push(keys); return get(keys); };
  const next = worker({ storage: first.chrome.storage });
  await next.idle();
  assert.deepEqual(reads, ['cd:storage-version']);
  assert.equal((await next.send(restoreMessage('restart'))).record.text, SMALL_SRT);
});

test('quota errors retry with atomic eviction and remove matching appearance metadata', async () => {
  const app = worker();
  for (let i = 0; i < 3; i++) await app.send(saveMessage(`quota-${i}`));
  const oldest = app.local.data['cd:index'][0].key;
  const oldestSettings = oldest.replace(':caption:', ':settings:');
  const set = app.local.set.bind(app.local);
  let attempts = 0;
  app.local.set = async values => {
    attempts++;
    if (values[oldest] !== null) throw new Error('Resource::kQuotaBytes quota exceeded');
    assert.equal(values[oldestSettings], null);
    return set(values);
  };
  assert.equal((await app.send(saveMessage('quota-new'))).saved, true);
  assert.equal(attempts, 2);
  assert.equal(app.local.data[oldest], undefined);
  assert.equal(app.local.data[oldestSettings], undefined);
  assert.equal((await app.send(restoreMessage('quota-new'))).record.text, SMALL_SRT);
});

test('Incognito cannot persist automatic-loading preferences through either worker', async () => {
  for (const incognito of [false, true]) {
    const app = worker({ incognito, permitted: ['https://example.com/*'] });
    await app.idle();
    const before = structuredClone(app.local.data);
    const sender = { ...uiSender, tab: { id: 15, incognito: true } };
    const response = await app.send({ type: 'CD_ENABLE_AUTO', origins: ['https://example.com/*'] }, sender);
    assert.equal(response.ok, false);
    assert.match(response.error, /private windows/);
    assert.deepEqual(app.local.data, before);
    assert.equal(app.scripts.size, 0);
  }
});

test('manual loading resolves and reserves the real document when the caller omits documentId', async () => {
  const app = worker();
  app.chrome.webNavigation.getFrame = async details => ({ documentId: 'loaded-document', url: PAGE_URL, documentLifecycle: 'active' });
  const result = await app.send({ type: 'CD_LOAD_VIDEO', tabId: 12, frameId: 7, videoId: 'cd-video-1', text: SMALL_SRT }, uiSender);
  assert.equal(result.ok, true);
  assert.equal(app.session.data['cd:selection-document:12'], 'loaded-document');
  assert.deepEqual(app.sentToTabs[0].details, { frameId: 7, documentId: 'loaded-document' });
});

test('context initialization preserves an embedded reservation and replaced documents release it', async () => {
  const app = worker();
  await app.send(saveMessage('embedded'));
  await app.send(restoreMessage('embedded'), contentSender({ frameId: 7 }));
  await app.send({ type: 'CD_CONTEXT' });
  assert.equal(app.session.data['cd:selection:12'], 7);
  assert.equal((await app.send(restoreMessage('embedded'))).retry, true);
  app.chrome.webNavigation.getAllFrames = async () => [{ frameId: 0, documentId: 'current-document', url: PAGE_URL },
    { frameId: 7, documentId: 'replacement-document', url: PAGE_URL }];
  assert.equal((await app.send(restoreMessage('embedded'))).record.text, SMALL_SRT);
});

test('batched restore finds a saved candidate and rejects malformed or cross-page batches', async () => {
  const app = worker();
  await app.send(saveMessage('saved'));
  const batch = await app.send({ type: 'CD_RESTORE_BATCH', identities: [identity('missing'), identity('saved')] });
  assert.equal(batch.identity, identity('saved'));
  assert.equal(batch.record.text, SMALL_SRT);
  const crossPage = identity('other', { pageUrl: 'https://other.example/', topUrl: 'https://other.example/' });
  for (const identities of [[], ['invalid'], [identity('saved'), crossPage], Array(257).fill(identity('saved'))]) {
    const response = await app.send({ type: 'CD_RESTORE_BATCH', identities });
    assert.equal(response.ok, false);
    assert.equal(response.record, undefined);
  }
});

function assertConsistentIndex(data) {
  const index = data['cd:index'];
  assert.ok(Array.isArray(index), 'the index must be an array');
  const keys = index.map(item => item.key);
  assert.equal(new Set(keys).size, keys.length, 'index keys must be unique');
  for (const item of index) {
    assert.match(item.key, /^cd:caption:[0-9a-f]{64}$/);
    assert.equal(typeof data[item.key]?.text, 'string', 'every indexed record must exist');
    assert.ok(Number.isFinite(item.bytes) && item.bytes > 0);
  }
  const unlisted = Object.keys(data).filter(key => /^cd:caption:/.test(key) && data[key] !== null && !keys.includes(key));
  assert.deepEqual(unlisted, [], 'saved records must not become unreachable');
}

test('a damaged index is rebuilt from saved records instead of blocking memory or orphaning captions', async () => {
  const base = worker();
  await base.send(saveMessage('first'));
  await base.send(saveMessage('second'));
  const saved = structuredClone(base.local.data);
  const index = saved['cd:index'];
  for (const damaged of [[null, ...index], { not: 'an array' }, 'garbage', [{ bytes: 10 }, ...index],
    [{ ...index[0], bytes: 1e308 }, index[1]], [{ ...index[0], bytes: -5 }, index[1]], [...index, ...index]]) {
    const app = worker({ local: { ...structuredClone(saved), 'cd:index': structuredClone(damaged) } });
    assert.equal((await app.send(restoreMessage('second'))).record?.fileName, 'second.srt', JSON.stringify(damaged).slice(0, 80));
    assert.deepEqual(await app.send(saveMessage('third')), { ok: true, saved: true });
    assert.equal((await app.send(restoreMessage('first'))).record?.fileName, 'first.srt');
    assert.equal((await app.send({ type: 'CD_FORGET', identity: identity('third') })).ok, true);
    assertConsistentIndex(app.local.data);
  }
});

test('a missing index is rebuilt before restoring or saving captions', async () => {
  const base = worker();
  await base.send(saveMessage('first'));
  await base.send(saveMessage('second'));
  const saved = structuredClone(base.local.data);
  delete saved['cd:index'];
  for (const action of ['restore', 'save']) {
    const app = worker({ local: saved });
    if (action === 'restore') assert.equal((await app.send(restoreMessage('first'))).record?.fileName, 'first.srt');
    else assert.equal((await app.send(saveMessage('third'))).saved, true);
    for (const name of ['first', 'second']) {
      assert.equal((await app.send(restoreMessage(name))).record?.fileName, `${name}.srt`);
    }
    assertConsistentIndex(app.local.data);
  }
});

test('a damaged index drops unreadable records and their orphaned appearance metadata', async () => {
  const base = worker();
  await base.send(saveMessage('readable'));
  await base.send(saveMessage('unreadable'));
  const data = structuredClone(base.local.data);
  const unreadable = `cd:caption:${await Core.hashKey(identity('unreadable'))}`;
  data[unreadable].text = 12345;
  data['cd:settings:' + 'f'.repeat(64)] = { style: Core.DEFAULT_STYLE };
  data['cd:index'] = 'garbage';
  const app = worker({ local: data });
  assert.equal((await app.send(restoreMessage('readable'))).record?.fileName, 'readable.srt');
  assert.equal(app.local.data[unreadable], undefined);
  assert.equal(app.local.data[unreadable.replace(':caption:', ':settings:')], undefined);
  assert.equal(app.local.data['cd:settings:' + 'f'.repeat(64)], undefined);
  assertConsistentIndex(app.local.data);
});

test('same-scope records missing from the index are cleared before listed captions under quota pressure', async () => {
  const app = worker();
  for (let i = 0; i < 3; i += 1) await app.send(saveMessage(`listed-${i}`));
  const orphan = `cd:caption:${'0'.repeat(64)}`;
  app.local.data[orphan] = { text: SMALL_SRT, fileName: 'orphan.srt', scope: app.local.data['cd:index'][0].scope };
  app.local.data[orphan.replace(':caption:', ':settings:')] = { style: Core.DEFAULT_STYLE };
  const set = app.local.set.bind(app.local);
  app.local.set = async values => {
    if (values[orphan] !== null) throw new Error('QUOTA_BYTES quota exceeded');
    return set(values);
  };
  assert.deepEqual(await app.send(saveMessage('new')), { ok: true, saved: true });
  assert.equal(app.local.data[orphan], undefined);
  assert.equal(app.local.data[orphan.replace(':caption:', ':settings:')], undefined);
  for (let i = 0; i < 3; i += 1) assert.equal((await app.send(restoreMessage(`listed-${i}`))).record?.fileName, `listed-${i}.srt`);
});

test('quota cleanup preserves unowned and other-site stray captions', async () => {
  const app = worker();
  await app.send(saveMessage('victim-stray'));
  const victimScope = app.local.data['cd:index'][0].scope;
  const unknown = `cd:caption:${'0'.repeat(64)}`;
  const otherSite = `cd:caption:${'1'.repeat(64)}`;
  app.local.data[unknown] = { text: SMALL_SRT, fileName: 'unknown.srt' };
  app.local.data[otherSite] = { text: SMALL_SRT, fileName: 'other-site.srt', scope: victimScope };
  for (const key of [unknown, otherSite]) app.local.data[key.replace(':caption:', ':settings:')] = { style: Core.DEFAULT_STYLE };
  const before = structuredClone(app.local.data);
  const set = app.local.set.bind(app.local);
  let attempts = 0;
  app.local.set = async values => {
    attempts++;
    for (const key of [unknown, otherSite]) {
      assert.equal(Object.hasOwn(values, key), false, 'cleanup must not clear unowned or other-site subtitles');
      assert.equal(Object.hasOwn(values, key.replace(':caption:', ':settings:')), false);
    }
    if (values[unknown] !== null || values[otherSite] !== null) throw new Error('QUOTA_BYTES quota exceeded');
    return set(values);
  };
  const pageUrl = 'https://compromised.example/watch';
  const sender = contentSender({ url: pageUrl, tab: { id: 99, url: pageUrl, incognito: false } });
  const response = await app.send(saveMessage('forged-stray', { identity: identity('forged-stray', { pageUrl, topUrl: pageUrl }) }), sender);
  assert.equal(response.ok, false);
  assert.match(response.error, /memory is full/i);
  assert.equal(attempts, 1);
  assert.deepEqual(app.local.data, before);
});

test('storage written by a newer version is left untouched while page-only captions keep working', async () => {
  const key = `cd:caption:${await Core.hashKey(identity('future'))}`;
  const initial = { 'cd:storage-version': 4, [key]: { text: SMALL_SRT, fileName: 'future.srt', futureField: 'keep' },
    'cd:index': [{ key, bytes: 100, updatedAt: 1, futureField: 'keep' }] };
  const app = worker({ local: initial });
  const restored = await app.send(restoreMessage('future'));
  assert.equal(restored.ok, false);
  assert.match(restored.error, /newer CaptionDrop version/);
  assert.equal((await app.send(saveMessage('future'))).ok, false);
  assert.deepEqual(app.local.data, initial);
  assert.equal((await app.send({ type: 'CD_SCAN', tabId: 12 }, uiSender)).ok, true);
  assert.equal((await app.send({ type: 'CD_LOAD_VIDEO', tabId: 12, frameId: 0, videoId: 'cd-video-1', text: SMALL_SRT }, uiSender)).ok, true);
});

test('the subtitle picker reuses one window and coalesces repeated requests from a tab', async () => {
  const app = worker();
  const first = contentSender();
  for (let i = 0; i < 10; i += 1) assert.deepEqual(await app.send({ type: 'CD_OPEN_PICKER', videoId: 'cd-video-1' }, first), { ok: true });
  assert.equal(app.createdWindows.length, 1);
  const second = contentSender({ tab: { id: 13, url: PAGE_URL, incognito: false } });
  assert.deepEqual(await app.send({ type: 'CD_OPEN_PICKER', videoId: 'cd-video-2' }, second), { ok: true });
  assert.equal(app.createdWindows.length, 1, 'an open picker is reused');
  assert.equal(app.updatedTabs.length, 1);
  assert.deepEqual(Object.fromEntries(new URL(app.updatedTabs[0].url).searchParams), { tabId: '13', frameId: '0', videoId: 'cd-video-2' });
  assert.deepEqual(app.focusedWindows, [{ windowId: 80, focused: true }]);
  app.openWindows.clear();
  const third = contentSender({ tab: { id: 14, url: PAGE_URL, incognito: false } });
  assert.deepEqual(await app.send({ type: 'CD_OPEN_PICKER', videoId: 'cd-video-3' }, third), { ok: true });
  assert.equal(app.createdWindows.length, 2, 'a closed picker is replaced');
});

test('rapid navigation notices prompt frames once at once and once more with the latest page', async () => {
  const app = worker();
  let url = PAGE_URL;
  app.chrome.tabs.get = async tabId => ({ id: tabId, url, incognito: false });
  for (const id of ['two', 'three', 'four']) {
    url = `https://example.com/watch?id=${id}`;
    assert.equal((await app.send({ type: 'CD_NAVIGATED' })).ok, true);
  }
  const prompts = () => app.sentToTabs.filter(item => item.message.type === 'CD_CHECK_RESTORE').map(item => item.message.topToken);
  assert.deepEqual(prompts(), Array(2).fill(await Core.topToken('https://example.com/watch?id=two')));
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.deepEqual(prompts().slice(2), Array(2).fill(await Core.topToken('https://example.com/watch?id=four')));
  assert.equal(prompts().length, 4);
});

test('embedded frames can name their top page by token and reach the same saved captions', async () => {
  const app = worker();
  const embed = 'https://player.example.org/embed/one';
  const sender = contentSender({ frameId: 7, url: embed });
  app.chrome.webNavigation.getAllFrames = async () => [{ frameId: 0, url: PAGE_URL }, { frameId: 7, url: embed }];
  const src = 'https://cdn.example.com/embedded.mp4';
  const full = Core.videoKey({ pageUrl: embed, topUrl: PAGE_URL, src });
  const tokenized = Core.videoKey({ pageUrl: embed, topToken: await Core.topToken(PAGE_URL), src });
  assert.equal(tokenized.includes('example.com/watch'), false);
  assert.deepEqual(await app.send(saveMessage('embedded', { identity: tokenized }), sender), { ok: true, saved: true });
  assert.equal((await app.send({ type: 'CD_RESTORE', identity: full }, sender)).record.fileName, 'embedded.srt');
  const batch = await app.send({ type: 'CD_RESTORE_BATCH', identities: [tokenized] }, sender);
  assert.equal(batch.identity, tokenized);
  assert.equal(batch.record.fileName, 'embedded.srt');
  const otherTop = Core.videoKey({ pageUrl: embed, topToken: await Core.topToken('https://other.example/'), src });
  assert.match((await app.send({ type: 'CD_RESTORE', identity: otherTop }, sender)).error, /current page/);
  const topFrameToken = Core.videoKey({ pageUrl: PAGE_URL, topToken: await Core.topToken(PAGE_URL), src });
  assert.match((await app.send({ type: 'CD_RESTORE', identity: topFrameToken })).error, /current page/);
});
