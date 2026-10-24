import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { prepareProfile } from './chrome-support.mjs';

// Exercise Chrome's actual split Incognito context, never a user's profile.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(path.join(root, 'package.json'))('playwright');
const profile = await mkdtemp(path.join(tmpdir(), 'captiondrop-private-profile-'));
const extensionRoot = await mkdtemp(path.join(tmpdir(), 'captiondrop-private-extension-'));
const privateFile = 'PRIVATE-caption-file-do-not-retain.srt';
const privateText = '1\n00:00:00,000 --> 00:10:00,000\nPRIVATE-caption-text-do-not-retain';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let context;
let browserSession;
let messageId = 0;
let extensionId;
let server;
let passed = 0;

async function eventually(read, predicate, label, timeout = 10000) {
  let last;
  // The monotonic clock keeps waits correct when the system clock is adjusted.
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    try { last = await read(); if (predicate(last)) return last; }
    catch (error) { last = error.message; }
    await delay(100);
  }
  assert.fail(`${label}: ${JSON.stringify(last)}`);
}
function pass(label) { passed++; console.log(`PASS ${label}`); }

// Playwright exposes its normal persistent context. Browser CDP also reaches
// the separate Incognito worker and pages without merging their contexts.
async function evalTarget(targetId, expression) {
  const { sessionId } = await browserSession.send('Target.attachToTarget', { targetId, flatten: false });
  const id = ++messageId;
  let timer;
  let listener;
  try {
    const pending = new Promise((resolve, reject) => {
      listener = event => {
        if (event.sessionId !== sessionId) return;
        const message = JSON.parse(event.message);
        if (message.id !== id) return;
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else if (message.result.exceptionDetails) reject(new Error(JSON.stringify(message.result.exceptionDetails)));
        else resolve(message.result.result.value);
      };
      browserSession.on('Target.receivedMessageFromTarget', listener);
      timer = setTimeout(() => reject(new Error('Private-context Runtime evaluation timed out')), 10000);
    });
    await browserSession.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({
      id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true }
    }) });
    return await pending;
  } finally {
    clearTimeout(timer);
    if (listener) browserSession.off('Target.receivedMessageFromTarget', listener);
    await browserSession.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}
async function workerTargets() {
  const { targetInfos } = await browserSession.send('Target.getTargets');
  const targets = targetInfos.filter(target => target.type === 'service_worker' && target.url.startsWith(`chrome-extension://${extensionId}/`));
  const result = [];
  for (const target of targets) {
    try {
      const state = await evalTarget(target.targetId, `(async()=>({incognito:chrome.extension.inIncognitoContext,windows:(await chrome.windows.getAll()).map(window=>window.id)}))()`);
      result.push({ ...target, ...state });
    } catch { /* A worker can be replaced after enabling Incognito access. */ }
  }
  return result;
}
async function findWorker(incognito, windowId) {
  return eventually(async () => (await workerTargets()).find(target => target.incognito === incognito && target.windows.length > 0
    && (windowId === undefined || target.windows.includes(windowId))), Boolean, `No ${incognito ? 'private' : 'normal'} split worker`);
}
function workerMessage(worker, payload) {
  // Call the real coordinator in its real Chrome worker. Native picker UI is
  // covered by browser.mjs; this test focuses on split-context page/storage life.
  return evalTarget(worker.targetId, `handle(${JSON.stringify(payload)},{id:chrome.runtime.id,url:chrome.runtime.getURL('popup.html')})`);
}
function activeOn(worker, tabId) {
  return evalTarget(worker.targetId, `(async()=>{const result=await chrome.scripting.executeScript({target:{tabId:${tabId}},func:()=>globalThis.__captionDrop?.active||null});return result[0].result})()`);
}
async function assertNoPrivateStorage(label) {
  for (const worker of await workerTargets()) {
    const storage = await evalTarget(worker.targetId, `(async()=>({local:await chrome.storage.local.get(null),session:await chrome.storage.session.get(null)}))()`);
    const serialized = JSON.stringify(storage);
    for (const secret of [privateFile, 'PRIVATE-caption-text-do-not-retain', 'private-page-do-not-save']) {
      assert.equal(serialized.includes(secret), false, `${label}: ${worker.incognito ? 'private' : 'normal'} worker retained ${secret}`);
    }
    for (const [key, value] of Object.entries(storage.session)) {
      assert.equal(key.startsWith('cd:private:'), false, `${label}: private subtitle storage key survived`);
      assert.equal(Boolean(value?.text || value?.identity), false, `${label}: subtitle record found in session storage`);
    }
  }
}

