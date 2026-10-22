import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, stat, mkdir, rm, cp, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { closedShadow } from '../scripts/closed-shadow.mjs';

// Run against an unpacked MV3 extension, never a user's Chrome profile.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'tests/fixtures');
const artifacts = process.env.CAPTIONDROP_ARTIFACTS || path.join(tmpdir(), 'captiondrop-browser-artifacts');
const liveProviders = process.env.CAPTIONDROP_LIVE === '1';
let profile = await mkdtemp(path.join(tmpdir(), 'captiondrop-browser-'));
let extensionRoot = root;
let fixtureClone;
let launchedExecutable;
await mkdir(artifacts, { recursive: true });
const failures = [];
const passed = [];
const skipped = [];
const notes = [];
let context;
let popup;
let page;
let worker;
let extensionId;

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const names = new Set(['index.html', 'fixture.js', 'sample.mp4', 'demo.srt', 'invalid.srt']);
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!names.has(name)) { response.writeHead(404).end(); return; }
    const file = path.join(fixtures, name);
    const size = (await stat(file)).size;
    const type = { html: 'text/html', js: 'text/javascript', mp4: 'video/mp4', srt: 'text/plain' }[name.split('.').at(-1)];
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || end < start) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
      response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      createReadStream(file, { start, end }).pipe(response);
    } else {
      response.writeHead(200, { ...headers, 'Content-Length': size });
      createReadStream(file).pipe(response);
    }
  } catch (error) { response.writeHead(500).end(error.message); }
});
let fixtureRouting = false;
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
} catch (error) {
  if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
  fixtureRouting = true;
  notes.push('Local listening is restricted; Playwright supplies fixture HTTP responses by request routing.');
}
const origin = `http://127.0.0.1:${fixtureRouting ? 19081 : server.address().port}`;

