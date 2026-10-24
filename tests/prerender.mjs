// Prerender activation probe without DevTools on any page target (DevTools
// attachment disables prerendering). Only the browser endpoint and the
// extension service worker are attached over raw CDP.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { prepareProfile } from './chrome-support.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = tmpdir();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = await mkdtemp(path.join(scratch, 'cd-raw-profile-'));
const extension = await mkdtemp(path.join(scratch, 'cd-raw-ext-'));
for (const file of ['manifest.json', 'background.js', 'core.js', 'content.js', 'popup.html', 'popup.js', 'popup.css', 'icons']) {
  await cp(path.join(ROOT, file), path.join(extension, file), { recursive: true });
}
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
const video = await readFile(path.join(ROOT, 'tests/fixtures/sample.mp4'));
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://x');
  if (url.pathname === '/sample.mp4') { response.writeHead(200, { 'Content-Type': 'video/mp4' }); response.end(video); return; }
  const pages = {
    '/start': `<!doctype html><meta charset=utf-8><body><a id=go href="/target">Watch</a>
<script type="speculationrules">{"prerender":[{"source":"list","urls":["/target"],"eagerness":"immediate"}]}</script>
<script>setTimeout(() => document.getElementById('go').click(), 4000);</script></body>`,
    '/target': `<!doctype html><meta charset=utf-8><body><video id=v src="/sample.mp4?prerender" controls muted playsinline preload=auto style="width:480px;height:270px"></video></body>`,
  };
  if (!pages[url.pathname]) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(pages[url.pathname]);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

await prepareProfile(profile);
const chrome = spawn(process.env.CAPTIONDROP_BROWSER_PATH || '/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--no-sandbox', '--enable-unsafe-extension-debugging', '--disable-features=DisableLoadExtensionCommandLineSwitch',
  `--load-extension=${extension}`, '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
let socket;
try {
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await delay(100);
  const [port, wsPath] = (await readFile(portFile, 'utf8')).trim().split('\n');
  socket = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0; const pending = new Map();
  socket.onmessage = ({ data }) => { const message = JSON.parse(data); if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); } };
  const send = (method, params = {}, sessionId) => new Promise(resolve => { const n = ++id; pending.set(n, resolve); socket.send(JSON.stringify({ id: n, method, params, sessionId })); });
  let sw;
  // Chrome ships built-in extensions whose workers are also named background.js.
  const skipped = new Set();
  for (let i = 0; i < 50 && !sw; i++) {
    sw = (await send('Target.getTargets')).result.targetInfos.find(t => t.type === 'service_worker' && t.url.startsWith('chrome-extension://') && t.url.endsWith('/background.js') && t.title !== '' && !skipped.has(t.targetId));
    if (sw) {
      const probeSession = (await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).result.sessionId;
      const name = (await send('Runtime.evaluate', { expression: 'chrome.runtime.getManifest().name + ":" + typeof handle', returnByValue: true }, probeSession)).result?.result?.value;
      if (!/^CaptionDrop:function/.test(name || '')) { skipped.add(sw.targetId); sw = undefined; }
    }
    if (!sw && i === 10) await send('Extensions.loadUnpacked', { path: extension });
    if (!sw) await delay(200);
  }
  if (!sw) throw new Error('extension worker not found');
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  const evaluate = async expression => {
    const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails).slice(0, 500));
    return reply.result?.result?.value;
  };
  const setup = await evaluate(`(async () => {
    const ui = { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html') };
    const tab = await chrome.tabs.create({ url: ${JSON.stringify(origin)} + '/target', active: true });
    for (let i = 0; i < 50; i++) { if ((await chrome.tabs.get(tab.id)).status === 'complete') break; await new Promise(r => setTimeout(r, 100)); }
    await new Promise(r => setTimeout(r, 800));
    const scan = await handle({ type: 'CD_SCAN', tabId: tab.id }, ui);
    const v = scan.videos[0];
    const load = await handle({ type: 'CD_LOAD_VIDEO', tabId: tab.id, frameId: v.frameId, documentId: v.documentId, identity: v.identity, src: v.src, videoId: v.id,
      text: '1\\n00:00:00,000 --> 00:10:00,000\\nPrerender caption', fileName: 'p.srt' }, ui);
    const auto = await handle({ type: 'CD_ENABLE_AUTO', origins: ['http://127.0.0.1/*'] }, ui);
    globalThis.__log = [];
    const original = globalThis.handle;
    globalThis.handle = async (message, sender) => {
      const entry = { type: message.type, frameId: sender.frameId, lifecycle: sender.documentLifecycle, frameType: sender.frameType, url: sender.url };
      __log.push(entry);
      try { const r = await original(message, sender); entry.ok = r?.ok; entry.error = r?.error; entry.record = Boolean(r?.record); return r; }
      catch (e) { entry.ok = false; entry.error = e.message; throw e; }
    };
    await chrome.tabs.update(tab.id, { url: 'about:blank' });
    await new Promise(r => setTimeout(r, 500));
    await chrome.tabs.update(tab.id, { url: ${JSON.stringify(origin)} + '/start' });
    return { tabId: tab.id, saved: load.saved, auto: auto.ok };
  })()`);
  await delay(10000);
  const outcome = await evaluate(`(async () => {
    const tab = await chrome.tabs.get(${setup.tabId});
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => ({
      active: globalThis.__captionDrop?.active?.text ?? null,
      activationStart: performance.getEntriesByType('navigation')[0]?.activationStart ?? null,
    }) });
    return { tabUrl: tab.url, ...r.result, requests: __log };
  })()`);
  assert.equal(setup.saved, true);
  assert.ok(outcome.activationStart > 0, 'Chrome did not activate a prerendered document');
  assert.equal(outcome.active, 'Prerender caption');
  assert.equal(outcome.requests.some(entry => entry.type === 'CD_RESTORE_BATCH' && entry.lifecycle === 'prerender'), false);
  console.log('PASS Prerender activation restores captions without premature requests');
} finally {
  socket?.close();
  chrome.kill('SIGKILL');
  server.close();
  await delay(500);
  await rm(profile, { recursive: true, force: true });
  await rm(extension, { recursive: true, force: true });
}
