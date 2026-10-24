import assert from 'node:assert/strict';
import { launchHarness, eventually, delay, SRT } from './browser-harness.mjs';

const video = '<video id="v" controls muted preload="auto" style="display:block;width:480px;height:270px" src="/sample.mp4"></video>';
let alt;
const h = await launchHarness({ hostPermissions: ['http://127.0.0.1/*', 'http://localhost/*', 'https://www.youtube.com/*'], pages: {
  '/video': `<!doctype html><body>${video}`,
  '/hijack': `<!doctype html><script>window.spies=[];for(const name of ['captiondrop-player','captiondrop-control'])customElements.define(name,class extends HTMLElement{constructor(){super();spies.push(this.attachInternals())}})</script><div class="html5-video-player">${video}<div class="ytp-right-controls"><button class="ytp-fullscreen-button">Full</button></div></div>`,
  '/blocked': `<!doctype html><script>customElements.define('captiondrop-player',class extends HTMLElement{static disabledFeatures=['shadow']})</script>${video}`,
  '/embed': `<!doctype html>${video}`,
  '/shell': () => `<!doctype html><iframe src="${alt}/embed" style="width:520px;height:300px"></iframe>`,
  '/late': () => `<!doctype html><div id="slot"></div><iframe src="${alt}/embed"></iframe><script>setTimeout(()=>{document.querySelector('#slot').innerHTML=${JSON.stringify(video)}},Number(location.hash.slice(1)))</script>`,
  '/zoom': `<!doctype html><html style="zoom:1.5"><body>${video}`,
  '/transform': `<!doctype html><html style="transform:translateZ(0)"><body style="height:3000px">${video}`,
  '/dialog': `<!doctype html><dialog>${video}</dialog><script>document.querySelector('dialog').showModal()</script>`,
  '/many': url => `<!doctype html><script>for(let i=0;i<${Number(url.searchParams.get('n'))};i++){const v=document.createElement('video');v.preload='none';v.src='/sample.mp4?id='+i;v.style.cssText='width:32px;height:18px';document.documentElement.append(v)}</script>`,
} });
alt = h.altOrigin;
let passed = 0;
const failures = [];
async function check(name, action) {
  try { await action(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(error); console.error(`FAIL ${name}: ${error.stack}`); }
}
async function withPage(url, action) {
  const page = await h.context.newPage();
  try { await page.goto(url); return await action(page); }
  finally { await page.close(); }
}
const child = async tabId => (await h.frames(tabId)).find(frame => frame.frameId !== 0);
const state = async page => h.active(await h.tabIdFor(page));

try {
  await check('Page custom elements cannot access or block either closed UI host', async () => {
    await withPage(`${h.origin}/hijack`, async page => {
      assert.equal((await h.load(page, { fileName: 'private-name.srt' })).saved, true);
      assert.equal(await page.evaluate(() => spies.length), 0);
      assert.equal(await page.locator('[data-captiondrop-overlay]').evaluate(host => host.localName === 'div' && host.shadowRoot === null), true);
      assert.equal(await page.locator('[data-captiondrop="control"]').evaluate(host => host.localName === 'span' && host.shadowRoot === null), true);
    });
    await withPage(`${h.origin}/blocked`, async page => assert.equal((await h.load(page)).ok, true));
  });

  await check('Forged pagehide and pageshow cannot dispose captions or flood the worker', async () => {
    await withPage(`${h.origin}/video`, async page => {
      await h.load(page);
      const tabId = await h.tabIdFor(page);
      await h.instrument();
      await page.evaluate(() => {
        window.dispatchEvent(new Event('pagehide'));
        for (let i = 0; i < 3000; i++) window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      });
      await delay(100);
      assert.equal((await h.active(tabId)).disposed, false);
      assert.equal((await h.log()).filter(entry => entry.type === 'CD_NAVIGATED').length, 0);
    });
  });

  await check('An empty top frame updates embedded identity and restores the new SPA association', async () => {
    await withPage(`${h.origin}/shell?route=b`, async page => {
      await eventually(() => page.frames().length, count => count === 2, 'Embedded frame did not load');
      await h.load(page, { text: SRT(['Route B']) });
      await page.goto(`${h.origin}/shell?route=a`);
      await h.load(page, { text: SRT(['Route A']) });
      const tabId = await h.tabIdFor(page);
      const frameId = (await child(tabId)).frameId;
      await page.evaluate(() => history.pushState({}, '', '?route=b'));
      await eventually(() => h.active(tabId, frameId), result => result.active?.text === 'Route B', 'Embedded route B captions did not restore');
    });
  });

  await check('Documentless manual loads do not leave reservations blocking the next page', async () => {
    await withPage(`${h.origin}/shell?reservation`, async page => {
      await h.message({ type: 'CD_ENABLE_AUTO', origins: ['http://127.0.0.1/*', 'http://localhost/*'] });
      await h.load(page, { text: SRT(['Embedded memory']) });
      await page.goto(`${h.origin}/video`);
      const scan = await h.scan(page);
      assert.equal((await h.message({ type: 'CD_LOAD_VIDEO', tabId: scan.tabId, frameId: 0,
        videoId: scan.videos[0].id, text: SRT(['Top memory']) })).saved, true);
      await page.goto(`${h.origin}/shell?reservation`);
      await eventually(async () => h.active(scan.tabId, (await child(scan.tabId)).frameId), result => result.active?.text === 'Embedded memory', 'A stale root reservation blocked the iframe');
    });
  });

  await check('A late top-frame video preserves the existing embedded caption owner', async () => {
    await withPage(`${h.origin}/late#0`, async page => {
      await page.locator('#v').waitFor();
      await h.load(page, { pick: videos => videos.find(item => item.frameId === 0), text: SRT(['Top']) });
      await h.load(page, { pick: videos => videos.find(item => item.frameId !== 0), text: SRT(['Child']) });
      await page.goto('about:blank');
      await page.goto(`${h.origin}/late#1500`);
      const tabId = await h.tabIdFor(page);
      await eventually(async () => h.active(tabId, (await child(tabId)).frameId), result => result.active?.text === 'Child', 'Child captions did not restore first');
      await page.locator('#v').waitFor();
      await delay(600);
      assert.equal((await h.active(tabId)).active, null);
      assert.equal((await h.active(tabId, (await child(tabId)).frameId)).active.text, 'Child');
      await page.evaluate(() => history.pushState({}, '', '#ignored-anchor'));
      await delay(350);
      assert.equal((await h.active(tabId)).active, null, 'An ordinary anchor change released the caption owner');
    });
  });

  await check('Zoom, transformed roots and modal dialogs preserve overlay geometry and visibility', async () => {
    for (const fixture of ['zoom', 'transform', 'dialog']) await withPage(`${h.origin}/${fixture}`, async page => {
      await h.load(page);
      await page.bringToFront();
      if (fixture === 'transform') await page.evaluate(() => scrollTo(0, 200));
      await eventually(() => page.evaluate(() => {
        const video = document.querySelector('video').getBoundingClientRect();
        const host = document.querySelector('[data-captiondrop-overlay]');
        const overlay = host.getBoundingClientRect();
        return Math.max(...['left', 'top', 'width', 'height'].map(key => Math.abs(video[key] - overlay[key])));
      }), error => error < 2, `${fixture} overlay geometry is wrong`);
      if (fixture === 'dialog') assert.equal(await page.locator('[data-captiondrop-overlay]').evaluate(host => host.parentElement.localName === 'dialog' && host.matches(':popover-open')), true);
    });
  });

  await check('Native fullscreen publishes only current text and handles seeks, exit and reentry', async () => {
    await withPage(`${h.origin}/video?native-private`, async page => {
      const text = '1\n00:00:00,000 --> 00:00:10,000\nCURRENT\n\n2\n00:00:10,000 --> 00:00:20,000\nNEXT\n\n'
        + Array.from({ length: 19998 }, (_, i) => `${i + 3}\n00:00:20,000 --> 01:00:00,000\nPRIVATE-FUTURE-${i}`).join('\n\n');
      await h.load(page, { text });
      // The display limit applies in fullscreen too, with one combined native cue.
      await page.bringToFront();
      await page.locator('#v').evaluate(video => video.requestFullscreen());
      await eventually(() => page.locator('#v').evaluate(video => {
        const track = [...video.textTracks].find(track => track.label === 'CaptionDrop');
        return track?.mode === 'showing' && track.cues.length === 1 && !track.cues[0].text.includes('PRIVATE-FUTURE-19999');
      }), Boolean, 'Fullscreen exposed the full file');
      await page.locator('#v').evaluate(video => { video.pause(); video.currentTime = 15; });
      await eventually(() => page.locator('#v').evaluate(video => [...video.textTracks].some(track => track.mode === 'showing'
        && track.cues?.length === 1 && track.cues[0].text.includes('NEXT') && !track.cues[0].text.includes('CURRENT'))), Boolean, 'Native cues did not update after seeking');
      await page.evaluate(() => document.exitFullscreen());
      await page.bringToFront();
      await eventually(() => page.locator('#v').evaluate(video => !document.fullscreenElement
        && [...video.textTracks].some(track => track.label === 'CaptionDrop' && track.mode === 'disabled')),
      Boolean, 'Native fullscreen did not finish exiting');
      assert.equal(await page.locator('#v').evaluate(video => {
        const track = [...video.textTracks].find(track => track.label === 'CaptionDrop');
        track.mode = 'hidden'; const empty = track.cues.length === 0; track.mode = 'disabled'; return empty;
      }), true, 'Fullscreen exit retained native cues');
      await page.locator('#v').evaluate(video => video.requestFullscreen());
      await eventually(() => page.locator('#v').evaluate(video => [...video.textTracks].some(track => track.mode === 'showing' && track.cues?.length === 1)), Boolean, 'Native reentry failed');
      await page.evaluate(() => document.exitFullscreen());
    });
  });

  await check('The first restore after YouTube SPA navigation uses the fresh top URL', async () => {
    const page = await h.context.newPage();
    try {
      await page.route('https://www.youtube.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><video style="width:640px;height:360px"></video>' }));
      await page.goto('https://www.youtube.com/watch?v=HardeningB');
      await h.load(page, { text: SRT(['Saved B']) });
      await page.goto('https://www.youtube.com/watch?v=HardeningA');
      await h.scan(page); await delay(300); await h.instrument();
      const tabId = await h.tabIdFor(page);
      await page.evaluate(() => { history.pushState({}, '', '?v=HardeningB'); document.querySelector('video').src = '/new-video'; });
      await eventually(() => h.active(tabId), result => result.active?.text === 'Saved B', 'SPA restore failed');
      const first = (await h.log()).find(entry => entry.type === 'CD_RESTORE_BATCH');
      assert.equal(first.ok, true);
      assert.equal(first.record, true);
    } finally { await page.close(); }
  });

  await check('Many-video restore requests are batched and source churn is rate bounded', async () => {
    await withPage(`${h.origin}/many?n=3000`, async page => {
      await h.instrument();
      await h.scan(page);
      await delay(3300);
      const requests = (await h.log()).filter(entry => entry.type.startsWith('CD_RESTORE'));
      assert.ok(requests.length <= 14, `${requests.length} restore requests for 3,000 videos`);
      assert.ok(requests.every(entry => entry.type === 'CD_RESTORE_BATCH'));
    });
    await withPage(`${h.origin}/many?n=50`, async page => {
      await h.scan(page); await delay(500); await h.instrument();
      await page.evaluate(() => { let n = 0; window.churn = setInterval(() => { n++; for (const v of document.querySelectorAll('video')) v.src = `/sample.mp4?round=${n}&slot=${Math.random()}`; }, 100); });
      await delay(2100);
      await page.evaluate(() => clearInterval(window.churn));
      assert.ok((await h.log()).filter(entry => entry.type.startsWith('CD_RESTORE')).length <= 10);
    });
  });

  await check('A damaged saved caption does not block a later valid restore candidate', async () => {
    await withPage(`${h.origin}/many?n=2&damaged-restore`, async page => {
      assert.equal((await h.load(page, { fileName: 'damaged-first.srt', text: SRT(['First caption']) })).saved, true);
      assert.equal((await h.load(page, { pick: videos => videos[1], fileName: 'valid-second.srt',
        text: SRT(['Healthy next candidate']) })).saved, true);
      await h.worker.evaluate(async () => {
        const records = await chrome.storage.local.get(null);
        const key = Object.keys(records).find(key => key.startsWith('cd:caption:') && records[key]?.fileName === 'damaged-first.srt');
        if (!key) throw new Error('The first caption was not saved');
        await chrome.storage.local.set({ [key]: { ...records[key], text: 'Damaged subtitle without SRT timing' } });
      });
      await h.instrument();
      await page.reload();
      const scan = await h.scan(page);
      await eventually(() => h.active(scan.tabId), result => result.active?.fileName === 'valid-second.srt'
        && result.active.text === 'Healthy next candidate', 'The damaged first caption blocked the healthy second caption');
      const requests = (await h.log()).filter(entry => entry.type === 'CD_RESTORE_BATCH' && entry.tabId === scan.tabId);
      assert.ok(requests.length >= 2, 'Restoration did not retry after skipping the damaged record');
      assert.ok(requests.length <= 3, 'Restoration kept retrying the damaged record');
    });
  });

  await check('Compromised content cannot evict another site through forged saves', async () => {
    await withPage(`${h.origin}/video?cross-site-victim`, async victimPage => {
      const victimText = SRT(['Protected cross-site caption']);
      const fileName = 'cross-site-victim.srt';
      assert.equal((await h.load(victimPage, { text: victimText, fileName })).saved, true);
      const before = await h.worker.evaluate(() => chrome.storage.local.get(null));
      const victimKey = Object.keys(before).find(key => key.startsWith('cd:caption:') && before[key]?.fileName === fileName);
      assert.ok(victimKey, 'The victim caption was not saved');
      const settingsKey = victimKey.replace(':caption:', ':settings:');
      assert.ok(before[settingsKey], 'The victim appearance settings were not saved');
      const protectedValues = { [victimKey]: before[victimKey], [settingsKey]: before[settingsKey] };

      await withPage(`${h.altOrigin}/video?cross-site-attacker`, async attackerPage => {
        const scan = await h.scan(attackerPage);
        assert.equal(scan.ok, true);
        const responses = await h.worker.evaluate(async ({ tabId, victimOrigin, victimScope, text }) => {
          const [execution] = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [0] }, world: 'ISOLATED',
            func: async ({ victimOrigin, victimScope, text }) => {
              const responses = [];
              for (let i = 0; i < 55; i++) {
                const identity = CaptionDropCore.videoKey({ pageUrl: location.href, topUrl: location.href,
                  src: `${victimOrigin}/forged-${i}.mp4`, ordinal: i });
                responses.push(await chrome.runtime.sendMessage({ type: 'CD_SAVE', identity, text,
                  fileName: `cross-site-forged-${i}.srt`, scope: victimScope, origin: victimOrigin, topUrl: victimOrigin }));
              }
              return responses;
            },
            args: [{ victimOrigin, victimScope, text }],
          });
          return execution.result;
        }, { tabId: scan.tabId, victimOrigin: h.origin, victimScope: before[victimKey].scope, text: SRT(['Forged caption']) });
        assert.equal(responses.length, 55);
        assert.ok(responses.every(response => response.ok && response.saved), JSON.stringify(responses));

        const after = await h.worker.evaluate(() => chrome.storage.local.get(null));
        for (const [key, value] of Object.entries(protectedValues)) assert.deepEqual(after[key], value, 'Forged saves changed another site’s caption or settings');
        assert.ok(after['cd:index'].length <= 50, 'Forged saves exceeded the caption count limit');
        const forged = Object.values(after).filter(value => value?.fileName?.startsWith('cross-site-forged-'));
        assert.ok(forged.length > 0 && forged.length < 55, 'The attacker’s own old captions were not evicted');
        assert.equal(forged.some(record => record.fileName === 'cross-site-forged-0.srt'), false);
        assert.equal(forged.some(record => record.fileName === 'cross-site-forged-54.srt'), true);
      });

      await victimPage.reload();
      const scan = await h.scan(victimPage);
      await eventually(() => h.active(scan.tabId), result => result.active?.text === 'Protected cross-site caption', 'The protected victim caption could not be restored');
    });
  });
} finally { await h.close(); }
console.log(`${passed} hardening checks passed; ${failures.length} failed.`);
if (failures.length) process.exitCode = 1;
