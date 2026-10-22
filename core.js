(function (root, factory) {
  'use strict';
  const api = factory();
  root.CaptionDropCore = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis, function () {
  'use strict';

  const MAX_FILE_BYTES = 2 * 1024 * 1024;
  // Decoded text is bounded in UTF-16 code units, independently of file encoding.
  const MAX_TEXT_LENGTH = MAX_FILE_BYTES;
  const MAX_CUES = 20000;
  const DEFAULT_STYLE = Object.freeze({
    size: 28, color: '#ffffff', background: 'transparent', x: 0.5, y: 0.86,
  });
  const ENTITIES = Object.freeze({
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
    ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™',
    bull: '•', middot: '·', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’',
    ldquo: '“', rdquo: '”', lrm: '\u200e', rlm: '\u200f',
  });

  function decodeSubtitle(input) {
    let bytes;
    if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
    else if (input instanceof Uint8Array) bytes = input;
    else throw new Error('Choose a readable subtitle file.');
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw new Error('This subtitle file is too large. Choose an .srt file smaller than 2 MiB.');
    }
    let encoding = 'utf-8';
    let offset = 0;
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      encoding = 'utf-16le';
      offset = 2;
    } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      encoding = 'utf-16be';
      offset = 2;
    } else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      offset = 3;
    }
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset));
    } catch {
      throw new Error('This subtitle file uses an unsupported or damaged encoding. Save it as UTF-8 and try again.');
    }
  }

  function removeClosedMarkup(text, opening, closing) {
    const pieces = [];
    let cursor = 0;
    let match;
    while ((match = opening.exec(text))) {
      const end = text.indexOf(closing, opening.lastIndex);
      // No later opening can have a closing delimiter either. Leave the
      // remaining malformed text intact instead of rescanning its suffixes.
      if (end < 0) break;
      pieces.push(text.slice(cursor, match.index));
      cursor = end + closing.length;
      opening.lastIndex = cursor;
    }
    pieces.push(text.slice(cursor));
    return pieces.join('');
  }

  function replaceLineBreaks(text) {
    const opening = /<br/gi;
    const whitespace = /\s/;
    const pieces = [];
    let cursor = 0;
    let match;
    while ((match = opening.exec(text))) {
      let end = opening.lastIndex;
      while (end < text.length && whitespace.test(text[end])) end += 1;
      if (text[end] === '/') {
        end += 1;
        while (end < text.length && whitespace.test(text[end])) end += 1;
      }
      if (text[end] !== '>') {
        opening.lastIndex = end;
        continue;
      }
      pieces.push(text.slice(cursor, match.index), '\n');
      cursor = end + 1;
      opening.lastIndex = cursor;
    }
    pieces.push(text.slice(cursor));
    return pieces.join('');
  }

  function plainSubtitleText(text) {
    const withoutAss = removeClosedMarkup(text, /\{\\/g, '}');
    const withLineBreaks = replaceLineBreaks(withoutAss);
    return removeClosedMarkup(withLineBreaks, /<\/?[a-z]/gi, '>')
      .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
        if (name[0] !== '#') {
          const lower = name.toLowerCase();
          return Object.prototype.hasOwnProperty.call(ENTITIES, lower) ? ENTITIES[lower] : entity;
        }
        const hex = name[1].toLowerCase() === 'x';
        const point = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
        return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
          ? String.fromCodePoint(point) : '\ufffd';
      })
      .split('\n').map((line) => line.trimEnd()).join('\n').trim();
  }

  function parseSrt(text) {
    if (typeof text !== 'string') {
      throw new Error('This file contains no subtitles. Choose a valid .srt file.');
    }
    if (text.length > MAX_TEXT_LENGTH) {
      throw new Error('This subtitle text is too large to process. Choose a smaller SRT file.');
    }
    if (!text.trim()) {
      throw new Error('This file contains no subtitles. Choose a valid .srt file.');
    }
    const blocks = text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n').trim().split(/\n[\t ]*\n+/);
    const cues = [];
    const timing = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{1,3})(?:[\t ].*)?$/;
    for (let blockNumber = 0; blockNumber < blocks.length; blockNumber += 1) {
      const lines = blocks[blockNumber].split('\n');
      const timingLine = /^\s*\d+\s*$/.test(lines[0]) ? 1 : 0;
      const match = (lines[timingLine] || '').trim().match(timing);
      if (!match || Number(match[2]) > 59 || Number(match[3]) > 59
        || Number(match[6]) > 59 || Number(match[7]) > 59) {
        throw new Error(`Subtitle cue ${blockNumber + 1} has invalid timing. Choose a valid .srt file.`);
      }
      const start = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4]}`);
      const end = Number(match[5]) * 3600 + Number(match[6]) * 60 + Number(match[7]) + Number(`0.${match[8]}`);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        throw new Error(`Subtitle cue ${blockNumber + 1} must end after it starts.`);
      }
      const cueText = plainSubtitleText(lines.slice(timingLine + 1).join('\n'));
      if (!cueText) continue;
      cues.push({ start, end, text: cueText });
      if (cues.length > MAX_CUES) {
        throw new Error('This subtitle file has too many cues. The limit is 20,000.');
      }
    }
    if (!cues.length) throw new Error('This file contains no subtitle text. Choose a valid .srt file.');
    return cues.sort((a, b) => a.start - b.start);
  }

  function buildCueIndex(input) {
    if (!Array.isArray(input) || input.length > MAX_CUES) throw new Error('Invalid subtitle cue list.');
    for (const cue of input) {
      if (!cue || !Number.isFinite(cue.start) || !Number.isFinite(cue.end)
        || cue.start < 0 || cue.end <= cue.start || typeof cue.text !== 'string') {
        throw new Error('The subtitle contains an invalid cue.');
      }
    }
    const cues = input.slice().sort((a, b) => a.start - b.start);
    let treeSize = 1;
    while (treeSize < cues.length) treeSize *= 2;
    const maxEndTree = new Float64Array(treeSize * 2);
    maxEndTree.fill(-Infinity);
    for (let i = 0; i < cues.length; i += 1) maxEndTree[treeSize + i] = cues[i].end;
    for (let i = treeSize - 1; i > 0; i -= 1) maxEndTree[i] = Math.max(maxEndTree[i * 2], maxEndTree[i * 2 + 1]);
    return { cues, treeSize, maxEndTree };
  }

  function activeCues(index, time) {
    if (!index || !index.cues.length || !Number.isFinite(time)) return [];
    const { cues, treeSize, maxEndTree } = index;
    // Find the first cue that has not started. The interval tree then skips
    // expired ranges, even when a long cue overlaps thousands of short ones.
    let low = 0;
    let high = cues.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (cues[middle].start <= time) low = middle + 1;
      else high = middle;
    }
    const end = low;
    const result = [];
    function visit(node, left, right) {
      if (left >= end || maxEndTree[node] <= time) return;
      if (right - left === 1) {
        result.push(cues[left]);
        return;
      }
      const middle = (left + right) >>> 1;
      visit(node * 2, left, middle);
      visit(node * 2 + 1, middle, right);
    }
    if (end) visit(1, 0, treeSize);
    return result;
  }

  function bounded(value, fallback, min, max) {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  }

  function normalizeColor(value, fallback) {
    if (typeof value !== 'string') return fallback;
    if (/^#[\da-f]{6}$/i.test(value)) return value.toLowerCase();
    if (/^#[\da-f]{3}$/i.test(value)) return `#${value.slice(1).split('').map((digit) => digit + digit).join('').toLowerCase()}`;
    return fallback;
  }

  function normalizeStyle(style = {}) {
    const input = style && typeof style === 'object' ? style : {};
    return {
      size: bounded(input.size, DEFAULT_STYLE.size, 16, 64),
      color: normalizeColor(input.color, DEFAULT_STYLE.color),
      background: ['#000000', 'transparent'].includes(input.background) ? input.background : DEFAULT_STYLE.background,
      x: bounded(input.x, DEFAULT_STYLE.x, 0.05, 0.95),
      y: bounded(input.y, DEFAULT_STYLE.y, 0.05, 0.95),
    };
  }

  const TRACKING_PARAMETERS = new Set([
    'fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid', '_ga', '_gl',
    'igshid', 'spm', 'si', 'vd_source', 'share_source', 'share_medium',
  ]);
  const TIME_PARAMETERS = new Set(['t', 'time', 'start', 'end', 'seek', 'timestamp']);
  const VOLATILE_MEDIA_PARAMETERS = new Set([
    'token', 'access_token', 'sig', 'signature', 'expires', 'expire', 'expiry', 'exp',
    'auth', 'auth_key', 'key-pair-id', 'policy', 'hdnea', 'hdntl', 'range', 'rn', 'rbuf',
  ]);

  function cleanParameters(parameters, media) {
    for (const name of [...parameters.keys()]) {
      const lower = name.toLowerCase();
      if (lower.startsWith('utm_') || TRACKING_PARAMETERS.has(lower) || TIME_PARAMETERS.has(lower)
        || (media && (VOLATILE_MEDIA_PARAMETERS.has(lower) || lower.startsWith('x-amz-') || lower.startsWith('x-goog-')))) {
        parameters.delete(name);
      }
    }
    parameters.sort();
  }

  function normalizedUrl(value, base, media = false) {
    if (!value) return '';
    let url;
    try { url = new URL(value, base || undefined); } catch { return ''; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.username = '';
    url.password = '';
    cleanParameters(url.searchParams, media);
    // Hash-based app routes can identify different videos. Ordinary anchors and
    // playback fragments cannot, and all media-source fragments are discarded.
    const fragment = url.hash.slice(1);
    if (!media && (/^!?\//.test(fragment) || /^(?:video|video_id|v|episode|id)=/i.test(fragment))) {
      const separator = fragment.indexOf('?');
      if (separator >= 0) {
        const query = new URLSearchParams(fragment.slice(separator + 1));
        cleanParameters(query, false);
        url.hash = fragment.slice(0, separator) + (query.size ? `?${query}` : '');
      }
    } else url.hash = '';
    return url.href;
  }

  function pageIdentity(value) {
    const normalized = normalizedUrl(value);
    if (!normalized) return '';
    const url = new URL(normalized);
    const host = url.hostname.toLowerCase();
    if (host === 'youtu.be' || host === 'www.youtu.be' || host === 'youtube.com'
      || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) {
      let id;
      if (host === 'youtu.be' || host === 'www.youtu.be') id = url.pathname.split('/')[1];
      else if (url.pathname.replace(/\/$/, '') === '/watch') id = url.searchParams.get('v');
      else id = url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]+)/)?.[1];
      if (id && /^[\w-]+$/.test(id)) return `youtube:${id}`;
    }
    if (host === 'bilibili.com' || host.endsWith('.bilibili.com')) {
      const video = url.pathname.match(/\/video\/(BV[\da-z]+|av\d+)(?:\/|$)/i)?.[1];
      if (video) {
        const rawPart = url.searchParams.get('p');
        const part = rawPart && /^\d+$/.test(rawPart) && Number(rawPart) > 0 ? Number(rawPart) : 1;
        return `bilibili:${/^av/i.test(video) ? video.toLowerCase() : video}:p${part}`;
      }
      const episode = url.pathname.match(/\/bangumi\/play\/(ep\d+)(?:\/|$)/i)?.[1];
      if (episode) return `bilibili:${episode.toLowerCase()}`;
    }
    return normalized;
  }

  function videoKey({ pageUrl, topUrl, src, ordinal = 0 } = {}) {
    const page = pageIdentity(pageUrl);
    const top = topUrl ? pageIdentity(topUrl) : page;
    const providerKnown = page.startsWith('youtube:') || page.startsWith('bilibili:');
    const media = providerKnown ? '' : normalizedUrl(src, pageUrl, true);
    // Provider IDs already identify their logical video. Other players appearing
    // or disappearing must not change a remembered YouTube/Bilibili association.
    const slot = providerKnown ? 0
      : Number.isFinite(Number(ordinal)) ? Math.max(0, Math.floor(Number(ordinal))) : 0;
    return JSON.stringify(['captiondrop-v1', top && top !== page ? top : '', page, media, slot]);
  }

  async function hashKey(value) {
    const bytes = new TextEncoder().encode(String(value));
    if (globalThis.crypto?.subtle) {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    // Node's test runner does not expose Web Crypto in some supported versions.
    if (typeof require === 'function') return require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    throw new Error('Secure browser storage is unavailable. Reload the extension and try again.');
  }

  return Object.freeze({
    MAX_FILE_BYTES, MAX_TEXT_LENGTH, MAX_CUES, DEFAULT_STYLE, decodeSubtitle, parseSrt,
    buildCueIndex, activeCues, normalizeStyle, videoKey, hashKey,
  });
});
