// Disposable real-Chrome harness for adversarial CaptionDrop probes.
// Never touches the user's profile; extension is a temp clone with test-only
// host grants for 127.0.0.1/localhost (models prior optional grants).
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { closedShadow } from '../scripts/closed-shadow.mjs';
import { fixtureTabId } from './tab-id.mjs';
import { liveWorker, prepareProfile } from './chrome-support.mjs';

export { closedShadow };
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function eventually(read, predicate, label, timeout = 6000) {
  // The monotonic clock keeps waits correct when the system clock is adjusted.
  const until = performance.now() + timeout;
  let last;
  while (performance.now() < until) {
    try { last = await read(); if (predicate(last)) return last; } catch (error) { last = `ERR ${error.message}`; }
    await delay(60);
  }
  throw new Error(`${label}; last: ${JSON.stringify(last)?.slice(0, 400)}`);
}
export const SRT = (lines = ['Probe caption']) => lines.map((text, i) =>
  `${i + 1}\n00:${String(Math.floor(i * 10 / 60)).padStart(2, '0')}:${String(i * 10 % 60).padStart(2, '0')},000 --> 00:${String(Math.floor((i * 10 + 9) / 60)).padStart(2, '0')}:${String((i * 10 + 9) % 60).padStart(2, '0')},000\n${text}`).join('\n\n');

export async function launchHarness({ pages = {}, scratch, extensionDir, hostPermissions = ['http://127.0.0.1/*', 'http://localhost/*'], viewport = { width: 1100, height: 850 } } = {}) {
  const base = scratch || tmpdir();
  const profile = await mkdtemp(path.join(base, 'cd-profile-'));
  const extension = await mkdtemp(path.join(base, 'cd-ext-'));
  for (const file of ['manifest.json', 'background.js', 'core.js', 'content.js', 'popup.html', 'popup.js', 'popup.css', 'icons']) {
    await cp(path.join(extensionDir || ROOT, file), path.join(extension, file), { recursive: true });
  }
  if (extensionDir) console.log(`(extension source: ${extensionDir})`);
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions = hostPermissions;
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const video = await readFile(path.join(ROOT, 'tests/fixtures/sample.mp4'));
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    if (url.pathname === '/sample.mp4') {
      const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), video.length - 1) : video.length - 1;
        response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${video.length}`, 'Content-Length': end - start + 1 });
        response.end(video.subarray(start, end + 1));
      } else { response.writeHead(200, { ...headers, 'Content-Length': video.length }); response.end(video); }
      return;
    }
    const handler = pages[url.pathname];
    if (!handler) { response.writeHead(404).end('nope'); return; }
    const body = typeof handler === 'function' ? handler(url, request) : handler;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const altOrigin = `http://localhost:${port}`;
  await prepareProfile(profile);
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CAPTIONDROP_BROWSER_PATH || '/usr/bin/google-chrome', headless: true, chromiumSandbox: false,
    ignoreDefaultArgs: ['--disable-extensions'], viewport,
    args: ['--no-first-run', '--no-default-browser-check', '--enable-unsafe-extension-debugging',
      '--disable-features=DisableLoadExtensionCommandLineSwitch', '--autoplay-policy=no-user-gesture-required', `--load-extension=${extension}`],
  });
  if (!context.serviceWorkers().length) {
    const session = await context.browser().newBrowserCDPSession();
    try { await session.send('Extensions.loadUnpacked', { path: extension }); } catch {}
    finally { await session.detach(); }
  }
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
  const extensionId = new URL(worker.url()).host;
  let popup;
  const live = async () => (worker = await liveWorker(context, extensionId, worker));
  const h = {
    context, origin, altOrigin, port, extensionId,
    get worker() { return worker; },
    async refreshWorker() {
      worker = await eventually(() => context.serviceWorkers().find(item => item.url().startsWith(`chrome-extension://${extensionId}/`)), Boolean, 'worker');
      return worker;
    },
    async tabIdFor(page) {
      return fixtureTabId(await live(), page);
    },
    async popupFor(page) {
      const tabId = await h.tabIdFor(page);
      if (!popup || popup.isClosed()) popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
      await page.bringToFront();
      return { popup, tabId };
    },
    async message(payload) {
      if (!popup || popup.isClosed()) { popup = await context.newPage(); await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=-1`); }
      return popup.evaluate(value => chrome.runtime.sendMessage(value), payload);
    },
    async scan(page) { const tabId = await h.tabIdFor(page); return { tabId, ...(await h.message({ type: 'CD_SCAN', tabId })) }; },
    async load(page, { pick = videos => videos[0], text = SRT(), fileName = 'probe.srt' } = {}) {
      const result = await h.scan(page);
      if (!result.ok) throw new Error(`scan failed: ${result.error}`);
      const video = pick(result.videos);
      if (!video) throw new Error(`no video among ${result.videos.length}`);
      const loaded = await h.message({ type: 'CD_LOAD_VIDEO', tabId: result.tabId, frameId: video.frameId, documentId: video.documentId,
        identity: video.identity, src: video.src, videoId: video.id, text, fileName });
      if (!loaded?.ok) throw new Error(`Loading fixture captions failed: ${loaded?.error}`);
      return loaded;
    },
    // Wrap the worker's global `handle` (classic-script function binding) to log
    // every content/UI request with its outcome and service time.
    async instrument() {
      return (await live()).evaluate(() => {
        if (globalThis.__probeLog) { globalThis.__probeLog.length = 0; return 'reset'; }
        globalThis.__probeLog = [];
        const original = globalThis.handle;
        globalThis.handle = async (message, sender) => {
          const started = performance.now();
          const entry = { type: message?.type, tabId: sender.tab?.id, frameId: sender.frameId, t: Date.now() };
          globalThis.__probeLog.push(entry);
          try {
            const result = await original(message, sender);
            entry.ok = result?.ok; entry.error = result?.error; entry.retry = result?.retry; entry.record = Boolean(result?.record);
            return result;
          } catch (error) { entry.ok = false; entry.error = error.message; throw error; }
          finally { entry.ms = +(performance.now() - started).toFixed(2); }
        };
        return 'installed';
      });
    },
    async log() { return (await live()).evaluate(() => globalThis.__probeLog || []); },
    async active(tabId, frameId = 0) {
      return (await live()).evaluate(async ({ tabId, frameId }) => {
        const [result] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: () => ({ disposed: globalThis.__captionDrop?.disposed ?? null, active: globalThis.__captionDrop?.active ?? null, videos: globalThis.__captionDrop && !globalThis.__captionDrop.disposed ? globalThis.__captionDrop.list().length : null }) });
        return result?.result;
      }, { tabId, frameId });
    },
    async frames(tabId) { return (await live()).evaluate(id => chrome.webNavigation.getAllFrames({ tabId: id }), tabId); },
    async close() {
      await context.close().catch(() => {});
      await new Promise(resolve => server.close(resolve));
      await rm(profile, { recursive: true, force: true });
      await rm(extension, { recursive: true, force: true });
    },
  };
  return h;
}

export const results = [];
export async function probe(name, action) {
  const started = performance.now();
  try {
    const outcome = await action();
    results.push({ name, outcome, ms: Math.round(performance.now() - started) });
    console.log(`\n### ${name}\n${JSON.stringify(outcome, null, 1)}`);
  } catch (error) {
    results.push({ name, error: error.message, ms: Math.round(performance.now() - started) });
    console.log(`\n### ${name}\nPROBE ERROR: ${error.stack}`);
  }
}
