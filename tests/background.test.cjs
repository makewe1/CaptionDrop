'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const EXTENSION_ID = 'captiondrop-test-extension';
const SMALL_SRT = '1\n00:00:00,000 --> 00:00:05,000\nHello captions';
const identity = (name) => JSON.stringify(['captiondrop-test-video', name]);
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
      async get(tabId) { return { id: tabId, url: 'https://example.com/watch?id=one', incognito: false }; },
      async sendMessage(tabId, message, details) {
        sentToTabs.push(structuredClone({ tabId, message, details }));
        return { ok: true, videos: [] };
      },
      onRemoved: makeEvent(),
    },
    webNavigation: {
      async getAllFrames() { return [{ frameId: 0, url: 'https://example.com/watch?id=one' }, { frameId: 7, url: 'https://player.example.org/embed/one' }]; },
      onCommitted: makeEvent(),
      onHistoryStateUpdated: makeEvent(),
      onReferenceFragmentUpdated: makeEvent(),
    },
    windows: { async getAll() { return structuredClone(windows); }, onRemoved: makeEvent() },
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
    chrome, local, session, permitted, scripts, sentToTabs, send,
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
  assert.ok(indexes[0].every((item) => app.local.data[item.key]?.identity));
});

test('Incognito memory uses session storage, stays separate, and clears after the last private window', async () => {
  const app = worker({ session: { unrelatedSessionValue: 'keep me' } });
  const privateSender = contentSender({ tab: { id: 25, url: 'https://example.com/watch?id=one', incognito: true } });
  const privateText = SMALL_SRT.replace('Hello captions', 'Private captions');
  await app.send(saveMessage('shared-identity'));
  await app.send(saveMessage('shared-identity', { text: privateText }), privateSender);
  assert.equal((await app.send(restoreMessage('shared-identity'))).record.text, SMALL_SRT);
  assert.equal((await app.send(restoreMessage('shared-identity'), privateSender)).record.text, privateText);
  assert.equal(JSON.stringify(app.local.data).includes('Private captions'), false);
  assert.equal(JSON.stringify(app.session.data).includes('Private captions'), true);
  app.setWindows([{ id: 1, incognito: false }, { id: 2, incognito: true }]);
  await app.chrome.windows.onRemoved.emit(3);
  assert.equal((await app.send(restoreMessage('shared-identity'), privateSender)).record.text, privateText);
  app.setWindows([{ id: 1, incognito: false }]);
  await app.chrome.windows.onRemoved.emit(2);
  assert.equal((await app.send(restoreMessage('shared-identity'), privateSender)).record, null);
  assert.equal(app.session.data.unrelatedSessionValue, 'keep me');
  assert.equal((await app.send(restoreMessage('shared-identity'))).record.text, SMALL_SRT);
});

test('an Incognito worker keeps memory private even without an Incognito flag on its sender tab', async () => {
  const app = worker({ incognito: true });
  await app.send(saveMessage('split-worker'));
  assert.equal(Object.keys(app.local.data).length, 0);
  assert.equal((await app.send(restoreMessage('split-worker'))).record.fileName, 'split-worker.srt');
  assert.ok(Object.keys(app.session.data).length > 0);
});

test('automatic restore reserves one frame per tab and releases it on root navigation or tab closure', async () => {
  const app = worker();
  await app.send(saveMessage('root'));
  await app.send(saveMessage('embedded'));
  const root = contentSender();
  const embedded = contentSender({ frameId: 7, url: 'https://player.example.org/embed/one' });
  const otherTab = contentSender({ frameId: 7, tab: { id: 99, url: 'https://example.com/watch?id=one', incognito: false } });
  assert.ok((await app.send(restoreMessage('root'), root)).record);
  assert.equal((await app.send(restoreMessage('embedded'), embedded)).record, null);
  assert.ok((await app.send(restoreMessage('embedded'), otherTab)).record, 'other tabs have independent reservations');
  await app.chrome.webNavigation.onCommitted.emit({ tabId: 12, frameId: 7 });
  assert.equal((await app.send(restoreMessage('embedded'), embedded)).record, null, 'subframe navigation must not clear the root reservation');
  await app.chrome.webNavigation.onCommitted.emit({ tabId: 12, frameId: 0 });
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

test('frame reservations survive a service-worker restart while the selected page stays open', async () => {
  const firstWorker = worker();
  await firstWorker.send(saveMessage('root'));
  await firstWorker.send(saveMessage('embedded'));
  assert.ok((await firstWorker.send(restoreMessage('root'))).record);

  // A fresh VM has no JS globals from its predecessor. Only Chrome's session
  // and local storage survive this simulated service-worker suspension.
  const restartedWorker = worker({ storage: firstWorker.chrome.storage });
  const embedded = contentSender({ frameId: 7, url: 'https://player.example.org/embed/one' });
  assert.equal((await restartedWorker.send(restoreMessage('embedded'), embedded)).record, null);
  assert.ok((await restartedWorker.send(restoreMessage('root'))).record);

  await restartedWorker.chrome.tabs.onRemoved.emit(12);
  await restartedWorker.idle();
  const afterTabClosure = worker({ storage: firstWorker.chrome.storage });
  assert.ok((await afterTabClosure.send(restoreMessage('embedded'), embedded)).record);
});

test('top-level SPA and fragment navigation release selection and notify every frame of the new page', async () => {
  for (const eventName of ['onHistoryStateUpdated', 'onReferenceFragmentUpdated']) {
    const app = worker();
    await app.send(saveMessage('root'));
    await app.send(saveMessage('next-embedded'));
    assert.ok((await app.send(restoreMessage('root'))).record);
    const embedded = contentSender({ frameId: 7, url: 'https://player.example.org/embed/one' });
    const newUrl = eventName === 'onHistoryStateUpdated'
      ? 'https://example.com/watch?id=next' : 'https://example.com/#/watch/next';
    await app.chrome.webNavigation[eventName].emit({ tabId: 12, frameId: 7, url: newUrl });
    await app.idle();
    assert.equal(app.sentToTabs.length, 0, `${eventName}: subframe navigation must not notify all frames`);
    assert.equal((await app.send(restoreMessage('next-embedded'), embedded)).record, null);

    await app.chrome.webNavigation[eventName].emit({ tabId: 12, frameId: 0, url: newUrl });
    await app.idle();
    assert.deepEqual(app.sentToTabs.map(({ tabId, message, details }) => ({
      tabId, frameId: details.frameId, type: message.type, topUrl: message.topUrl,
    })).sort((a, b) => a.frameId - b.frameId), [
      { tabId: 12, frameId: 0, type: 'CD_CHECK_RESTORE', topUrl: newUrl },
      { tabId: 12, frameId: 7, type: 'CD_CHECK_RESTORE', topUrl: newUrl },
    ]);
    assert.ok((await app.send(restoreMessage('next-embedded'), embedded)).record, `${eventName}: old reservation is released`);
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

test('website content cannot invoke privileged toolbar actions or impersonate another extension', async () => {
  const app = worker({ permitted: ['https://example.com/*'] });
  const response = await app.send({ type: 'CD_ENABLE_AUTO', origins: ['https://example.com/*'] });
  assert.equal(response.ok, false);
  assert.match(response.error, /toolbar|CaptionDrop/i);
  assert.equal(await app.send(saveMessage('foreign'), { ...contentSender(), id: 'other-extension' }), undefined);
  assert.equal(app.scripts.size, 0);
  assert.equal(Object.keys(app.local.data).length, 0);
});
