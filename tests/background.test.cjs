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
      onRemoved: makeEvent(),
    },
    webNavigation: {
      async getAllFrames() { return [{ frameId: 0, url: 'https://example.com/watch?id=one' }, { frameId: 7, url: PAGE_URL }]; },
      onCommitted: makeEvent(),
      onHistoryStateUpdated: makeEvent(),
      onReferenceFragmentUpdated: makeEvent(),
    },
    windows: {
      async getAll() { return structuredClone(windows); },
      async create(options) { createdWindows.push(structuredClone(options)); return { id: 80 }; },
      onRemoved: makeEvent(),
    },
  };
  const context = vm.createContext({ chrome, URL, URLSearchParams, TextEncoder, TextDecoder, crypto: webcrypto, console });
  context.importScripts = (...files) => {
    for (const file of files) vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  async function send(message, sender = contentSender()) {
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
    chrome, local, session, permitted, scripts, sentToTabs, createdWindows, send,
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
  assert.equal(context.topUrl, PAGE_URL);
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
  assert.equal(app.local.data['cd:index'][0].bytes, Buffer.byteLength(JSON.stringify(app.local.data[key])));
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
  await app.idle();
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
  assert.equal(Object.keys(app.local.data).length, 0);
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

test('a permanent quota rejection leaves old records untouched instead of evicting before retrying', async () => {
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
  assert.match(result.error, /quota exceeded/);
  assert.equal(calls, 1);
  assert.deepEqual(app.local.data, original);
});

test('a quota-limited replacement succeeds after evicting only the required old record', async () => {
  const app = worker();
  for (let i = 0; i < 50; i += 1) await app.send(saveMessage(`existing-${i}`));
  const oldestKey = app.local.data['cd:index'][0].key;
  const size = data => Buffer.byteLength(JSON.stringify(data));
  const quota = size(app.local.data) + 128;
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
    assert.deepEqual(app.sentToTabs.map(({ tabId, message, details }) => ({
      tabId, frameId: details.frameId, type: message.type, topUrl: message.topUrl,
    })).sort((a, b) => a.frameId - b.frameId), [
      { tabId: 12, frameId: 0, type: 'CD_CHECK_RESTORE', topUrl: newUrl },
      { tabId: 12, frameId: 7, type: 'CD_CHECK_RESTORE', topUrl: newUrl },
    ]);
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
  assert.equal(Object.keys(app.local.data).length, 0);
});

test('page context reports automatic loading only while its enabled origin still has access', async () => {
  const origin = 'https://example.com/*';
  const app = worker({ local: { 'cd:auto-sites': [origin] }, permitted: [origin] });
  const allowed = await app.send({ type: 'CD_CONTEXT' });
  assert.equal(allowed.autoEnabled, true);
  assert.equal(allowed.topUrl, 'https://example.com/watch?id=one');
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
