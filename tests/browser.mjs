import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, stat, mkdir, rm, cp, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

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
    return;
  } catch (error) {
    notes.push(`Toolbar-action CDP automation is unavailable (${error.message.split('\n')[0]}).`);
  } finally {
    await targetSession.detach();
    await browserSession.detach();
  }
  // Headless Chrome 140 cannot automate its native optional-host-permission
  // prompt. A disposable clone models grants for these two fixture hosts only;
  // production files and the user's Chrome profile are never modified.
  fixtureClone = await mkdtemp(path.join(tmpdir(), 'captiondrop-fixture-extension-'));
  for (const file of ['manifest.json', 'background.js', 'core.js', 'content.js', 'popup.html', 'popup.js', 'popup.css', 'icons']) {
    await cp(path.join(root, file), path.join(fixtureClone, file), { recursive: true });
  }
  const manifest = JSON.parse(await readFile(path.join(fixtureClone, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*', 'http://localhost/*',
    ...(liveProviders ? ['https://www.youtube.com/*', 'https://www.bilibili.com/*'] : [])];
  await writeFile(path.join(fixtureClone, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const executable = launchedExecutable;
  await context.close();
  await rm(profile, { recursive: true, force: true });
  profile = await mkdtemp(path.join(tmpdir(), 'captiondrop-browser-'));
  extensionRoot = fixtureClone;
  await launch(executable);
  page = await context.newPage();
  await page.goto(`${origin}/index.html?video=one`);
  notes.push(`TEST-ONLY HOST GRANT MODE: disposable extension clone models prior grants for 127.0.0.1 and localhost${liveProviders ? ', plus the two explicit live provider hosts' : ''}. Native permission prompt UI is not covered.`);
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
const host = () => page.locator('captiondrop-player[data-captiondrop="player"]');
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
    assert.deepEqual(await background.locator('option').evaluateAll(options => options.map(option => ({ label: option.textContent, value: option.value }))), [
      { label: 'Black', value: '#000000' },
      { label: 'Transparent', value: 'transparent' },
    ]);
    assert.equal(await background.inputValue(), 'transparent');
    assert.equal(await caption().evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
    await host().locator('#font-size').evaluate(input => { input.value = '36'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await host().locator('#text-color').evaluate(input => { input.value = '#ffe088'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await background.selectOption('#000000');
    assert.equal(await caption().evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(0, 0, 0)');
    await background.selectOption('transparent');
    const style = await caption().evaluate(element => ({ size: getComputedStyle(element).fontSize, color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
    assert.deepEqual(style, { size: '36px', color: 'rgb(255, 224, 136)', background: 'rgba(0, 0, 0, 0)' });
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
    await host().locator('input[type=file]').setInputFiles(path.join(fixtures, 'invalid.srt'));
    await eventually(() => host().locator('.status').textContent(), text => /invalid|readable|timing|valid/i.test(text), 'No validation message appeared');
    await expectCaption('Drag these captions anywhere.');
    await page.screenshot({ path: path.join(artifacts, 'player-settings.png'), fullPage: true });
    await host().locator('.close').click();
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
      const control = target.locator('captiondrop-control[data-captiondrop="control"]');
      assert.equal(await control.count(), 1);
      await scan(target);
      assert.equal(await control.count(), 1, 'Repeated discovery duplicated the player button');
      await control.locator('button').click();
      assert.equal(await target.locator('captiondrop-player').locator('#settings-panel').isVisible(), true);
      await target.locator('captiondrop-player').locator('.close').click();
      await target.locator('.ytp-fullscreen-button').click();
      assert.equal(await target.locator('.ytp-fullscreen-button').getAttribute('data-clicked'), 'true');
      await eventually(() => target.evaluate(() => document.fullscreenElement?.id), id => id === 'player', 'Original nested fullscreen button stopped working');
      await target.evaluate(() => document.exitFullscreen());
    } finally { await target.close(); }
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
    assert.deepEqual(style, { size: '36px', color: 'rgb(255, 224, 136)', background: 'rgba(0, 0, 0, 0)' });
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
    const entries = await worker.evaluate(() => chrome.storage.local.get(null));
    assert.equal(Object.values(entries).filter(value => value?.identity?.includes('video=one') && typeof value.text === 'string').length, 0, 'The video still has a saved subtitle record');
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
