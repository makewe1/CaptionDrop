/* CaptionDrop — runs only after activation or on a remembered, permitted site. */
(() => {
  'use strict';
  const Core = globalThis.CaptionDropCore;
  const extensionId = chrome.runtime?.id;
  if (!Core || !extensionId) return;
  const previous = globalThis.__captionDrop;
  if (previous?.extensionId === extensionId && !previous.disposed) return;
  previous?.dispose?.();
  const extensionOrigin = `chrome-extension://${extensionId}`;
  const takeoverEvent = `captiondrop:takeover:${extensionId}`;
  // Isolated worlds are replaced on extension reload. Retire the previous
  // instance before creating another overlay in the same document.
  document.dispatchEvent(new Event(takeoverEvent));
  document.querySelectorAll('captiondrop-player[data-captiondrop-overlay],captiondrop-control[data-captiondrop="control"],style[data-captiondrop="native-style"]').forEach(element => element.remove());

  const videos = new Map();
  const watchedRoots = new Map();
  const nativeTracks = new WeakMap();
  const attempted = new Set();
  const suppressed = new Set();
  let sequence = 0;
  let active = null;
  let topUrl = window === window.top ? location.href : '';
  let previousUrl = location.href;
  let scanTimer = 0;
  let restoreVersion = 0;
  let restoreRetryTimer = 0;
  let restoreRetryCount = 0;
  let context = { incognito: false, autoEnabled: false };
  let contextReady = false;
  let contextPromise = null;
  let disposed = false;
  let restoreSuppressed = false;
  const pageAbort = new AbortController();
  const svgIcon = '<svg viewBox="0 0 24 24" width="23" height="23" aria-hidden="true"><path d="M9.75 3a9 9 0 0 1 0 18a4.5 4.5 0 0 1 0-9a4.5 4.5 0 0 0 0-9Z" fill="currentColor"/></svg>';

  function alive() {
    if (disposed) return false;
    try { if (chrome.runtime?.id === extensionId) return true; } catch {}
    dispose();
    return false;
  }

  async function send(message) {
    if (!alive()) return { ok: false, error: 'CaptionDrop was reloaded. Reopen the extension to continue.' };
    try {
      const result = await chrome.runtime.sendMessage(message);
      return result || { ok: false, error: 'CaptionDrop could not reach its background service. Try reopening the extension.' };
    } catch (error) {
      alive();
      return { ok: false, error: 'CaptionDrop was reloaded. Reopen the extension to continue.' };
    }
  }

  async function ensureContext() {
    if (contextReady || !alive()) return;
    if (!contextPromise) {
      contextPromise = send({ type: 'CD_CONTEXT' }).then(result => {
        if (!alive() || !result.ok) return;
        context = result;
        contextReady = true;
        if (result.topUrl) topUrl = result.topUrl;
      }).finally(() => { contextPromise = null; });
    }
    await contextPromise;
  }

  function keyFor(info) {
    return Core.videoKey({
      pageUrl: location.href,
      topUrl: topUrl || location.href,
      src: sourceFor(info.video),
      ordinal: info.slot
    });
  }

  function tokenFor(identity) { return JSON.stringify(identity); }

  function fullscreenTarget() {
    let element = document.fullscreenElement;
    while (element?.shadowRoot?.fullscreenElement) element = element.shadowRoot.fullscreenElement;
    return element;
  }

  function composedContains(parent, element) {
    while (element) {
      if (parent.contains(element)) return true;
      element = element.getRootNode()?.host || null;
    }
    return false;
  }

  function sourceFor(video) {
    return video.currentSrc || video.src || video.querySelector('source[src]')?.src || '';
  }

  function providerIdentity(identity) {
    try { return /^(?:youtube|bilibili):/.test(JSON.parse(identity)[2] || ''); }
    catch { return false; }
  }

  function labelFor(video, ordinal) {
    const player = video.closest('[aria-label], .html5-video-player, .bpx-player-container');
    const named = video.getAttribute('aria-label') || video.getAttribute('title') ||
      (player && player.getAttribute('aria-label'));
    if (named && named.trim()) return named.trim().slice(0, 120);
    if (window === window.top && document.title) return `${document.title.slice(0, 100)}${videos.size > 1 ? ` · Video ${ordinal + 1}` : ''}`;
    return `Video ${ordinal + 1}`;
  }

  function list() {
    return [...videos.values()].filter(info => info.video.isConnected).map((info, ordinal) => {
      const rect = info.video.getBoundingClientRect();
      return {
        id: info.id,
        label: labelFor(info.video, ordinal),
        width: Math.round(rect.width || info.video.videoWidth || 0),
        height: Math.round(rect.height || info.video.videoHeight || 0),
        src: sourceFor(info.video),
        hasSubtitles: active?.info === info,
        fileName: active?.info === info ? active.fileName : '',
        enabled: active?.info === info ? active.enabled : false
      };
    });
  }

  function isMainVideo(info) {
    return Boolean(info.video.closest('#movie_player, .bpx-player-video-area, .bilibili-player-video-wrap'));
  }

  function restoreCandidates() {
    const connected = [...videos.values()].filter(info => info.video.isConnected);
    if (!connected.length || !providerIdentity(keyFor(connected[0]))) return connected;
    const eligible = connected.filter(info => !info.video.closest('#inline-preview-player, ytd-video-preview'));
    const main = eligible.filter(isMainVideo);
    // A provider's previews can be registered before its main player appears.
    // Keep an existing main player authoritative even while hidden, but wait
    // until it has usable bounds instead of restoring into a preview.
    return (main.length ? main : eligible).filter(info => {
      const rect = info.video.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(info.video).visibility !== 'hidden';
    }).sort((left, right) => {
      const a = left.video.getBoundingClientRect();
      const b = right.video.getBoundingClientRect();
      return b.width * b.height - a.width * a.height;
    });
  }

  function registerVideo(video) {
    if (!alive() || [...videos.values()].some(info => info.video === video)) return;
    const occupied = new Set([...videos.values()].filter(info => info.video.isConnected).map(info => info.slot));
    let slot = 0;
    while (occupied.has(slot)) slot++;
    const info = { id: `cd-video-${++sequence}`, slot, video, abort: new AbortController(), attemptedToken: null };
    videos.set(info.id, info);
    // Keep generic player slots stable while their DOM elements survive. A
    // replacement element can reuse the disconnected player's vacated slot.
    if (active?.autoRestored && active.providerKnown && isMainVideo(info) && !isMainVideo(active.info)) {
      attempted.delete(active.identityToken);
      detach();
    }
    const changed = () => {
      if (active?.info === info) checkIdentity();
      scheduleIdentityCheck();
    };
    for (const event of ['loadedmetadata', 'emptied', 'loadstart', 'play']) {
      video.addEventListener(event, changed, { signal: info.abort.signal });
    }
  }

  function discover(node) {
    if (!node || ![1, 9, 11].includes(node.nodeType)) return;
    if (node.nodeType === 1 && node.localName === 'video') registerVideo(node);
    node.querySelectorAll?.('video').forEach(registerVideo);
    if (node.nodeType === 1 && node.shadowRoot) watch(node.shadowRoot);
    // Open shadow trees are not included in querySelectorAll's result.
    node.querySelectorAll?.('*').forEach(element => {
      if (element.shadowRoot) watch(element.shadowRoot);
    });
  }

  function watch(root) {
    if (watchedRoots.has(root)) return;
    const observer = new MutationObserver(mutations => {
      if (!alive()) return;
      let dirty = false;
      let removedElements = false;
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          if (['video', 'source'].includes(mutation.target.localName)) dirty = true;
          continue;
        }
        for (const added of mutation.addedNodes) {
          if (added.nodeType !== 1 || added.hasAttribute('data-captiondrop')) continue;
          const before = videos.size;
          const rootCount = watchedRoots.size;
          discover(added);
          if (before !== videos.size || rootCount !== watchedRoots.size) dirty = true;
          if (active && !active.integrated) {
            const selector = '.ytp-right-controls,.bpx-player-control-bottom-right,.bilibili-player-video-control-bottom-right';
            if (added.matches(selector) || added.querySelector(selector)) dirty = true;
          }
        }
        if ([...mutation.removedNodes].some(node => node.nodeType === 1)) removedElements = true;
      }
      // Text counters, chat messages, images, and our own UI do not trigger
      // repeated video scans or overlay layout work.
      if (removedElements) {
        if ([...videos.values()].some(info => !info.video.isConnected)) dirty = true;
        if ([...watchedRoots.keys()].some(node => node.host && !node.host.isConnected)) dirty = true;
        if (active && (!active.host.isConnected || active.integrated && !active.integrated.isConnected)) dirty = true;
      }
      if (dirty) scheduleIdentityCheck();
    });
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'controls'] });
    watchedRoots.set(root, observer);
    discover(root);
  }

  function scan() {
    if (!alive()) return [];
    discover(document);
    cleanupRemoved();
    void restore();
    return list();
  }

  function cleanupRemoved() {
    for (const [id, info] of videos) {
      if (info.video.isConnected) continue;
      if (active?.info === info) detach();
      if (info.attemptedToken) attempted.delete(info.attemptedToken);
      info.abort.abort();
      videos.delete(id);
    }
    for (const [root, observer] of watchedRoots) {
      if (root.host && !root.host.isConnected) {
        observer.disconnect();
        watchedRoots.delete(root);
      }
    }
  }

  function scheduleIdentityCheck() {
    if (scanTimer || !alive()) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      cleanupRemoved();
      checkIdentity();
      if (active) { if (!active.host.isConnected) placeHost(active); placeControl(active); scheduleLayout(active); }
      void restore();
    }, 180);
  }

  function checkIdentity() {
    if (!active) return;
    const state = active;
    if (tokenFor(keyFor(state.info)) !== state.identityToken) { detach(); return; }
    const source = sourceFor(state.info.video);
    if (!source) return;
    if (!state.providerKnown && state.sourceFingerprint && source !== state.sourceFingerprint &&
        (/^(?:blob|data):/i.test(source) || /^(?:blob|data):/i.test(state.sourceFingerprint))) {
      // Opaque media URLs cannot safely identify another video on the same page.
      // Keep the remembered association for a future visit, but do not reuse it
      // after this page has switched the actual opaque source underneath us.
      suppressed.add(state.identityToken);
      detach();
      return;
    }
    state.sourceFingerprint = source;
  }

  async function restore() {
    if (!alive() || restoreSuppressed || active || !videos.size) return;
    await ensureContext();
    if (!alive() || !contextReady || context.incognito || context.memoryAvailable === false || restoreSuppressed || active) return;
    const version = restoreVersion;
    for (const info of restoreCandidates()) {
      if (active || version !== restoreVersion) return;
      const identity = keyFor(info);
      const token = tokenFor(identity);
      if (attempted.has(token) || suppressed.has(token)) continue;
      attempted.add(token);
      info.attemptedToken = token;
      const result = await send({ type: 'CD_RESTORE', identity });
      if (!alive() || version !== restoreVersion || active) return;
      if (!info.video.isConnected || tokenFor(keyFor(info)) !== token) continue;
      if (result.retry) {
        attempted.delete(token);
        if (!restoreRetryTimer && restoreRetryCount < 3) {
          restoreRetryTimer = setTimeout(() => {
            restoreRetryTimer = 0;
            void restore();
          }, 500 * 2 ** restoreRetryCount++);
        }
      }
      if (result.ok && result.record) {
        try {
          const record = result.record;
          const cues = Core.parseSrt(record.text);
          if (!cues.length) continue;
          attach(info, { ...record, cues, identity, remembered: true, restored: true });
          setStatus(active, 'Restored from this device.');
        } catch {
          // A damaged saved entry must never interrupt the website or playback.
        }
      }
    }
  }

  function setStatus(state, message, error = false) {
    if (!state || state !== active) return;
    state.status.textContent = message;
    state.status.classList.toggle('error', error);
  }

  function safeFileName(name) {
    return (typeof name === 'string' ? name : 'Subtitles.srt').slice(0, 160);
  }

  async function load(info, text, fileName, remember = true) {
    await ensureContext();
    if (!alive()) throw new Error('CaptionDrop was reloaded. Reopen the extension to continue.');
    remember = remember && contextReady && !context.incognito && context.memoryAvailable !== false;
    if (!info || !info.video.isConnected) throw new Error('This video is no longer available. Scan again and select a video.');
    if (typeof text !== 'string' || text.length > Core.MAX_TEXT_LENGTH) {
      throw new Error('Choose an SRT file smaller than 2 MB.');
    }
    const cues = Core.parseSrt(text);
    if (!cues.length) throw new Error('This file does not contain readable SRT subtitles.');
    const identity = keyFor(info);
    const identityToken = tokenFor(identity);
    ++restoreVersion;
    restoreSuppressed = false;
    suppressed.delete(identityToken);
    const previousStyle = active?.info === info ? active.style : Core.DEFAULT_STYLE;
    attach(info, { text, fileName: safeFileName(fileName), cues, identity, style: previousStyle, enabled: true, remembered: false });
    const state = active;
    if (!remember) {
      setStatus(state, 'Loaded for this visit.');
      return { ok: true, saved: false, private: Boolean(context.incognito), cueCount: cues.length };
    }
    setStatus(state, 'Saving on this device…');
    const result = await send({ type: 'CD_SAVE', identity, text, fileName: state.fileName, style: state.style, enabled: true });
    if (state === active) {
      state.remembered = Boolean(result.ok && result.saved);
      state.controls.forget.disabled = !state.remembered;
      if (state.remembered) queueSave(state);
      setStatus(state, state.remembered ?
        'Saved on this device. Restores on this video.' :
        (result.error || 'Captions loaded. Memory is unavailable for this visit.'), !state.remembered);
    }
    return { ok: true, saved: Boolean(result.ok && result.saved), cueCount: cues.length, ...(result.error ? { warning: result.error } : {}) };
  }

  function make(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  const STYLES = `
    :host{all:initial;display:block;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f5f5f7;line-height:1.4;color-scheme:dark;direction:ltr}
    *,*::before,*::after{box-sizing:border-box}
    button,input,select{font:inherit}button{cursor:pointer}button:focus-visible,input:focus-visible,select:focus-visible,.caption:focus-visible{outline:2px solid #90bfff;outline-offset:3px}
    [hidden]{display:none!important}
    .surface{position:absolute;inset:0;pointer-events:none}
    .caption{position:absolute;left:50%;top:86%;transform:translate(-50%,-50%);width:max-content;max-width:calc(100% - 20px);max-height:100%;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere;text-align:center;font-family:Arial,"Noto Sans",sans-serif;font-size:28px;font-weight:600;line-height:1.3;color:#fff;background:transparent;padding:3px 9px;border-radius:4px;pointer-events:auto;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;text-shadow:none;unicode-bidi:plaintext}
    .caption.dragging{cursor:grabbing;outline:1px solid rgba(255,255,255,.5)}
    .trigger{position:absolute;bottom:12px;right:54px;pointer-events:auto;width:36px;height:32px;display:grid;place-items:center;padding:0;color:white;background:rgba(20,20,22,.8);border:1px solid rgba(255,255,255,.2);border-radius:7px;opacity:.8;transition:opacity .12s}
    .surface.native-controls .trigger{bottom:56px;right:14px}
    .surface.native-controls .panel{bottom:98px;max-height:calc(100% - 110px)}
    .trigger:hover,.trigger:focus-visible{opacity:1}.trigger[aria-expanded=true]{background:#33343a;opacity:1}
    .panel{position:absolute;right:12px;bottom:54px;width:292px;max-width:calc(100% - 24px);max-height:calc(100% - 66px);overflow:auto;pointer-events:auto;color:#f5f5f7;background:rgba(27,28,31,.98);border:1px solid rgba(255,255,255,.14);border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.3);padding:16px;font-size:13px;font-weight:400;text-align:left;line-height:1.4}
    .heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:3px}.heading strong{font-size:15px;font-weight:600;letter-spacing:-.2px}
    .close{border:0;background:transparent;color:#a9abb3;width:24px;height:24px;font-size:21px;line-height:1;border-radius:4px;padding:0}.close:hover{color:white;background:#38393f}
    .filename{margin:0 0 16px;font-size:12px;color:#a9abb3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:36px}.row label{flex:1}.row output{color:#b9bbc3;font-variant-numeric:tabular-nums;font-size:12px}
    .divider{height:1px;background:rgba(255,255,255,.1);margin:12px 0}
    .file{width:100%;background:#f0f0f3;color:#17181c;border:0;border-radius:7px;min-height:34px;font-size:13px;font-weight:600;padding:7px 12px}.file:hover{background:#fff}
    .toggle{appearance:none;-webkit-appearance:none;position:relative;margin:0;width:32px;height:19px;border-radius:20px;background:#53545c;border:0;cursor:pointer;transition:background .12s}.toggle::after{content:"";position:absolute;left:3px;top:3px;width:13px;height:13px;background:#fff;border-radius:50%;transition:transform .12s}.toggle:checked{background:#5e8ff3}.toggle:checked::after{transform:translateX(13px)}
    .size{width:100%;height:20px;margin:3px 0 9px;accent-color:#a5bff7;cursor:pointer}
    input[type=color]{appearance:none;-webkit-appearance:none;width:32px;height:24px;border:1px solid #666874;border-radius:5px;padding:2px;background:transparent;cursor:pointer}input[type=color]::-webkit-color-swatch-wrapper{padding:0}input[type=color]::-webkit-color-swatch{border:0;border-radius:2px}
    .background{max-width:140px;min-height:28px;border:1px solid #666874;border-radius:5px;padding:3px 7px;color:#f5f5f7;background:#25262c;cursor:pointer}
    .hint{color:#9b9da7;font-size:11px;margin:10px 0 0}.status{font-size:11px;color:#a9abb3;margin:12px 0 0;overflow-wrap:anywhere}.status.error{color:#ffc99f}
    .forget{display:block;border:0;background:transparent;color:#b7b9c4;padding:0;margin-top:12px;font-size:11px;text-decoration:underline;text-underline-offset:3px}.forget:hover{color:white}
    @media(prefers-reduced-motion:reduce){*{transition:none!important}}
  `;

  function attach(info, options) {
    detach();
    const host = document.createElement('captiondrop-player');
    host.setAttribute('data-captiondrop', 'player');
    host.setAttribute('data-captiondrop-overlay', '');
    host.style.cssText = 'all:initial!important;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;font-size:13px!important;line-height:1.4!important;display:block!important;position:fixed!important;z-index:2147483647!important;pointer-events:none!important;margin:0!important;padding:0!important;border:0!important;';
    const root = host.attachShadow({ mode: 'closed' });
    const styleElement = make('style');
    styleElement.textContent = STYLES;
    root.append(styleElement);
    const surface = make('div', 'surface');
    const caption = make('div', 'caption');
    caption.id = 'caption-text';
    caption.hidden = true;
    caption.dir = 'auto';
    caption.tabIndex = 0;
    caption.setAttribute('role', 'group');
    caption.setAttribute('aria-label', 'Subtitles. Drag to move, or use the arrow keys.');
    caption.title = 'Drag to move subtitles';
    const trigger = make('button', 'trigger');
    trigger.type = 'button';
    trigger.innerHTML = svgIcon;
    trigger.setAttribute('aria-label', 'CaptionDrop settings');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.title = 'CaptionDrop';
    const panel = make('section', 'panel');
    panel.id = 'settings-panel';
    panel.setAttribute('aria-label', 'CaptionDrop settings');
    panel.hidden = true;
    const header = make('div', 'heading');
    const title = make('strong', '', 'CaptionDrop');
    const close = make('button', 'close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close caption settings');
    header.append(title, close);
    const fileName = make('p', 'filename', safeFileName(options.fileName));
    fileName.title = fileName.textContent;
    const fileButton = make('button', 'file', 'Choose subtitle file');
    fileButton.id = 'replace-file';
    fileButton.type = 'button';
    const enabledRow = make('div', 'row');
    const enabledLabel = make('label', '', 'Show captions');
    const enabled = make('input', 'toggle');
    enabled.type = 'checkbox';
    enabled.id = 'caption-toggle';
    enabledLabel.htmlFor = enabled.id;
    enabledRow.append(enabledLabel, enabled);
    const sizeRow = make('div', 'row');
    const sizeLabel = make('label', '', 'Text size');
    sizeLabel.htmlFor = 'font-size';
    const sizeOutput = make('output');
    sizeOutput.htmlFor = 'font-size';
    sizeRow.append(sizeLabel, sizeOutput);
    const size = make('input', 'size');
    size.type = 'range'; size.min = '16'; size.max = '64'; size.step = '1'; size.id = 'font-size';
    const textRow = make('div', 'row');
    const textLabel = make('label', '', 'Text color');
    textLabel.htmlFor = 'text-color';
    const color = make('input');
    color.type = 'color'; color.id = 'text-color';
    textRow.append(textLabel, color);
    const backgroundRow = make('div', 'row');
    const backgroundLabel = make('label', '', 'Background');
    backgroundLabel.htmlFor = 'background-color';
    const background = make('select', 'background');
    background.id = 'background-color';
    for (const [value, label] of [['#000000', 'Black'], ['transparent', 'Transparent']]) {
      const option = make('option', '', label);
      option.value = value;
      background.append(option);
    }
    backgroundRow.append(backgroundLabel, background);
    const hint = make('p', 'hint', 'Drag captions to place them anywhere on the video.');
    const status = make('p', 'status', 'Loaded for this visit.');
    status.setAttribute('role', 'status');
    const forget = make('button', 'forget', 'Forget saved subtitles');
    forget.id = 'forget';
    forget.type = 'button';
    panel.append(header, fileName, fileButton, make('div', 'divider'), enabledRow, make('div', 'divider'), sizeRow, size, textRow, backgroundRow, hint, status, forget);
    surface.append(caption, trigger, panel);
    root.append(surface);
    const state = {
      info, identity: options.identity, identityToken: tokenFor(options.identity),
      sourceFingerprint: sourceFor(info.video), providerKnown: providerIdentity(options.identity),
      text: options.text, fileName: safeFileName(options.fileName),
      cues: options.cues, index: Core.buildCueIndex(options.cues),
      style: Core.normalizeStyle(options.style || Core.DEFAULT_STYLE), enabled: options.enabled !== false,
      remembered: Boolean(options.remembered) && !context.incognito, autoRestored: Boolean(options.restored), host, root, surface, caption, trigger, panel, status,
      controls: { enabled, size, sizeOutput, color, background, forget, close },
      abort: new AbortController(), currentText: '', saveTimer: 0, frameId: null, fallbackTimer: 0,
      layoutId: 0, geometryTimer: 0, geometry: null, resize: null, integrated: null, integratedRoot: null, drag: null, disposed: false, nativeActive: false, nativeInfo: null, adObserver: null, adSuppressed: false
    };
    active = state;
    document.documentElement.append(host);
    forget.disabled = !state.remembered;
    enabled.checked = state.enabled;
    size.value = String(state.style.size);
    sizeOutput.value = `${state.style.size} px`;
    color.value = state.style.color;
    background.value = state.style.background;
    const listen = (target, event, handler, options = {}) => target.addEventListener(event, handler, { ...options, signal: state.abort.signal });
    const stopPlayer = event => event.stopPropagation();
    for (const event of ['click', 'dblclick', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'wheel']) listen(panel, event, stopPlayer);
    const togglePanel = () => setPanel(state, panel.hidden);
    listen(trigger, 'click', event => { event.stopPropagation(); togglePanel(); });
    listen(trigger, 'pointerdown', stopPlayer);
    listen(trigger, 'keydown', stopPlayer);
    listen(trigger, 'keyup', stopPlayer);
    listen(close, 'click', () => setPanel(state, false, true));
    listen(fileButton, 'click', async event => {
      if (!event.isTrusted) return;
      fileButton.disabled = true;
      const result = await send({ type: 'CD_OPEN_PICKER', videoId: info.id });
      if (state !== active) return;
      fileButton.disabled = false;
      setStatus(state, result.ok ? 'Choose your video and subtitle file in CaptionDrop.' :
        (result.error || 'Could not open the subtitle picker. Try the CaptionDrop toolbar button.'), !result.ok);
    });
    listen(enabled, 'change', event => {
      if (!event.isTrusted) { enabled.checked = state.enabled; return; }
      state.enabled = enabled.checked;
      updateNativeFullscreen(state);
      if (state.enabled) { render(state); startClock(state); }
      else { stopClock(state); state.caption.hidden = true; }
      queueSave(state);
    });
    const applySettings = event => {
      if (!event.isTrusted) {
        size.value = String(state.style.size); color.value = state.style.color; background.value = state.style.background;
        return;
      }
      const change = event.target === size ? { size: Number(size.value) } :
        event.target === color ? { color: color.value } : { background: background.value };
      state.style = Core.normalizeStyle({ ...state.style, ...change });
      sizeOutput.value = `${state.style.size} px`;
      applyAppearance(state);
      queueSave(state);
    };
    for (const control of [size, color]) listen(control, 'input', applySettings);
    listen(background, 'change', applySettings);
    listen(forget, 'click', async event => {
      if (!event.isTrusted || !alive() || context.incognito) return;
      forget.disabled = true;
      const result = await send({ type: 'CD_FORGET', identity: state.identity });
      if (state !== active) return;
      forget.disabled = false;
      if (result.ok) {
        state.remembered = false;
        forget.disabled = true;
        clearTimeout(state.saveTimer);
        suppressed.add(state.identityToken);
        setStatus(state, 'Forgotten. These captions stay loaded for this visit.');
      } else setStatus(state, result.error || 'Could not forget these saved subtitles. Try again.', true);
    });
    listen(document, 'pointerdown', event => {
      if (panel.hidden) return;
      const path = event.composedPath();
      if (!path.includes(host) && !path.includes(state.integrated)) setPanel(state, false);
    }, { capture: true });
    listen(document, 'keydown', event => {
      if (event.key === 'Escape' && !panel.hidden) {
        event.preventDefault(); event.stopPropagation(); setPanel(state, false, true);
      }
    }, { capture: true });
    setupDragging(state, listen);
    for (const event of ['timeupdate', 'seeking', 'seeked', 'ratechange', 'loadeddata', 'durationchange']) {
      listen(info.video, event, () => render(state));
    }
    listen(info.video, 'play', () => { render(state); startClock(state); });
    listen(info.video, 'pause', () => { stopClock(state); render(state); });
    listen(info.video, 'ended', () => { stopClock(state); render(state); });
    listen(document, 'fullscreenchange', () => { placeHost(state); placeControl(state); scheduleLayout(state); });
    listen(window, 'resize', () => scheduleLayout(state), { passive: true });
    listen(document, 'scroll', () => scheduleLayout(state), { capture: true, passive: true });
    listen(document, 'visibilitychange', () => {
      if (document.hidden) stopClock(state);
      else { render(state); startClock(state); scheduleLayout(state); }
    });
    if (globalThis.ResizeObserver) {
      state.resize = new ResizeObserver(() => scheduleLayout(state));
      state.resize.observe(info.video);
      if (info.video.parentElement) state.resize.observe(info.video.parentElement);
      state.resize.observe(document.documentElement);
    }
    const youtubePlayer = info.video.closest('.html5-video-player');
    if (youtubePlayer) {
      state.adSuppressed = youtubePlayer.classList.contains('ad-showing');
      state.adObserver = new MutationObserver(() => {
        if (state !== active) return;
        const showingAd = youtubePlayer.classList.contains('ad-showing');
        if (showingAd === state.adSuppressed) return;
        state.adSuppressed = showingAd;
        if (showingAd) stopClock(state);
        updateNativeFullscreen(state);
        render(state);
        startClock(state);
      });
      state.adObserver.observe(youtubePlayer, { attributes: true, attributeFilter: ['class'] });
    }
    // ResizeObserver does not report position-only layout shifts. Four bounded
    // geometry reads per second also follow moving players while playback is paused.
    state.geometryTimer = setInterval(() => {
      if (state === active && !document.hidden) layout(state);
    }, 250);
    applyAppearance(state);
    placeHost(state);
    placeControl(state);
    layout(state);
    render(state);
    startClock(state);
    return state;
  }

  function setPanel(state, open, restoreFocus = false) {
    if (state !== active) return;
    state.panel.hidden = !open;
    state.trigger.setAttribute('aria-expanded', String(open));
    state.integratedRoot?.querySelector('button')?.setAttribute('aria-expanded', String(open));
    if (open) state.controls.close.focus({ preventScroll: true });
    else if (restoreFocus) (state.integratedRoot?.querySelector('button') || state.trigger).focus({ preventScroll: true });
  }

  function applyAppearance(state) {
    const { caption, style } = state;
    caption.style.fontSize = `${style.size}px`;
    caption.style.color = style.color;
    caption.style.backgroundColor = style.background;
    updateNativeAppearance(state);
    positionCaption(state);
  }

  function positionCaption(state) {
    if (state !== active || !state.caption.isConnected) return;
    const width = state.host.clientWidth;
    const height = state.host.clientHeight;
    if (!width || !height) return;
    const halfWidth = Math.min(.5, (state.caption.offsetWidth / 2 + 4) / width);
    const halfHeight = Math.min(.5, (state.caption.offsetHeight / 2 + 4) / height);
    const x = Math.max(halfWidth, Math.min(1 - halfWidth, state.style.x));
    const y = Math.max(halfHeight, Math.min(1 - halfHeight, state.style.y));
    state.caption.style.left = `${x * 100}%`;
    state.caption.style.top = `${y * 100}%`;
  }

  function setupDragging(state, listen) {
    const caption = state.caption;
    listen(caption, 'pointerdown', event => {
      if (!event.isTrusted || event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      const bounds = state.host.getBoundingClientRect();
      const current = caption.getBoundingClientRect();
      state.drag = { pointer: event.pointerId, offsetX: event.clientX - (current.left + current.width / 2), offsetY: event.clientY - (current.top + current.height / 2), bounds };
      caption.classList.add('dragging');
      caption.setPointerCapture(event.pointerId);
    });
    listen(caption, 'pointermove', event => {
      if (!event.isTrusted || !state.drag || state.drag.pointer !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      const bounds = state.drag.bounds;
      if (!bounds.width || !bounds.height) return;
      const halfWidth = Math.min(.5, (caption.offsetWidth / 2 + 4) / bounds.width);
      const halfHeight = Math.min(.5, (caption.offsetHeight / 2 + 4) / bounds.height);
      state.style.x = Math.max(halfWidth, Math.min(1 - halfWidth, (event.clientX - bounds.left - state.drag.offsetX) / bounds.width));
      state.style.y = Math.max(halfHeight, Math.min(1 - halfHeight, (event.clientY - bounds.top - state.drag.offsetY) / bounds.height));
      positionCaption(state);
    });
    const endDrag = event => {
      if (!event.isTrusted || !state.drag) return;
      event.preventDefault(); event.stopPropagation();
      state.drag = null;
      caption.classList.remove('dragging');
      queueSave(state);
    };
    listen(caption, 'pointerup', endDrag);
    listen(caption, 'pointercancel', endDrag);
    listen(caption, 'lostpointercapture', () => {
      if (state.drag) { state.drag = null; caption.classList.remove('dragging'); queueSave(state); }
    });
    listen(caption, 'click', event => { event.preventDefault(); event.stopPropagation(); });
    listen(caption, 'dblclick', event => { event.preventDefault(); event.stopPropagation(); });
    listen(caption, 'keydown', event => {
      if (!event.isTrusted) return;
      const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const move = moves[event.key];
      event.stopPropagation();
      if (!move) return;
      event.preventDefault();
      const step = event.shiftKey ? .05 : .01;
      state.style.x = Math.max(0, Math.min(1, state.style.x + move[0] * step));
      state.style.y = Math.max(0, Math.min(1, state.style.y + move[1] * step));
      positionCaption(state);
      queueSave(state);
    });
  }

  function queueSave(state) {
    state.autoRestored = false;
    clearTimeout(state.saveTimer);
    if (!alive() || context.incognito || context.memoryAvailable === false || !state.remembered) return;
    state.saveTimer = setTimeout(() => { state.saveTimer = 0; void persistSettings(state); }, 350);
  }

  async function persistSettings(state) {
    if (!alive() || context.incognito || context.memoryAvailable === false) return;
    const result = await send({ type: 'CD_UPDATE', identity: state.identity, style: state.style, enabled: state.enabled });
    if (state === active && (!result.ok || result.saved === false)) {
      setStatus(state, result.error || 'Your change is active, but could not be remembered.', true);
    }
  }

  function placeHost(state) {
    if (state !== active) return;
    const full = fullscreenTarget();
    const directVideoFullscreen = full === state.info.video;
    updateNativeFullscreen(state);
    if (directVideoFullscreen) {
      state.host.style.setProperty('visibility', 'hidden', 'important');
      return;
    }
    const parent = full && composedContains(full, state.info.video) ? (full.shadowRoot || full) : document.documentElement;
    if (state.host.parentNode !== parent) parent.append(state.host);
    state.host.style.removeProperty('visibility');
  }

  function escapeVttText(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function updateNativeFullscreen(state) {
    if (state !== active) return;
    const needed = fullscreenTarget() === state.info.video && state.enabled && !state.adSuppressed;
    if (!needed) {
      if (state.nativeActive) {
        state.nativeActive = false;
        if (state.nativeInfo) state.nativeInfo.track.mode = 'disabled';
        removeNativeStyle(state);
        render(state);
        startClock(state);
      }
      return;
    }
    if (state.nativeActive) return;
    try {
      const video = state.info.video;
      let native = nativeTracks.get(video);
      if (!native) {
        native = { track: video.addTextTrack('subtitles', 'CaptionDrop', ''), owner: null, sheet: null, previousAttribute: null };
        native.track.mode = 'disabled';
        nativeTracks.set(video, native);
      }
      state.nativeInfo = native;
      if (native.owner !== state) {
        native.track.mode = 'hidden';
        for (const cue of [...(native.track.cues || [])]) native.track.removeCue(cue);
        native.owner = state;
        for (const cue of state.cues) {
          const item = new VTTCue(cue.start, cue.end, `<c.captiondrop>${escapeVttText(cue.text)}</c>`);
          item.snapToLines = false;
          item.align = 'center';
          item.positionAlign = 'center';
          item.lineAlign = 'center';
          native.track.addCue(item);
        }
      }
      native.previousAttribute = video.getAttribute('data-captiondrop-native');
      video.setAttribute('data-captiondrop-native', state.info.id);
      if (!native.sheet) native.sheet = make('style');
      native.sheet.setAttribute('data-captiondrop', 'native-style');
      const root = video.getRootNode();
      const styleParent = root instanceof ShadowRoot ? root : (document.head || document.documentElement);
      if (native.sheet.parentNode !== styleParent) styleParent.append(native.sheet);
      state.nativeActive = true;
      updateNativeAppearance(state);
      native.track.mode = 'showing';
      state.caption.hidden = true;
      stopClock(state);
    } catch {
      state.nativeActive = false;
      releaseNative(state);
      setStatus(state, 'This player cannot show captions in native fullscreen. Use the player’s windowed or theater view.', true);
    }
  }

  function updateNativeAppearance(state) {
    const native = state.nativeInfo;
    if (!native || !state.nativeActive) return;
    const { size, color, background, x, y } = state.style;
    native.sheet.textContent = `video[data-captiondrop-native="${state.info.id}"]::cue(.captiondrop){font-family:Arial,sans-serif;font-size:${size}px;font-weight:600;color:${color};background-color:${background};text-shadow:none}`;
    for (const cue of [...(native.track.cues || [])]) {
      cue.position = Math.max(0, Math.min(100, x * 100));
      cue.line = Math.max(0, Math.min(100, y * 100));
      cue.size = Math.max(10, Math.min(96, 2 * Math.min(x, 1 - x) * 100));
    }
  }

  function removeNativeStyle(state) {
    const native = state.nativeInfo;
    if (!native) return;
    native.sheet?.remove();
    const video = state.info.video;
    if (video.getAttribute('data-captiondrop-native') === state.info.id) {
      if (native.previousAttribute === null) video.removeAttribute('data-captiondrop-native');
      else video.setAttribute('data-captiondrop-native', native.previousAttribute);
    }
  }

  function releaseNative(state) {
    const native = state.nativeInfo;
    if (!native || native.owner !== state) return;
    native.track.mode = 'hidden';
    for (const cue of [...(native.track.cues || [])]) native.track.removeCue(cue);
    native.track.mode = 'disabled';
    native.owner = null;
    removeNativeStyle(state);
    state.nativeActive = false;
    state.nativeInfo = null;
  }

  function findControls(video) {
    const youtube = video.closest('.html5-video-player');
    if (youtube) return youtube.querySelector('.ytp-right-controls');
    const bilibili = video.closest('.bpx-player-container, .bilibili-player, .bilibili-player-video-wrap, #bilibili-player');
    if (bilibili) return bilibili.querySelector('.bpx-player-control-bottom-right, .bilibili-player-video-control-bottom-right');
    return null;
  }

  function placeControl(state) {
    if (state !== active) return;
    const controls = findControls(state.info.video);
    state.surface.classList.toggle('native-controls', !controls && state.info.video.controls);
    if (state.integrated && state.integrated.parentElement !== controls) {
      state.integrated.remove();
      state.integrated = null;
      state.integratedRoot = null;
    }
    if (controls && !state.integrated) {
      const control = document.createElement('captiondrop-control');
      control.setAttribute('data-captiondrop', 'control');
      control.style.cssText = 'display:inline-flex!important;align-items:center!important;justify-content:center!important;width:40px!important;height:100%!important;min-height:24px!important;vertical-align:top!important;pointer-events:auto!important;flex:none!important;';
      const root = control.attachShadow({ mode: 'closed' });
      const css = make('style');
      css.textContent = ':host{all:initial}button{all:unset;box-sizing:border-box;cursor:pointer;display:flex;align-items:center;justify-content:center;width:40px;height:100%;min-height:28px;color:#fff;opacity:.9}button:hover{opacity:1}button:focus-visible{outline:2px solid #90bfff;outline-offset:-3px}button[aria-expanded=true]{color:#a7c8ff}';
      const button = make('button');
      button.type = 'button';
      button.innerHTML = svgIcon;
      button.setAttribute('aria-label', 'CaptionDrop settings');
      button.setAttribute('aria-expanded', String(!state.panel.hidden));
      button.title = 'CaptionDrop';
      button.addEventListener('click', event => { event.stopPropagation(); setPanel(state, state.panel.hidden); }, { signal: state.abort.signal });
      button.addEventListener('pointerdown', event => event.stopPropagation(), { signal: state.abort.signal });
      for (const eventName of ['keydown', 'keyup']) button.addEventListener(eventName, event => event.stopPropagation(), { signal: state.abort.signal });
      root.append(css, button);
      const fullscreenButton = controls.querySelector('.ytp-fullscreen-button, .bpx-player-ctrl-full, .bilibili-player-video-btn-fullscreen');
      let anchor = fullscreenButton;
      while (anchor && anchor.parentElement !== controls) anchor = anchor.parentElement;
      controls.insertBefore(control, anchor || null);
      state.integrated = control;
      state.integratedRoot = root;
    }
    state.trigger.hidden = Boolean(controls);
  }

  function scheduleLayout(state) {
    if (state !== active || state.layoutId) return;
    state.layoutId = requestAnimationFrame(() => { state.layoutId = 0; layout(state); });
  }

  function layout(state) {
    if (state !== active || !alive()) return;
    const rect = state.info.video.getBoundingClientRect();
    const width = Math.max(0, rect.width);
    const height = Math.max(0, rect.height);
    const showing = width > 0 && height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    const geometry = [rect.left, rect.top, width, height, showing];
    if (state.geometry?.every((value, index) => value === geometry[index])) return;
    state.geometry = geometry;
    state.host.style.setProperty('left', `${rect.left}px`, 'important');
    state.host.style.setProperty('top', `${rect.top}px`, 'important');
    state.host.style.setProperty('width', `${width}px`, 'important');
    state.host.style.setProperty('height', `${height}px`, 'important');
    state.host.style.setProperty('display', showing ? 'block' : 'none', 'important');
    positionCaption(state);
  }

  function render(state) {
    if (state !== active || state.disposed || !alive()) return;
    if (sourceFor(state.info.video) !== state.sourceFingerprint) {
      checkIdentity();
      if (state !== active) return;
    }
    if (!state.enabled || state.nativeActive || state.adSuppressed) { state.caption.hidden = true; return; }
    let cues;
    try { cues = Core.activeCues(state.index, state.info.video.currentTime || 0); }
    catch { cues = []; }
    const text = cues.map(cue => cue.text).join('\n');
    if (text !== state.currentText) {
      state.currentText = text;
      // Subtitle content is never interpreted as HTML.
      state.caption.textContent = text;
      state.caption.hidden = !text;
      positionCaption(state);
    } else state.caption.hidden = !text;
  }

  function startClock(state) {
    if (state !== active || state.disposed || !alive() || state.nativeActive || state.adSuppressed || !state.enabled || state.info.video.paused || state.info.video.ended || document.hidden) return;
    if (state.frameId !== null || state.fallbackTimer) return;
    const video = state.info.video;
    if (video.requestVideoFrameCallback) {
      state.frameId = video.requestVideoFrameCallback(() => {
        state.frameId = null;
        if (state !== active) return;
        render(state);
        startClock(state);
      });
    } else {
      state.fallbackTimer = setTimeout(() => {
        state.fallbackTimer = 0;
        if (state !== active) return;
        render(state);
        startClock(state);
      }, 80);
    }
  }

  function stopClock(state) {
    if (state.frameId !== null) {
      state.info.video.cancelVideoFrameCallback?.(state.frameId);
      state.frameId = null;
    }
    clearTimeout(state.fallbackTimer);
    state.fallbackTimer = 0;
  }

  function detach(persist = true) {
    const state = active;
    if (!state) return;
    active = null;
    state.disposed = true;
    if (persist && state.saveTimer && state.remembered) void persistSettings(state);
    clearTimeout(state.saveTimer);
    stopClock(state);
    releaseNative(state);
    cancelAnimationFrame(state.layoutId);
    clearInterval(state.geometryTimer);
    state.resize?.disconnect();
    state.adObserver?.disconnect();
    state.abort.abort();
    state.integrated?.remove();
    state.host.remove();
  }

  function highlight(info) {
    if (!info?.video.isConnected) return;
    const rect = info.video.getBoundingClientRect();
    const marker = make('div');
    marker.setAttribute('data-captiondrop', 'highlight');
    marker.style.cssText = `position:fixed!important;left:${rect.left}px!important;top:${rect.top}px!important;width:${rect.width}px!important;height:${rect.height}px!important;box-sizing:border-box!important;border:3px solid #a8c9ff!important;border-radius:4px!important;pointer-events:none!important;z-index:2147483647!important;`;
    document.documentElement.append(marker);
    setTimeout(() => marker.remove(), 1000);
  }

  const runtimeListener = (message, sender, respond) => {
    if (!alive() || sender.id !== extensionId) return;
    if (sender.url && !sender.url.startsWith(`${extensionOrigin}/`)) return;
    if (sender.origin && sender.origin !== extensionOrigin) return;
    if (!message?.type?.startsWith('CD_')) return;
    if (!['CD_LIST', 'CD_LOAD', 'CD_HIGHLIGHT', 'CD_DISABLE_ALL', 'CD_CHECK_RESTORE'].includes(message.type)) return;
    const operation = async () => {
      if (message.topUrl && message.topUrl !== topUrl) {
        topUrl = message.topUrl;
        ++restoreVersion;
        restoreRetryCount = 0;
        clearTimeout(restoreRetryTimer); restoreRetryTimer = 0;
        attempted.clear();
        suppressed.clear();
        restoreSuppressed = false;
        checkIdentity();
      }
      switch (message.type) {
        case 'CD_LIST': return { ok: true, videos: scan(), frameUrl: location.href };
        case 'CD_LOAD': return await load(videos.get(message.videoId), message.text, message.fileName, message.remember !== false);
        case 'CD_HIGHLIGHT': highlight(videos.get(message.videoId)); return { ok: true };
        case 'CD_DISABLE_ALL':
          ++restoreVersion;
          restoreSuppressed = true;
          if (active) suppressed.add(active.identityToken);
          detach();
          return { ok: true };
        case 'CD_CHECK_RESTORE':
          cleanupRemoved();
          checkIdentity();
          await restore();
          return { ok: true };
        default: return { ok: false };
      }
    };
    operation().then(respond, error => respond({ ok: false, error: error.message || 'Could not load these subtitles.' }));
    return true;
  };
  chrome.runtime.onMessage.addListener(runtimeListener);

  // One low-frequency URL check handles single-page navigation on activated pages.
  const navigationTimer = setInterval(() => {
    if (!alive() || document.hidden) return;
    if (location.href !== previousUrl) {
      previousUrl = location.href;
      if (window === window.top) topUrl = location.href;
      ++restoreVersion;
      restoreRetryCount = 0;
      clearTimeout(restoreRetryTimer); restoreRetryTimer = 0;
      attempted.clear();
      suppressed.clear();
      restoreSuppressed = false;
      checkIdentity();
      discover(document);
      const version = restoreVersion;
      // Only activated documents report navigation. The background derives the
      // actual tab/frame URLs instead of observing all browser navigation.
      void send({ type: 'CD_NAVIGATED' }).then(() => {
        if (alive() && version === restoreVersion) void restore();
      });
    }
  }, 1200);

  window.addEventListener('pagehide', event => {
    if (event.persisted) { if (active) stopClock(active); return; }
    // Flush a pending user setting while this normal page still has a valid
    // extension context; takeover/invalidation disposal never persists state.
    if (active?.saveTimer && active.remembered) void persistSettings(active);
    dispose();
  }, { signal: pageAbort.signal });
  window.addEventListener('pageshow', event => {
    if (!alive()) return;
    if (event.persisted) void send({ type: 'CD_NAVIGATED' });
    if (active) { layout(active); render(active); startClock(active); }
  }, { signal: pageAbort.signal });
  document.addEventListener(takeoverEvent, () => dispose(), { signal: pageAbort.signal });

  function dispose() {
    if (disposed) return;
    disposed = true;
    ++restoreVersion;
    // Invalidation/takeover must not flush records through an obsolete context.
    detach(false);
    clearInterval(navigationTimer);
    clearTimeout(scanTimer);
    clearTimeout(restoreRetryTimer);
    for (const observer of watchedRoots.values()) observer.disconnect();
    for (const info of videos.values()) info.abort.abort();
    watchedRoots.clear(); videos.clear(); attempted.clear(); suppressed.clear();
    pageAbort.abort();
    try { chrome.runtime.onMessage.removeListener(runtimeListener); } catch {}
  }

  globalThis.__captionDrop = {
    list, scan, extensionId, dispose,
    get disposed() { return disposed; },
    get active() { return active ? { videoId: active.info.id, fileName: active.fileName, enabled: active.enabled, style: { ...active.style }, text: active.currentText } : null; }
  };
  watch(document);
  void (async () => {
    await ensureContext();
    await restore();
  })();
})();
