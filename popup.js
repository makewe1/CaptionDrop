'use strict';
const Core = globalThis.CaptionDropCore;
const $ = selector => document.querySelector(selector);
const list = $('#videos');
const fileInput = $('#subtitle-file');
let tabId;
let selected;
let scanResult;
let scanning = false;

function status(message, error = false) {
  $('#status').textContent = message;
  $('#status').classList.toggle('error', error);
}
async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || 'CaptionDrop could not complete this action.');
  return result;
}
function renderVideos(videos) {
  list.replaceChildren();
  $('#video-count').textContent = videos.length ? `${videos.length} found` : '';
  $('#empty').hidden = Boolean(videos.length);
  for (const video of videos) {
    const button = document.createElement('button');
    button.className = 'video-card';
    button.dataset.videoId = video.id;
    button.dataset.frameId = video.frameId;
    const preview = document.createElement('span');
    preview.className = 'preview'; preview.textContent = '▷'; preview.setAttribute('aria-hidden', 'true');
    const info = document.createElement('span'); info.className = 'info';
    const title = document.createElement('strong'); title.textContent = video.label || 'Video';
    const detail = document.createElement('small');
    let host = '';
    try { host = new URL(video.frameUrl).hostname; } catch {}
    detail.textContent = video.hasSubtitles ? `Loaded · ${video.fileName}` : `${video.width} × ${video.height}${host ? ` · ${host}` : ''}`;
    info.append(title, detail);
    const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = '+'; arrow.setAttribute('aria-hidden', 'true');
    button.append(preview, info, arrow);
    button.addEventListener('click', () => {
      selected = video;
      list.querySelectorAll('.selected').forEach(element => element.classList.remove('selected'));
      button.classList.add('selected');
      fileInput.value = '';
      // Keep the system picker directly within this click's user activation.
      fileInput.click();
    });
    list.append(button);
  }
}
async function scan() {
  if (scanning || tabId === undefined) return;
  scanning = true;
  $('#rescan').disabled = true;
  status('Looking for videos…');
  try {
    scanResult = await send({ type: 'CD_SCAN', tabId });
    renderVideos(scanResult.videos);
    const auto = $('#auto-load');
    auto.disabled = scanResult.autoEnabled || !scanResult.origin;
    auto.textContent = scanResult.autoEnabled ? 'Automatic loading enabled' : 'Enable automatic loading';
    $('#embedded-access').hidden = !scanResult.blockedOrigins.length;
    $('#memory-note').textContent = scanResult.incognito
      ? 'Private-window captions are kept only for the private session.'
      : scanResult.autoEnabled ? 'Saved captions will load when you revisit the same video.'
        : 'Allow this site once to restore saved captions on your next visit.';
    status(scanResult.videos.length
      ? 'Choose an SRT file for the video you want to caption.'
      : scanResult.blockedOrigins.length ? 'An embedded player may need site access. Enable embedded players below.'
        : 'Play the video first, then try scanning again.');
  } catch (error) {
    renderVideos([]);
    status(error.message, true);
  } finally {
    scanning = false;
    $('#rescan').disabled = false;
  }
}
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  const target = selected;
  if (!file || !target) return;
  try {
    if (!/\.srt$/i.test(file.name)) throw new Error('Choose a SubRip (.srt) subtitle file.');
    if (file.size > Core.MAX_FILE_BYTES) throw new Error('Choose an SRT file smaller than 2 MiB.');
    status('Loading your subtitles…');
    const text = Core.decodeSubtitle(await file.arrayBuffer());
    Core.parseSrt(text);
    const result = await send({ type: 'CD_LOAD_VIDEO', tabId, frameId: target.frameId,
      videoId: target.id, text, fileName: file.name });
    status(result.warning || `${file.name} loaded. Use the CaptionDrop button on your video for settings.`, Boolean(result.warning));
    const button = [...list.children].find(item => item.dataset.videoId === target.id && Number(item.dataset.frameId) === target.frameId);
    if (button) button.querySelector('small').textContent = `Loaded · ${file.name}`;
  } catch (error) { status(error.message, true); }
});
fileInput.addEventListener('cancel', () => { status('File selection cancelled. Your subtitles are unchanged.'); });
$('#rescan').addEventListener('click', scan);

function enableOrigins(origins) {
  if (!origins.length) return;
  // Request from the button handler itself, before any asynchronous work.
  chrome.permissions.request({ origins }).then(async granted => {
    if (!granted) { status('Site access was not enabled. You can still load subtitles manually.'); return; }
    await send({ type: 'CD_ENABLE_AUTO', origins });
    await scan();
    status('Site access enabled. Saved subtitles will load automatically on matching videos.');
  }).catch(error => status(error.message, true));
}
$('#auto-load').addEventListener('click', () => enableOrigins(scanResult?.origin ? [scanResult.origin] : []));
$('#embedded-access').addEventListener('click', () => enableOrigins(
  [...new Set([scanResult?.origin, ...(scanResult?.blockedOrigins || [])].filter(Boolean))]
));
(async () => {
  try {
    const requested = new URLSearchParams(location.search).get('tabId');
    if (requested && /^\d+$/.test(requested)) tabId = Number(requested);
    else tabId = (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    if (tabId === undefined) throw new Error('Open a video in a browser tab to get started.');
    await scan();
  } catch (error) { status(error.message, true); }
})();