async function routeFixture(route) {
  const request = route.request();
  const name = new URL(request.url()).pathname.slice(1) || 'index.html';
  if (!['index.html', 'fixture.js', 'sample.mp4'].includes(name)) return route.fulfill({ status: 404, body: '' });
  const body = await readFile(path.join(fixtures, name));
  const contentType = { html: 'text/html', js: 'text/javascript', mp4: 'video/mp4' }[name.split('.').at(-1)];
  const range = request.headers().range?.match(/^bytes=(\d+)-(\d*)$/);
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    return route.fulfill({ status: 206, contentType, headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${body.length}` }, body: body.subarray(start, end + 1) });
  }
  return route.fulfill({ status: 200, contentType, headers: { 'Accept-Ranges': 'bytes' }, body });
}

async function eventually(read, predicate, message, timeout = 6000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try {
      last = await read();
      if (predicate(last)) return last;
    } catch (error) { last = error.message; }
    await new Promise(resolve => setTimeout(resolve, 70));
  }
  assert.fail(`${message}; last result: ${JSON.stringify(last)}`);
}

async function check(name, action) {
  try {
    const outcome = await action();
    if (outcome?.skip) {
      skipped.push({ name, reason: outcome.skip });
      console.log(`SKIP ${name}: ${outcome.skip}`);
      return;
    }
    passed.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error: error.stack || error.message });
    console.error(`FAIL ${name}: ${error.message}`);
    await page?.screenshot({ path: path.join(artifacts, 'failure-player.png'), fullPage: true }).catch(() => {});
    await popup?.screenshot({ path: path.join(artifacts, 'failure-popup.png') }).catch(() => {});
    throw error;
  }
}

async function launch(executablePath) {
  launchedExecutable = executablePath;
  context = await chromium.launchPersistentContext(profile, {
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    viewport: { width: 1080, height: 900 },
    args: ['--no-sandbox', '--no-first-run', '--no-default-browser-check', '--enable-unsafe-extension-debugging', '--disable-features=DisableLoadExtensionCommandLineSwitch', '--autoplay-policy=no-user-gesture-required', `--load-extension=${extensionRoot}`],
  });
  if (fixtureRouting) {
    await context.route('http://127.0.0.1:19081/**', routeFixture);
    await context.route('http://localhost:19081/**', routeFixture);
  }
  if (!context.serviceWorkers().length) {
    // Chrome 137+ may ignore unpacked-extension CLI flags. Its browser CDP
    // endpoint offers an explicit test-only load command on a fresh profile.
    const session = await context.browser().newBrowserCDPSession();
    try {
      const result = await session.send('Extensions.loadUnpacked', { path: extensionRoot });
      extensionId = result.id;
    } catch (error) {
      notes.push(`CDP unpacked-extension loading: ${error.message}`);
    } finally { await session.detach(); }
  }
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 7000 });
  extensionId = new URL(worker.url()).host;
}

async function prepareFixtureAccess() {
  const targetSession = await context.newCDPSession(page);
  const browserSession = await context.browser().newBrowserCDPSession();
  try {
    const { targetInfo } = await targetSession.send('Target.getTargetInfo');
    await browserSession.send('Extensions.triggerAction', { id: extensionId, targetId: targetInfo.targetId });
    notes.push('The browser toolbar action was triggered through CDP to confer real activeTab access.');
  } catch (error) {
    notes.push(`Toolbar-action CDP automation is unavailable (${error.message.split('\n')[0]}).`);
  } finally {
    await targetSession.detach();
    await browserSession.detach();
  }
  // Headless Chrome 140 cannot automate its native optional-host-permission
  // prompt. A disposable clone models grants for the fixture hosts only;
  // production files and the user's Chrome profile are never modified.
  fixtureClone = await mkdtemp(path.join(tmpdir(), 'captiondrop-fixture-extension-'));
  for (const file of ['manifest.json', 'background.js', 'core.js', 'content.js', 'popup.html', 'popup.js', 'popup.css', 'icons']) {
    await cp(path.join(root, file), path.join(fixtureClone, file), { recursive: true });
  }
  const manifest = JSON.parse(await readFile(path.join(fixtureClone, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*', 'http://localhost/*', 'https://www.youtube.com/*',
    ...(liveProviders ? ['https://www.bilibili.com/*'] : [])];
  await writeFile(path.join(fixtureClone, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const executable = launchedExecutable;
  await context.close();
  await rm(profile, { recursive: true, force: true });
  profile = await mkdtemp(path.join(tmpdir(), 'captiondrop-browser-'));
  extensionRoot = fixtureClone;
  await launch(executable);
  page = await context.newPage();
  await page.goto(`${origin}/index.html?video=one`);
  notes.push(`TEST-ONLY HOST GRANT MODE: disposable extension clone models prior grants for 127.0.0.1, localhost and the routed YouTube fixture${liveProviders ? ', plus Bilibili for the live probe' : ''}. Native permission prompt UI is not covered.`);
}

async function probeProvider(name, url) {
  const target = await context.newPage();
  let timer;
  try {
    await Promise.race([
      (async () => {
        await target.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
        const found = await eventually(() => scan(target), result => result.ok && result.videos?.length > 0, `${name} did not expose an accessible video`, 4000);
        const video = found.videos.find(item => item.width > 200) || found.videos[0];
        const targetId = await tabIdFor(target);
        const text = await readFile(path.join(fixtures, 'demo.srt'), 'utf8');
        const loaded = await message({ type: 'CD_LOAD_VIDEO', tabId: targetId, frameId: video.frameId, videoId: video.id, text, fileName: 'demo.srt' });
        assert.equal(loaded.ok, true, loaded.error);
        await eventually(async () => (await Promise.all(target.frames().map(frame => frame.locator('captiondrop-player[data-captiondrop-overlay]').count().catch(() => 0)))).reduce((sum, count) => sum + count, 0), count => count === 1, `${name} overlay did not attach`, 1500);
        await target.screenshot({ path: path.join(artifacts, `${name.toLowerCase()}-probe.png`), timeout: 1500 });
        notes.push(`LIVE ${name}: discovered ${found.videos.length} accessible video(s) and attached a local SRT overlay. Streaming playback and long-session compatibility were not verified.`);
      })(),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('15-second provider probe limit reached')), 15000); }),
    ]);
  } catch (error) {
    notes.push(`LIVE ${name}: compatibility unverified in this environment (${error.message.split('\n')[0]}).`);
    await target.screenshot({ path: path.join(artifacts, `${name.toLowerCase()}-probe.png`), timeout: 1000 }).catch(() => {});
  } finally {
    clearTimeout(timer);
    await target.close().catch(() => {});
  }
}

async function tabIdFor(target) {
  await target.bringToFront();
  return worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);
}
async function message(payload) { return popup.evaluate(value => chrome.runtime.sendMessage(value), payload); }
async function openPopup(target = page) {
  const tabId = await tabIdFor(target);
  assert.ok(Number.isInteger(tabId), 'The fixture must have a Chrome tab ID.');
  if (!popup || popup.isClosed()) popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  await popup.locator('#videos').waitFor({ state: 'attached' });
  return tabId;
}
async function scan(target = page) {
  const tabId = await tabIdFor(target);
  return message({ type: 'CD_SCAN', tabId });
}
const host = () => closedShadow(page, 'captiondrop-player[data-captiondrop="player"]');
const caption = () => host().locator('.caption');
async function seek(time, target = page) {
  await target.locator('#primary').evaluate((video, value) => { video.pause(); video.currentTime = value; }, time);
  await eventually(() => target.locator('#primary').evaluate(video => video.currentTime), actual => Math.abs(actual - time) < .1, 'Video seek did not complete');
}
async function expectCaption(text) {
  await eventually(() => caption().textContent(), actual => actual === text, 'Caption does not match the playback time');
  assert.equal(await caption().isVisible(), Boolean(text));
}

try {
  const requested = process.env.CAPTIONDROP_BROWSER_PATH;
  const system = requested || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
  if (system) {
    try { await launch(system); console.log(`Browser: ${system}`); }
    catch (error) {
      await context?.close().catch(() => {});
      if (requested) throw error;
      notes.push(`System Chrome extension launch failed (${error.message.split('\n')[0]}); attempting Playwright Chromium.`);
      await launch();
      console.log('Browser: Playwright Chromium');
    }
  } else { await launch(); console.log('Browser: Playwright Chromium'); }

  page = await context.newPage();
  await page.goto(`${origin}/index.html?video=one`);
  await prepareFixtureAccess();
  await page.locator('#primary').evaluate(video => video.readyState >= 2 ? undefined : new Promise(resolve => video.addEventListener('loadeddata', resolve, { once: true })));
  const tabId = await openPopup();

  // Opening popup.html as a tab does not confer the toolbar's activeTab grant.
  // Exercise the real optional-permission button rather than weakening the manifest.
  await eventually(async () => ({ count: await popup.locator('#videos .video-card').count(), canGrant: await popup.locator('#auto-load').isEnabled() }), value => value.count > 0 || value.canGrant, 'Popup did not become ready');
  if (await popup.locator('#videos .video-card').count() === 0) {
    await popup.locator('#auto-load').click();
    notes.push('The test popup is an extension tab; initial access was granted through its automatic-loading button.');
  }

  await check('MV3 service worker and cross-site HTML5 discovery', async () => {
    assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().manifest_version), 3);
    await eventually(() => popup.locator('#videos .video-card').count(), count => count === 1, 'Expected one detected video');
    const result = await scan();
    assert.equal(result.ok, true);
    assert.equal(result.videos.length, 1);
    assert.match(result.videos[0].label, /Primary/);
  });

  await check('Video selection opens a real file chooser and loads local SRT', async () => {
    const choosing = popup.waitForEvent('filechooser');
    await popup.locator('#videos .video-card').first().click();
    await (await choosing).setFiles(path.join(fixtures, 'demo.srt'));
    await eventually(() => host().count(), count => count === 1, 'Subtitle player was not attached');
    await page.bringToFront();
    await seek(.5);
    await expectCaption('Welcome to CaptionDrop.');
  });

  await check('Seeking renders Unicode, multiline, overlap and empty gaps', async () => {
    await seek(2);
    await expectCaption('你好 · مرحبًا · Hello 👋\nSecond line & readable text.');
    await seek(3.4);
    await expectCaption('你好 · مرحبًا · Hello 👋\nSecond line & readable text.\nAn overlapping caption.');
    await seek(5.5);
    await expectCaption('');
  });

  await check('Playback, pause and speed changes preserve synchronization', async () => {
    await seek(6.5);
    await page.locator('#primary').evaluate(video => { video.playbackRate = 2; return video.play(); });
    await expectCaption('Drag these captions anywhere.');
    await eventually(() => page.locator('#primary').evaluate(video => video.currentTime), value => value > 7.2, 'Video did not play');
    await page.locator('#primary').evaluate(video => video.pause());
    const paused = await page.locator('#primary').evaluate(video => video.currentTime);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await page.locator('#primary').evaluate(video => video.currentTime), paused);
    assert.equal(await page.locator('#primary').evaluate(video => video.playbackRate), 2);
  });

  await check('Caption controls offer only Black and Transparent backgrounds and apply both locally', async () => {
    await host().locator('.trigger').click();
    const background = host().locator('#background-color');
    assert.deepEqual(await background.evaluate(select => [...select.options].map(option => ({ label: option.textContent, value: option.value }))), [
      { label: 'Black', value: '#000000' },
      { label: 'Transparent', value: 'transparent' },
    ]);
    assert.equal(await background.inputValue(), 'transparent');
    assert.equal(await caption().evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
    await host().locator('#font-size').press('Home');
    for (let step = 0; step < 20; step++) await host().locator('#font-size').press('ArrowRight');
    await host().locator('#text-color').evaluate(input => { input.value = '#ffe088'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await host().locator('#text-color').inputValue(), '#ffffff', 'Synthetic appearance changes must be ignored');
    await background.press('Home');
    assert.equal(await caption().evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(0, 0, 0)');
    await background.press('ArrowDown');
    const style = await caption().evaluate(element => ({ size: getComputedStyle(element).fontSize, color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
    assert.deepEqual(style, { size: '36px', color: 'rgb(255, 255, 255)', background: 'rgba(0, 0, 0, 0)' });
    await host().locator('.close').click();
  });

  await check('Mouse dragging moves the caption without seeking or pausing', async () => {
    await seek(6.5);
    await expectCaption('Drag these captions anywhere.');
    const before = await caption().boundingBox();
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 - 80, before.y + before.height / 2 - 100, { steps: 10 });
    await page.mouse.up();
    const after = await caption().boundingBox();
    assert.ok(after.y < before.y - 70, 'Caption did not follow the mouse');
    assert.ok(Math.abs(await page.locator('#primary').evaluate(video => video.currentTime) - 6.5) < .1);
    assert.equal(await page.locator('#primary').evaluate(video => video.paused), true);
  });

  await check('Show/hide and invalid replacement preserve the loaded captions', async () => {
    await host().locator('.trigger').click();
    await host().locator('#caption-toggle').uncheck();
    assert.equal(await caption().isVisible(), false);
    await host().locator('#caption-toggle').check();
    await expectCaption('Drag these captions anywhere.');
    assert.equal(await host().locator('input[type=file]').count(), 0, 'Local file inputs must stay outside the webpage');
    const opening = context.waitForEvent('page');
    await host().locator('#replace-file').click();
    const picker = await opening;
    try {
      await eventually(() => picker.url(), url => url.startsWith(`chrome-extension://${extensionId}/popup.html?`), 'The extension-owned picker did not open');
      assert.equal(new URL(picker.url()).searchParams.get('tabId'), String(tabId));
      const target = picker.locator('#videos .video-card.selected');
      await eventually(() => target.count(), count => count === 1, 'Requested video was not highlighted in the picker');
      assert.equal(await target.getAttribute('data-video-id'), new URL(picker.url()).searchParams.get('videoId'));
      assert.equal(await target.getAttribute('data-frame-id'), new URL(picker.url()).searchParams.get('frameId'));
      let choosing = picker.waitForEvent('filechooser');
      await target.click();
      await (await choosing).setFiles(path.join(fixtures, 'invalid.srt'));
      await eventually(() => picker.locator('#status').textContent(), text => /invalid|readable|timing|valid/i.test(text), 'No validation message appeared');
      await expectCaption('Drag these captions anywhere.');
      choosing = picker.waitForEvent('filechooser');
      await target.click();
      await (await choosing).setFiles(path.join(fixtures, 'demo.srt'));
      await eventually(() => picker.locator('#status').textContent(), text => /demo\.srt loaded/.test(text), 'The replacement subtitle file did not load');
      await expectCaption('Drag these captions anywhere.');
    } finally { await picker.close(); }
    await page.bringToFront();
    await host().locator('.trigger').click();
    await page.screenshot({ path: path.join(artifacts, 'player-settings.png'), fullPage: true });
    await host().locator('.close').click();
  });

  await check('Webpage scripts cannot replace, delete, or persist forged caption settings', async () => {
    await new Promise(resolve => setTimeout(resolve, 500));
    const before = await worker.evaluate(() => chrome.storage.local.get(null));
    const pageCount = context.pages().length;
    const exposed = await page.evaluate(() => {
      const host = document.querySelector('captiondrop-player');
      const fake = document.createElement('input');
      fake.type = 'file';
      const files = new DataTransfer();
      files.items.add(new File(['1\n00:00:00,000 --> 00:10:00,000\nInjected by website'], 'website.srt'));
      fake.files = files.files; host.append(fake);
      fake.dispatchEvent(new Event('change', { bubbles: true })); fake.remove();
      host.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return { root: host.shadowRoot, text: host.textContent, inputs: host.querySelectorAll('input').length,
        fileName: host.outerHTML.includes('demo.srt'), settings: host.querySelector('#settings-panel') };
    });
    assert.deepEqual(exposed, { root: null, text: '', inputs: 0, fileName: false, settings: null }, 'Closed roots exposed private controls to the webpage');
    // CDP can inspect closed roots for testing; synthetic actions still cannot
    // persist or delete records even when given a direct node reference.
    await host().locator('#forget').evaluate(button => button.click());
    await host().locator('#replace-file').evaluate(button => button.click());
    await host().locator('#caption-toggle').evaluate(toggle => {
      toggle.checked = false; toggle.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual(await worker.evaluate(() => chrome.storage.local.get(null)), before, 'Forged webpage events changed saved extension records');
    assert.equal(context.pages().length, pageCount, 'A synthetic click opened a file picker');
    await expectCaption('Drag these captions anywhere.');
    assert.equal(await host().locator('#caption-toggle').isChecked(), true);
    assert.equal(await host().locator('#font-size').inputValue(), '36');
    assert.equal(await host().locator('#text-color').inputValue(), '#ffffff');
    assert.equal(await host().locator('#background-color').inputValue(), 'transparent');
  });

  await check('Paused captions follow a same-sized video after a position-only layout change', async () => {
    await seek(6.5);
    const before = await page.locator('#primary').boundingBox();
    try {
      await page.locator('#player').evaluate(player => { player.style.transform = 'translateY(85px)'; });
      const after = await page.locator('#primary').boundingBox();
      assert.equal(after.width, before.width); assert.equal(after.height, before.height);
      assert.ok(after.y > before.y + 80, 'The fixture did not move');
      await eventually(() => page.evaluate(() => {
        const video = document.querySelector('#primary').getBoundingClientRect();
        const overlay = document.querySelector('captiondrop-player').getBoundingClientRect();
        return Math.abs(video.top - overlay.top) + Math.abs(video.left - overlay.left);
      }), distance => distance < 2, 'Caption overlay did not follow the moving paused video', 2000);
      assert.equal(await page.locator('#primary').evaluate(video => video.paused), true);
    } finally {
      await page.locator('#player').evaluate(player => { player.style.transform = ''; });
      await eventually(() => host().boundingBox(), bounds => Math.abs(bounds.y - before.y) < 2, 'Overlay did not return with the video');
    }
  });

  await check('Container fullscreen retains the subtitle overlay and controls', async () => {
    await page.locator('#fullscreen').click();
    await eventually(() => page.evaluate(() => document.fullscreenElement?.id), id => id === 'player', 'Container did not enter fullscreen');
    await eventually(() => host().evaluate(element => element.parentElement.id), id => id === 'player', 'Fullscreen handler did not move the overlay into the player');
    await eventually(() => caption().isVisible(), visible => visible, 'Caption is not visible in container fullscreen');
    await eventually(() => host().locator('.trigger').isVisible(), visible => visible, 'Caption controls are not visible in container fullscreen');
    await page.screenshot({ path: path.join(artifacts, 'fullscreen.png') });
    await page.evaluate(() => document.exitFullscreen());
  });

  await check('Native video fullscreen uses a synchronized CaptionDrop text track', async () => {
    await seek(2);
    await page.locator('#primary').evaluate(video => video.requestFullscreen());
    await eventually(() => page.evaluate(() => document.fullscreenElement?.id), id => id === 'primary', 'Video did not enter native fullscreen');
    const native = await eventually(() => page.locator('#primary').evaluate(video => {
      const track = [...video.textTracks].find(item => item.label === 'CaptionDrop');
      return track && { mode: track.mode, active: [...(track.activeCues || [])].map(cue => cue.text).join('\n') };
    }), value => value?.mode === 'showing' && value.active.includes('你好'), 'Native captions were not synchronized');
    assert.ok(native.active.includes('Hello'));
    assert.equal(await page.locator('style[data-captiondrop="native-style"]').evaluate(element => element.sheet.cssRules[0].style.backgroundColor), 'transparent');
    assert.equal(await host().evaluate(element => getComputedStyle(element).visibility), 'hidden');
    await page.screenshot({ path: path.join(artifacts, 'native-fullscreen.png') });
    await page.evaluate(() => document.exitFullscreen());
    await eventually(() => page.locator('#primary').evaluate(video => [...video.textTracks].find(item => item.label === 'CaptionDrop')?.mode), mode => mode === 'disabled', 'Native captions remained active after exiting fullscreen');
    await expectCaption('你好 · مرحبًا · Hello 👋\nSecond line & readable text.');
  });

  await check('Repeated scans and late videos do not duplicate the active overlay', async () => {
    await scan(); await scan();
    assert.equal(await host().count(), 1);
    await page.locator('#add-video').click();
    const result = await eventually(() => scan(), value => value.ok && value.videos.length === 2, 'Late video was not detected');
    assert.ok(result.videos.some(video => /Late/.test(video.label)));
    assert.equal(await host().count(), 1);
  });

  await check('Memory data is persisted for an individual video', async () => {
    const state = await worker.evaluate(() => chrome.storage.local.get(null));
    assert.ok(JSON.stringify(state).includes('Welcome to CaptionDrop.'), 'Subtitle contents were not persisted locally');
    const records = Object.values(state).filter(value => value && typeof value.text === 'string');
    assert.ok(records.length);
    assert.equal(records.some(record => 'identity' in record), false, 'Readable video identities were persisted');
    assert.equal(JSON.stringify(records).includes(origin), false, 'Page or media URLs leaked into subtitle records');
  });

  await check('Content scripts cannot directly read the subtitle storage area', async () => {
    const result = await worker.evaluate(async tabId => {
      const [frame] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: async () => {
          try { await chrome.storage.local.get(null); return { allowed: true }; }
          catch (error) { return { allowed: false, error: error.message }; }
        },
      });
      return frame.result;
    }, tabId);
    assert.equal(result.allowed, false, 'Content scripts could read the entire local subtitle cache');
    assert.match(result.error, /access|allowed|context/i);
  });

  await check('Optional site permission supports automatic restoration after reload', async () => {
    await openPopup();
    const enable = popup.locator('#auto-load');
    if (await enable.isVisible() && await enable.isEnabled()) await enable.click();
    const permission = await eventually(() => worker.evaluate(async () => chrome.permissions.getAll()), value => value.origins?.some(pattern => pattern.includes('127.0.0.1') || pattern === '<all_urls>' || pattern === 'http://*/*'), 'The automatic restoration site permission was not granted', 4000);
    assert.ok(permission.origins.length > 0);
    await page.reload();
    await page.bringToFront();
    await eventually(() => host().count(), value => value === 1, 'Remembered captions were not restored without an extension click');
    await seek(2);
    await expectCaption('你好 · مرحبًا · Hello 👋\nSecond line & readable text.');
    assert.equal(await host().locator('#background-color').inputValue(), 'transparent');
    assert.equal(await caption().evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
  });

  await check('A different video does not inherit the previous caption file', async () => {
    await page.goto(`${origin}/index.html?video=two`);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await host().count(), 0);
    const result = await scan();
    assert.equal(result.ok, true);
    assert.equal(result.videos[0].hasSubtitles, false);
  });

  await check('Multiple video selection attaches to the selected target only', async () => {
    await page.goto(`${origin}/index.html?video=multiple&multi=1`);
    const result = await scan();
    assert.equal(result.videos.length, 2);
    const selected = result.videos.find(video => /Secondary/.test(video.label));
    const text = await readFile(path.join(fixtures, 'demo.srt'), 'utf8');
    const loaded = await message({ type: 'CD_LOAD_VIDEO', tabId, frameId: selected.frameId, videoId: selected.id, text, fileName: 'demo.srt', remember: true });
    assert.equal(loaded.ok, true);
    const after = await scan();
    assert.equal(after.videos.filter(video => video.hasSubtitles).length, 1);
    assert.equal(after.videos.find(video => video.hasSubtitles).id, selected.id);
  });

  await check('Removing an unrelated earlier video preserves the selected player captions', async () => {
    const selected = page.locator('video[aria-label="Secondary demo video"]');
    const overlay = await host().elementHandle();
    await page.locator('#primary').evaluate(video => video.remove());
    await new Promise(resolve => setTimeout(resolve, 1600));
    assert.equal(await overlay.evaluate(element => element.isConnected), true, 'Removing an unrelated video detached the captions');
    const result = await scan();
    assert.equal(result.videos.length, 1);
    assert.equal(result.videos[0].hasSubtitles, true);
    await selected.evaluate(video => { video.pause(); video.currentTime = 2; });
    await expectCaption('你好 · مرحبًا · Hello 👋\nSecond line & readable text.');
    await overlay.dispose();
  });

  await check('Provider restoration prefers the main player over an earlier preview', async () => {
    const target = await context.newPage();
    const route = 'https://www.youtube.com/watch?v=CaptionDropProviderFixture';
    await context.route(route, request => request.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Local provider identity fixture</title>
      <style>video{display:block;width:600px;height:300px}#preview{width:120px;height:70px}</style>
      <video id="preview" aria-label="Unrelated preview"></video><div id="movie_player" class="html5-video-player"><video id="main" aria-label="Main player"></video></div>` }));
    try {
      await target.goto(route);
      const targetId = await openPopup(target);
      const enabled = await message({ type: 'CD_ENABLE_AUTO', origins: ['https://www.youtube.com/*'] });
      assert.equal(enabled.ok, true, enabled.error);
      const found = await scan(target);
      const main = found.videos.find(video => video.label === 'Main player');
      const text = await readFile(path.join(fixtures, 'demo.srt'), 'utf8');
      const loaded = await message({ type: 'CD_LOAD_VIDEO', tabId: targetId, frameId: main.frameId, videoId: main.id, text, fileName: 'provider.srt' });
      assert.equal(loaded.ok, true, loaded.error);
      await target.locator('#preview').evaluate(video => video.remove());
      await new Promise(resolve => setTimeout(resolve, 1500));
      const selected = (await scan(target)).videos.find(video => video.hasSubtitles);
      assert.equal(selected?.label, 'Main player', 'Removing a preview detached the main player captions');
      await target.reload();
      await eventually(() => target.locator('captiondrop-player').count(), count => count === 1, 'Provider subtitles did not restore');
      const restored = await scan(target);
      assert.equal(restored.videos.find(video => video.hasSubtitles)?.label, 'Main player', 'Saved provider captions attached to the preview');
    } finally {
      await target.close();
      await context.unroute(route);
    }
  });

  await check('Accessible cross-origin iframe is discovered after explicit host grant', async () => {
    await page.goto(`${origin}/index.html?video=frames&frame=1`);
    await page.frameLocator('iframe').locator('#primary').waitFor();
    const permission = await popup.evaluate(async () => {
      try { return await chrome.permissions.request({ origins: ['http://localhost/*'] }); }
      catch (error) { return { error: error.message }; }
    });
    if (permission !== true) {
      const result = await scan();
      assert.ok(result.ok && result.videos.length >= 1);
      return { skip: `Cross-origin optional permission request unavailable: ${JSON.stringify(permission)}` };
    }
    const result = await scan();
    assert.equal(result.videos.length, 2);
    assert.ok(result.videos.some(video => video.frameId !== 0));
  });

  await check('Embedded access requests only the explicitly selected origin', async () => {
    const target = await context.newPage();
    await context.route('https://player.example.test/**', route => route.fulfill({ contentType: 'text/html', body: '<video></video>' }));
    await context.route('https://ads.example.test/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Unrelated frame</p>' }));
    try {
      await target.goto(`${origin}/index.html?video=permission-choice`);
      await target.evaluate(() => {
        for (const site of ['player', 'ads']) {
          const frame = document.createElement('iframe'); frame.src = `https://${site}.example.test/`; document.body.append(frame);
        }
      });
      await eventually(() => target.frames().length, count => count === 3, 'Permission fixture frames did not load');
      await openPopup(target);
      await eventually(() => popup.locator('#embedded-origin option').count(), count => count === 3, 'Expected separate player and advertising origins');
      assert.equal(await popup.locator('#enable-embedded').isDisabled(), true, 'The popup selected an unknown origin automatically');
      await popup.evaluate(() => {
        globalThis.__originalPermissionRequest = chrome.permissions.request;
        chrome.permissions.request = async value => { globalThis.__requestedOrigins = value.origins; return false; };
      });
      await popup.locator('#embedded-origin').selectOption('https://player.example.test/*');
      await popup.locator('#enable-embedded').click();
      const requested = await popup.evaluate(() => globalThis.__requestedOrigins);
      assert.deepEqual(requested, ['https://player.example.test/*'], 'Embedded permission request included an unrelated origin');
    } finally {
      await popup.evaluate(() => { if (globalThis.__originalPermissionRequest) chrome.permissions.request = globalThis.__originalPermissionRequest; }).catch(() => {});
      await target.close();
      await context.unroute('https://player.example.test/**');
      await context.unroute('https://ads.example.test/**');
    }
  });

  await check('A replacement iframe automatically restores captions after the selected frame disappears', async () => {
    const target = await context.newPage();
    try {
      await target.goto(`${origin}/index.html?video=iframe-replacement&frame=1`);
      await target.frameLocator('iframe').locator('#primary').waitFor();
      const targetId = await openPopup(target);
      const found = await scan(target);
      const embedded = found.videos.find(video => video.frameId !== 0);
      if (!embedded) return { skip: 'The browser did not grant access to the embedded fixture host.' };
      const enabled = await message({ type: 'CD_ENABLE_AUTO', origins: ['http://localhost/*'] });
      assert.equal(enabled.ok, true, enabled.error);
      const text = await readFile(path.join(fixtures, 'demo.srt'), 'utf8');
      const loaded = await message({ type: 'CD_LOAD_VIDEO', tabId: targetId, frameId: embedded.frameId, videoId: embedded.id, text, fileName: 'demo.srt' });
      assert.equal(loaded.ok, true, loaded.error);
      await eventually(() => target.frameLocator('iframe').locator('captiondrop-player').count(), count => count === 1, 'Initial embedded captions did not load');
      const frameUrl = await target.locator('iframe').getAttribute('src');
      await target.locator('iframe').evaluate(frame => frame.remove());
      await target.evaluate(src => {
        const frame = document.createElement('iframe'); frame.src = src; document.querySelector('#extras').append(frame);
      }, frameUrl);
      await target.frameLocator('iframe').locator('#primary').waitFor();
      const restored = closedShadow(target.frames().find(frame => frame !== target.mainFrame()), 'captiondrop-player');
      await eventually(() => restored.count(), count => count === 1, 'Saved subtitles did not automatically restore in the replacement iframe');
      const after = await scan(target);
      const replacement = after.videos.find(video => video.frameId !== 0 && video.hasSubtitles);
      assert.ok(replacement, 'The replacement iframe has no selected captions');
      assert.notEqual(replacement.frameId, embedded.frameId, 'The browser did not create a new iframe identity');
      await target.frameLocator('iframe').locator('#primary').evaluate(video => { video.pause(); video.currentTime = 2; });
      await eventually(() => restored.locator('.caption').textContent(), value => value.includes('你好'), 'Replacement iframe captions were not synchronized');
    } finally { await target.close(); }
  });

  await check('A removed picker target preserves captions on the previously selected player', async () => {
    const target = await context.newPage();
    try {
      await target.goto(`${origin}/index.html?video=stale-picker&frame=1`);
      await target.frameLocator('iframe').locator('#primary').waitFor();
      const targetId = await openPopup(target);
      const found = await scan(target);
      const primary = found.videos.find(video => video.frameId === 0);
      const embedded = found.videos.find(video => video.frameId !== 0);
      if (!embedded) return { skip: 'The browser did not grant access to the embedded fixture host.' };
      const text = await readFile(path.join(fixtures, 'demo.srt'), 'utf8');
      const loaded = await message({ type: 'CD_LOAD_VIDEO', tabId: targetId, frameId: primary.frameId, videoId: primary.id, text, fileName: 'demo.srt' });
      assert.equal(loaded.ok, true, loaded.error);
      await target.locator('#primary').evaluate(video => { video.pause(); video.currentTime = 2; });
      const overlay = closedShadow(target, 'captiondrop-player');
      await eventually(() => overlay.locator('.caption').textContent(), value => value.includes('你好'), 'The initial captions did not load');
      await popup.locator('#rescan').click();
      const card = popup.locator(`.video-card[data-frame-id="${embedded.frameId}"][data-video-id="${embedded.id}"]`);
      await eventually(() => card.count(), count => count === 1, 'The embedded target was not listed');
      const choosing = popup.waitForEvent('filechooser');
      await card.click();
      const chooser = await choosing;
      await target.locator('iframe').evaluate(frame => frame.remove());
      await chooser.setFiles(path.join(fixtures, 'demo.srt'));
      await eventually(() => popup.locator('#status').textContent(), value => /no longer|removed|frame|receiving end|connection/i.test(value), 'The stale target was not reported');
      assert.equal(await overlay.count(), 1, 'A failed target change removed the working captions');
      assert.ok((await overlay.locator('.caption').textContent()).includes('你好'));
    } finally { await target.close(); }
  });

  await check('Replacing a video with an equivalent DOM element restores its saved captions', async () => {
    await page.goto(`${origin}/index.html?video=one`);
    await eventually(() => host().count(), count => count === 1, 'Saved captions did not restore for the replacement fixture');
    const originalOverlay = await host().elementHandle();
    await page.locator('#primary').evaluate(video => video.replaceWith(video.cloneNode(true)));
    await eventually(() => originalOverlay.evaluate(element => element.isConnected), connected => !connected, 'The obsolete video overlay was not removed');
    await originalOverlay.dispose();
    await eventually(() => host().count(), count => count === 1, 'Equivalent replacement video did not restore saved captions');
    await page.locator('#primary').evaluate(video => video.readyState >= 2 ? undefined : new Promise(resolve => video.addEventListener('loadeddata', resolve, { once: true })));
    await seek(2);
    await expectCaption('你好 · مرحبًا · Hello 👋\nSecond line & readable text.');
  });

  await check('Nested YouTube-style fullscreen controls retain their original behavior', async () => {
    const target = await context.newPage();
    try {
      await target.goto(`${origin}/index.html?video=nested-controls`);
      await target.evaluate(() => {
        const player = document.querySelector('#player');
        player.classList.add('html5-video-player');
        document.querySelector('#primary').controls = false;
        const controls = document.createElement('div');
        controls.className = 'ytp-right-controls';
        controls.style.cssText = 'position:absolute;bottom:10px;right:10px;display:flex;align-items:center;height:36px';
        const nested = document.createElement('div');
        const fullscreen = document.createElement('button');
        fullscreen.className = 'ytp-fullscreen-button';
        fullscreen.textContent = 'Original fullscreen';
        fullscreen.addEventListener('click', () => { fullscreen.dataset.clicked = 'true'; void player.requestFullscreen(); });
        nested.append(fullscreen);
        controls.append(nested);
        player.append(controls);
      });
      const targetId = await openPopup(target);
      const found = await scan(target);
      const video = found.videos[0];
      const text = await readFile(path.join(fixtures, 'demo.srt'), 'utf8');
      const loaded = await message({ type: 'CD_LOAD_VIDEO', tabId: targetId, frameId: video.frameId, videoId: video.id, text, fileName: 'demo.srt' });
      assert.equal(loaded.ok, true, loaded.error);
      const control = closedShadow(target, 'captiondrop-control[data-captiondrop="control"]');
      assert.equal(await control.count(), 1);
      assert.equal(await target.locator('captiondrop-control').evaluate(element => element.shadowRoot), null);
      await scan(target);
      assert.equal(await control.count(), 1, 'Repeated discovery duplicated the player button');
      await control.locator('button').click();
      assert.equal(await closedShadow(target, 'captiondrop-player').locator('#settings-panel').isVisible(), true);
      await closedShadow(target, 'captiondrop-player').locator('.close').click();
      await target.locator('.ytp-fullscreen-button').click();
      assert.equal(await target.locator('.ytp-fullscreen-button').getAttribute('data-clicked'), 'true');
      await eventually(() => target.evaluate(() => document.fullscreenElement?.id), id => id === 'player', 'Original nested fullscreen button stopped working');
      await target.evaluate(() => document.exitFullscreen());
    } finally { await target.close(); }
  });

  await check('Extension reload disposes old overlays and native cues before reinjection', async () => {
    const targetTab = await tabIdFor(page);
    const oldHost = await host().elementHandle();
    await page.locator('#primary').evaluate(video => video.requestFullscreen());
    await eventually(() => page.locator('#primary').evaluate(video => [...video.textTracks].some(track => track.label === 'CaptionDrop' && track.mode === 'showing')), value => value, 'The old native track did not activate');
    const previousWorker = worker;
    await previousWorker.evaluate(() => chrome.runtime.reload()).catch(() => {});
    await eventually(() => oldHost.evaluate(element => element.isConnected), value => !value, 'The old content script did not remove its overlay after reload', 4000);
    assert.equal(await page.locator('#primary').evaluate(video => [...video.textTracks].filter(track => track.label === 'CaptionDrop').every(track => { if (track.mode !== 'disabled') return false; track.mode = 'hidden'; const count = track.cues?.length || 0; track.mode = 'disabled'; return count === 0; })), true, 'Old native cues survived extension reload');
    await page.evaluate(() => document.exitFullscreen());
    if (!popup || popup.isClosed()) popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${targetTab}`);
    worker = await eventually(() => context.serviceWorkers().find(candidate => candidate !== previousWorker && candidate.url().startsWith(`chrome-extension://${extensionId}/`)), value => Boolean(value), 'The replacement service worker did not start');
    await scan(); await scan();
    await eventually(() => host().count(), count => count === 1, 'Reinjection did not create exactly one caption overlay');
    await seek(2);
    await expectCaption('你好 · مرحبًا · Hello 👋\nSecond line & readable text.');
    await new Promise(resolve => setTimeout(resolve, 1400));
    assert.equal(await oldHost.evaluate(element => element.isConnected), false, 'An old observer resurrected the discarded overlay');
    assert.equal(await host().count(), 1);
    await oldHost.dispose();
  });

  await openPopup();
  await popup.screenshot({ path: path.join(artifacts, 'extension-popup.png') });

  await check('Saved captions and appearance survive a full Chrome restart', async () => {
    const executable = launchedExecutable;
    await context.close();
    popup = undefined;
    await launch(executable);
    page = await context.newPage();
    await page.goto(`${origin}/index.html?video=one`);
    await eventually(() => host().count(), count => count === 1, 'Captions did not restore after restarting Chrome');
    await seek(2);
    await expectCaption('你好 · مرحبًا · Hello 👋\nSecond line & readable text.');
    const style = await caption().evaluate(element => ({ size: getComputedStyle(element).fontSize, color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
    assert.deepEqual(style, { size: '36px', color: 'rgb(255, 255, 255)', background: 'rgba(0, 0, 0, 0)' });
    assert.equal(await host().locator('#background-color').inputValue(), 'transparent');
    await page.screenshot({ path: path.join(artifacts, 'restored-after-restart.png'), fullPage: true });
  });

  await check('Forget saved subtitles removes automatic loading on return', async () => {
    await host().locator('.trigger').click();
    await host().locator('#forget').click();
    await eventually(() => host().locator('.status').textContent(), text => /Forgotten/.test(text), 'Forgetting subtitles did not complete');
    assert.equal(await caption().isVisible(), true, 'Forgetting should preserve captions for the current visit');
    await page.reload();
    await page.locator('#primary').evaluate(video => video.readyState >= 2 ? undefined : new Promise(resolve => video.addEventListener('loadeddata', resolve, { once: true })));
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await host().count(), 0, 'Forgotten subtitles were restored');
  });

  await check('Chrome parses and indexes a 10,000-cue subtitle file', async () => {
    const benchmark = await worker.evaluate(() => {
      const format = value => `${String(Math.floor(value / 3600)).padStart(2, '0')}:${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')},000`;
      const source = Array.from({ length: 10000 }, (_, i) => `${i + 1}\n${format(i * 2)} --> ${format(i * 2 + 1)}\nCaption ${i + 1}`).join('\n\n');
      const started = performance.now();
      const cues = CaptionDropCore.parseSrt(source);
      const parsed = performance.now();
      const index = CaptionDropCore.buildCueIndex(cues);
      const indexed = performance.now();
      let found = 0;
      for (let i = 0; i < 1000; i++) found += CaptionDropCore.activeCues(index, i * 20 + .5).length;
      return { count: cues.length, found, bytes: new TextEncoder().encode(source).byteLength, parseMs: parsed - started, indexMs: indexed - parsed, lookupMs: performance.now() - indexed };
    });
    assert.equal(benchmark.count, 10000);
    assert.equal(benchmark.found, 1000);
    notes.push(`Chrome benchmark (single run; no agreed performance threshold): ${benchmark.bytes} bytes, 10,000 cues parsed in ${benchmark.parseMs.toFixed(1)} ms, indexed in ${benchmark.indexMs.toFixed(1)} ms, 1,000 lookups in ${benchmark.lookupMs.toFixed(1)} ms.`);
  });

  if (liveProviders) {
    await openPopup();
    await probeProvider('YouTube', 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
    await probeProvider('Bilibili', process.env.CAPTIONDROP_BILIBILI_URL || 'https://www.bilibili.com/video/BV1GJ411x7h7/');
  }
} catch (error) {
  if (!failures.length) failures.push({ name: 'Browser setup', error: error.stack || error.message });
} finally {
  await context?.close().catch(() => {});
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
  if (fixtureClone) await rm(fixtureClone, { recursive: true, force: true });
}
for (const note of notes) console.log(`NOTE ${note}`);
console.log(`\n${passed.length} browser checks passed; ${failures.length} failed; ${skipped.length} skipped. Artifacts: ${artifacts}`);
for (const failure of failures) console.error(failure.error);
if (failures.length) process.exitCode = 1;
