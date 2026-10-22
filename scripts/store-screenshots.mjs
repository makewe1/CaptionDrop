import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { closedShadow } from './closed-shadow.mjs';

// Reproducible, unedited browser captures of the real unpacked extension.
// The surrounding page is an explicitly labeled sample HTML5 video, not a
// claimed integration with any video provider. No personal profile is opened.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'store/screenshots');
const temporary = await mkdtemp(path.join(tmpdir(), 'captiondrop-store-'));
const extension = path.join(temporary, 'extension');
const profile = path.join(temporary, 'profile');
const origin = 'http://127.0.0.1:19082';
let context;

const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CaptionDrop — sample video</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:#1d1d1f;font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{width:960px;margin:0 auto;padding-top:28px}header{display:flex;align-items:center;justify-content:space-between;height:40px}
.brand{display:flex;align-items:center;gap:10px;font-size:21px;font-weight:650;letter-spacing:-.5px}.brand img{width:34px;height:34px;border-radius:9px}
.eyebrow{font-size:12px;color:#6f7079;letter-spacing:.08em;text-transform:uppercase}h1{font-size:44px;line-height:1.15;letter-spacing:-1.6px;margin:22px 0 8px;font-weight:650}
.summary{font-size:17px;line-height:1.5;color:#686974;margin:0}.player{position:relative;width:960px;height:540px;margin-top:24px;overflow:hidden;border-radius:12px;background:#18243a;box-shadow:0 12px 32px #20243113}
video{display:block;width:100%;height:100%;object-fit:contain}.sample{position:absolute;top:18px;left:20px;color:#b4bfd1;font-size:12px;letter-spacing:.03em;pointer-events:none}
footer{display:flex;justify-content:space-between;margin-top:14px;font-size:12px;line-height:18px;color:#777985}
</style>
<main><header><div class="brand"><img src="/logo.png" alt="">CaptionDrop</div><div class="eyebrow">Local subtitles for Chrome</div></header>
<h1 id="headline">Your video. Your subtitles.</h1><p class="summary" id="summary">Choose a local SRT file and start watching.</p>
<div class="player"><video id="video" aria-label="Sample HTML5 video" src="/sample.mp4?store-demo=1" controls muted playsinline preload="auto"></video><span class="sample">Sample HTML5 video</span></div>
<footer><span>Demonstration video · Local SRT subtitles</span><span>No account. No subtitle uploads.</span></footer></main></html>`;

const subtitle = `1
00:00:00,000 --> 00:00:10,000
Great stories deserve clear captions.

2
00:00:10,000 --> 00:00:20,000
Make yourself comfortable.
`;

async function eventually(read, predicate, message, timeout = 7000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try { last = await read(); if (predicate(last)) return last; }
    catch (error) { last = error.message; }
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(`${message}: ${JSON.stringify(last)}`);
}

async function routeDemo(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === '/demo') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
  if (url.pathname === '/logo.png') return route.fulfill({ status: 200, contentType: 'image/png', body: await readFile(path.join(root, 'icons/icon-128.png')) });
  if (url.pathname !== '/sample.mp4') return route.fulfill({ status: 404, body: '' });
  const bytes = await readFile(path.join(root, 'tests/fixtures/sample.mp4'));
  const range = request.headers().range?.match(/^bytes=(\d+)-(\d*)$/);
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    return route.fulfill({ status: 206, contentType: 'video/mp4', headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${bytes.length}` }, body: bytes.subarray(start, end + 1) });
  }
  return route.fulfill({ status: 200, contentType: 'video/mp4', headers: { 'Accept-Ranges': 'bytes' }, body: bytes });
}

async function setControl(host, selector, value) {
  const control = host.locator(selector);
  const settings = await control.evaluate(element => ({
    type: element.type, min: element.min, max: element.max, step: element.step,
    options: element.tagName === 'SELECT' ? [...element.options].map(option => option.value) : null,
  }));
  let steps;
  let key;
  if (settings.options) {
    steps = settings.options.indexOf(value);
    assert.ok(steps >= 0, `Unknown option for ${selector}: ${value}`);
    key = 'ArrowDown';
  } else {
    assert.equal(settings.type, 'range', 'Screenshot settings must support trusted keyboard input.');
    const target = Number(value);
    assert.ok(target >= Number(settings.min) && target <= Number(settings.max));
    steps = (target - Number(settings.min)) / Number(settings.step || 1);
    assert.ok(Number.isInteger(steps));
    key = 'ArrowRight';
  }
  // Native keyboard input produces trusted events, just like the user's controls.
  await control.focus();
  await control.press('Home');
  for (let step = 0; step < steps; step += 1) await control.press(key);
  assert.equal(await control.inputValue(), value);
}