try {
  for (const file of ['manifest.json', 'background.js', 'core.js', 'content.js', 'popup.html', 'popup.js', 'popup.css', 'icons']) {
    await cp(path.join(root, file), path.join(extensionRoot, file), { recursive: true });
  }
  const manifest = JSON.parse(await readFile(path.join(extensionRoot, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(path.join(extensionRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const media = await readFile(path.join(root, 'tests/fixtures/sample.mp4'));
  server = createServer((request, response) => {
    if (new URL(request.url, 'http://fixture').pathname === '/sample.mp4') {
      const match = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      if (match) {
        const start = Number(match[1]); const end = match[2] ? Math.min(Number(match[2]), media.length - 1) : media.length - 1;
        if (start > end || start >= media.length) { response.writeHead(416).end(); return; }
        response.writeHead(206, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${media.length}`, 'Content-Length': end - start + 1 });
        response.end(media.subarray(start, end + 1));
      } else { response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': media.length }); response.end(media); }
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><title>Private subtitle fixture</title><video id="primary" aria-label="Private fixture video" controls muted style="width:640px;height:360px" src="/sample.mp4"></video>');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const fixture = `http://127.0.0.1:${server.address().port}/private-page-do-not-save`;
  await prepareProfile(profile);
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CAPTIONDROP_BROWSER_PATH || '/usr/bin/google-chrome', headless: true,
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--no-sandbox', '--no-first-run', '--no-default-browser-check', '--enable-unsafe-extension-debugging', '--disable-features=DisableLoadExtensionCommandLineSwitch', `--load-extension=${extensionRoot}`]
  });
  const initialWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 7000 });
  extensionId = new URL(initialWorker.url()).host;
  browserSession = await context.browser().newBrowserCDPSession();
  const settings = await context.newPage(); await settings.goto('chrome://extensions');
  await settings.evaluate(extensionId => new Promise((resolve, reject) => {
    chrome.developerPrivate.updateExtensionConfiguration({ extensionId, incognitoAccess: true }, () =>
      chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve());
  }), extensionId);
  const wake = await context.newPage(); await wake.goto(`chrome-extension://${extensionId}/popup.html`);
  let normalWorker = await findWorker(false);

  async function openPrivate() {
    // Split mode may return null to the normal worker for a newly created
    // private window, even though Chrome created it successfully.
    const opened = await evalTarget(normalWorker.targetId, `(async()=>{const window=await chrome.windows.create({incognito:true,url:chrome.runtime.getURL('popup.html')});return window?{id:window.id,incognito:window.incognito}:null})()`);
    const worker = await findWorker(true, opened?.id);
    const windowId = opened?.id ?? worker.windows[0];
    const tab = await evalTarget(worker.targetId, `(async()=>{const tab=await chrome.tabs.create({windowId:${windowId},url:${JSON.stringify(fixture)}});return{id:tab.id,incognito:tab.incognito}})()`);
    assert.equal(tab.incognito, true);
    await eventually(() => evalTarget(worker.targetId, `chrome.tabs.get(${tab.id}).then(tab=>tab.status)`), status => status === 'complete', 'Private fixture did not load');
    return { worker, tabId: tab.id };
  }
  const privatePage = await openPrivate();
  const scan = await workerMessage(privatePage.worker, { type: 'CD_SCAN', tabId: privatePage.tabId });
  assert.equal(scan.incognito, true); assert.equal(scan.videos.length, 1);
  const loaded = await workerMessage(privatePage.worker, { type: 'CD_LOAD_VIDEO', tabId: privatePage.tabId, frameId: scan.videos[0].frameId,
    videoId: scan.videos[0].id, text: privateText, fileName: privateFile });
  assert.equal(loaded.ok, true); assert.equal(loaded.saved, false);
  await eventually(() => activeOn(privatePage.worker, privatePage.tabId), active => active?.text === 'PRIVATE-caption-text-do-not-retain', 'Private captions were not rendered');
  pass('Real split Incognito worker renders private captions in page memory');
  const privateAuto = await evalTarget(privatePage.worker.targetId, `(async()=>{
    const before=await chrome.storage.local.get('cd:auto-sites');
    let error;
    try { await handle({type:'CD_ENABLE_AUTO',tabId:${privatePage.tabId},origins:['http://127.0.0.1/*']},{id:chrome.runtime.id,url:chrome.runtime.getURL('popup.html')}); }
    catch (failure) { error=failure.message; }
    return {error,unchanged:JSON.stringify(before)===JSON.stringify(await chrome.storage.local.get('cd:auto-sites'))};
  })()`);
  assert.match(privateAuto.error, /private windows/);
  assert.equal(privateAuto.unchanged, true);
  const picker = await evalTarget(privatePage.worker.targetId, `(async()=>{
    const videoTab=await chrome.tabs.get(${privatePage.tabId});
    const tab=await chrome.tabs.create({windowId:videoTab.windowId,url:chrome.runtime.getURL('popup.html')+'?tabId=${privatePage.tabId}'});
    return {id:tab.id};
  })()`);
  const pickerUrl = `chrome-extension://${extensionId}/popup.html?tabId=${privatePage.tabId}`;
  const pickerTarget = await eventually(async () => (await browserSession.send('Target.getTargets')).targetInfos.find(target => target.url === pickerUrl
    && target.browserContextId === privatePage.worker.browserContextId), Boolean, 'Private picker did not open');
  await eventually(() => evalTarget(pickerTarget.targetId, `document.querySelector('#auto-load')?.disabled && document.querySelector('#memory-note')?.textContent.includes('Private captions')`), Boolean, 'Private automatic-loading button was enabled');
  await evalTarget(privatePage.worker.targetId, `chrome.tabs.remove(${picker.id}).then(()=>true)`);
  pass('Private automatic loading is disabled in the popup and rejected without persistent preferences');
  await delay(500); await assertNoPrivateStorage('after private load');
  pass('Neither worker stores private subtitle text, filename, or video identity in local/session storage');

  const extra = await evalTarget(normalWorker.targetId, `(async()=>{const window=await chrome.windows.create({url:'about:blank'});return window.id})()`);
  await evalTarget(normalWorker.targetId, `chrome.windows.remove(${extra}).then(()=>true)`);
  await delay(500);
  assert.equal((await activeOn(privatePage.worker, privatePage.tabId)).text, 'PRIVATE-caption-text-do-not-retain');
  await assertNoPrivateStorage('after normal window closes');
  pass('Closing a normal window preserves captions in the open private page');

  await evalTarget(privatePage.worker.targetId, `chrome.tabs.reload(${privatePage.tabId}).then(()=>true)`);
  await eventually(() => evalTarget(privatePage.worker.targetId, `chrome.tabs.get(${privatePage.tabId}).then(tab=>tab.status)`), status => status === 'complete', 'Reloaded private fixture did not finish');
  const rescanned = await workerMessage(privatePage.worker, { type: 'CD_SCAN', tabId: privatePage.tabId });
  assert.equal(rescanned.videos.length, 1); assert.equal(rescanned.videos[0].hasSubtitles, false);
  assert.equal(await activeOn(privatePage.worker, privatePage.tabId), null);
  await assertNoPrivateStorage('after private reload');
  pass('Reloading a private page discards its captions without restoration');

  const targets = (await browserSession.send('Target.getTargets')).targetInfos;
  const privateTargets = targets.filter(target => target.type === 'page' && target.browserContextId === privatePage.worker.browserContextId);
  assert.ok(privateTargets.length >= 1);
  for (const target of privateTargets) await browserSession.send('Target.closeTarget', { targetId: target.targetId });
  await eventually(async () => (await browserSession.send('Target.getTargets')).targetInfos.filter(target => target.type === 'page' && target.browserContextId === privatePage.worker.browserContextId).length,
    count => count === 0, 'The last private window did not close');
  normalWorker = await findWorker(false);
  const reopened = await openPrivate();
  const reopenedScan = await workerMessage(reopened.worker, { type: 'CD_SCAN', tabId: reopened.tabId });
  assert.equal(reopenedScan.videos[0].hasSubtitles, false);
  assert.equal(await activeOn(reopened.worker, reopened.tabId), null);
  await assertNoPrivateStorage('after private context reopens');
  pass('Closing and reopening the last private window cannot restore private captions');
  console.log(`${passed} Incognito checks passed; temporary profile and extension clone only.`);
} finally {
  await browserSession?.detach().catch(() => {});
  await context?.close().catch(() => {});
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
  await rm(extensionRoot, { recursive: true, force: true });
}