async function presentVideoFrame(page, time) {
  await page.locator('#video').evaluate(async (video, target) => {
    if (video.seeking || Math.abs(video.currentTime - target) > .01) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('The sample video did not finish seeking.')), 7000);
        video.addEventListener('seeked', () => { clearTimeout(timeout); resolve(); }, { once: true });
        video.currentTime = target;
      });
    }
    if (video.readyState < 2) {
      await new Promise(resolve => video.addEventListener('loadeddata', resolve, { once: true }));
    }
    const presented = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('The sample video did not present a decoded frame.')), 7000);
      const finish = () => { clearTimeout(timeout); resolve(); };
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(finish);
      else video.addEventListener('timeupdate', finish, { once: true });
    });
    await Promise.all([video.play(), presented]);
    video.pause();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (video.seeking || video.readyState < 2) throw new Error('The sample video is still buffering.');
  }, time);
}

async function capture(page, name) {
  const file = path.join(destination, `${name}.png`);
  await page.mouse.move(1225, 765);
  await page.screenshot({ path: file, type: 'png', omitBackground: false, animations: 'disabled' });
  const png = await readFile(file);
  assert.equal(png.readUInt32BE(16), 1280, 'Store screenshot width must be 1280.');
  assert.equal(png.readUInt32BE(20), 800, 'Store screenshot height must be 800.');
  assert.equal(png[24], 8, 'Store PNG must use 8-bit channels.');
  if (png[25] !== 2) {
    // Capture directly as JPEG if the browser's PNG encoder uses an alpha
    // channel. Do not strip channels or edit pixels after capture.
    await rm(file);
    const jpeg = path.join(destination, `${name}.jpg`);
    await page.screenshot({ path: jpeg, type: 'jpeg', quality: 96, omitBackground: false, animations: 'disabled' });
    console.log(`Saved ${path.relative(root, jpeg)} (1280×800 JPEG, no alpha)`);
    return;
  }
  console.log(`Saved ${path.relative(root, file)} (1280×800, 24-bit RGB PNG, no alpha)`);
}

try {
  await mkdir(destination, { recursive: true });
  await mkdir(extension, { recursive: true });
  for (const file of ['manifest.json', 'background.js', 'core.js', 'content.js', 'popup.html', 'popup.js', 'popup.css', 'icons']) {
    await cp(path.join(root, file), path.join(extension, file), { recursive: true });
  }
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(path.join(extension, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const executablePath = process.env.CAPTIONDROP_BROWSER_PATH || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
  context = await chromium.launchPersistentContext(profile, {
    ...(executablePath ? { executablePath } : {}), headless: true,
    viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--no-sandbox', '--no-first-run', '--no-default-browser-check', '--enable-unsafe-extension-debugging', '--disable-features=DisableLoadExtensionCommandLineSwitch', `--load-extension=${extension}`],
  });
  await context.route(`${origin}/**`, routeDemo);
  if (!context.serviceWorkers().length) {
    const cdp = await context.browser().newBrowserCDPSession();
    try { await cdp.send('Extensions.loadUnpacked', { path: extension }); }
    finally { await cdp.detach(); }
  }
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 7000 });
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`${origin}/demo`);
  await page.locator('#video').evaluate(video => video.readyState >= 2 ? undefined : new Promise(resolve => video.addEventListener('loadeddata', resolve, { once: true })));
  await page.bringToFront();
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  await eventually(() => popup.locator('.video-card').count(), count => count === 1, 'The real extension did not find the sample video');
  const choosing = popup.waitForEvent('filechooser');
  await popup.locator('.video-card').click();
  await (await choosing).setFiles({ name: 'sample-captions.srt', mimeType: 'application/x-subrip', buffer: Buffer.from(subtitle) });
  const host = closedShadow(page, 'captiondrop-player[data-captiondrop-overlay]');
  await eventually(() => host.count(), count => count === 1, 'The real extension did not attach captions');
  await page.bringToFront();
  await presentVideoFrame(page, 4);
  await eventually(() => host.locator('#caption-text').textContent(), text => text === 'Great stories deserve clear captions.', 'Caption text did not synchronize');
  await host.locator('.trigger').click();
  await setControl(host, '#font-size', '36');
  await host.locator('.close').click();
  await capture(page, '01-local-subtitles');

  await page.locator('#headline').evaluate(element => { element.textContent = 'Make captions feel like yours.'; });
  await page.locator('#summary').evaluate(element => { element.textContent = 'Choose the size, text color, and a black or transparent background. Drag captions to find the perfect position.'; });
  await presentVideoFrame(page, 12);
  await eventually(() => host.locator('#caption-text').textContent(), text => text === 'Make yourself comfortable.', 'Second caption did not synchronize');
  await host.locator('.trigger').click();
  await setControl(host, '#font-size', '36');
  await setControl(host, '#background-color', 'transparent');
  await host.locator('.close').click();
  const caption = host.locator('#caption-text');
  const bounds = await caption.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(480, 492, { steps: 16 });
  await page.mouse.up();
  await host.locator('.trigger').click();
  await eventually(() => host.locator('#settings-panel').isVisible(), visible => visible, 'Caption settings are not visible');
  await eventually(() => host.locator('.status').textContent(), text => /Saved on this device/.test(text), 'The local memory status has not settled');
  await capture(page, '02-caption-appearance');
  console.log('Captured real extension UI with a disposable, localhost-only permission grant. Source manifest and user browser profile were not changed.');
} finally {
  await context?.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
