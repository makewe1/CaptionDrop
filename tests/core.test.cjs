'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const {
  MAX_FILE_BYTES, MAX_TEXT_LENGTH, MAX_CUES, DEFAULT_STYLE, decodeSubtitle, parseSrt,
  buildCueIndex, activeCues, normalizeStyle, videoKey, hashKey,
} = require('../core.js');

test('SRT accepts mixed line endings, a BOM, missing IDs, multiline text, and both millisecond separators', () => {
  const cues = parseSrt('\ufeff2\r\n00:00:05.125 --> 00:00:07.500\r\nSecond line\r\nAnother line\r\n\r\n00:00:01,000 --> 00:00:03,250\nFirst line');
  assert.deepEqual(cues, [
    { start: 1, end: 3.25, text: 'First line' },
    { start: 5.125, end: 7.5, text: 'Second line\nAnother line' },
  ]);
});

test('styling and ASS instructions become plain text, with safe character entity decoding', () => {
  const [cue] = parseSrt('1\n00:00:00,000 --> 00:00:05,000\n{\\an8}<font color="red"><i>Tom &amp; Jo</i></font><br>&#x1F600; &#169; &lt;3 &unknown; &constructor; &#0;');
  assert.equal(cue.text, 'Tom & Jo\n😀 © <3 &unknown; &constructor; �');
});

test('markup conversion preserves line breaks, literal malformed markup, and escaped text', () => {
  const read = (body) => parseSrt(`1\n00:00:00,000 --> 00:00:05,000\n${body}`)[0].text;
  assert.equal(read('{\\an8}<B>One</B><Br \t/ >Two<br/>Three<br>Four'), 'One\nTwo\nThree\nFour');
  assert.equal(read('<font title="example">Text</font><br\u00a0/\t>Next'), 'Text\nNext');
  assert.equal(read('literal <a and {\\unfinished'), 'literal <a and {\\unfinished');
  assert.equal(read('<i <br>unfinished'), '<i\nunfinished');
  assert.equal(read('Before {\\outer{\\inner}After'), 'Before After');
  assert.equal(read('&lt;script&gt;alert(1)&lt;/script&gt; &amp;lt;b&amp;gt;'), '<script>alert(1)</script> &lt;b&gt;');
});

test('full-size malformed markup finishes within a bounded subprocess', () => {
  const source = `
    const assert = require('node:assert/strict');
    const { MAX_FILE_BYTES, parseSrt } = require(${JSON.stringify(require.resolve('../core.js'))});
    const header = '1\\n00:00:00,000 --> 00:00:05,000\\n';
    const remaining = MAX_FILE_BYTES - header.length;
    const bodies = [
      '<a'.repeat(Math.floor(remaining / 2)),
      '{' + String.fromCharCode(92),
    ];
    bodies[1] = bodies[1].repeat(Math.floor(remaining / bodies[1].length));
    bodies.push('<br' + ' '.repeat(remaining - 4) + 'x');
    for (const body of bodies) {
      assert.ok(Buffer.byteLength(header + body) <= MAX_FILE_BYTES);
      assert.equal(parseSrt(header + body)[0].text, body);
    }
  `;
  const child = spawnSync(process.execPath, ['--eval', source], {
    timeout: 5000, encoding: 'utf8', maxBuffer: 64 * 1024,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
});

test('full-size malformed timing suffixes finish within a bounded subprocess', () => {
  const source = `
    const assert = require('node:assert/strict');
    const { MAX_FILE_BYTES, parseSrt } = require(${JSON.stringify(require.resolve('../core.js'))});
    const prefix = '1\\n00:00:00,000 --> 00:00:05,000';
    for (const separator of ['\\u2028', '\\u2029']) {
      // The final non-whitespace character keeps the separator inside the
      // timing line; trim() would remove a separator at the line's end.
      const suffix = separator + 'x\\ncaption';
      const spaces = MAX_FILE_BYTES - Buffer.byteLength(prefix + suffix);
      const text = prefix + ' '.repeat(spaces) + suffix;
      assert.equal(Buffer.byteLength(text), MAX_FILE_BYTES);
      assert.throws(() => parseSrt(text), /invalid timing/);
    }
  `;
  const child = spawnSync(process.execPath, ['--eval', source], {
    timeout: 5000, encoding: 'utf8', maxBuffer: 64 * 1024,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
});

test('timing suffixes preserve optional coordinates and existing whitespace rules', () => {
  const parse = (suffix) => parseSrt(`1\n00:00:00,000 --> 00:00:05,000${suffix}\ncaption`);
  for (const suffix of ['', ' ', '\t', ' X1:1 X2:2 Y1:3 Y2:4', '\tX1:1 X2:2', '  \t  annotation', ' \u00a0annotation', ' \u2028']) {
    assert.deepEqual(parse(suffix), [{ start: 0, end: 5, text: 'caption' }], JSON.stringify(suffix));
  }
  for (const suffix of ['annotation', '\u00a0annotation', ' \u2028x', ' \u2029x', ' X1:1\u2028Y1:2']) {
    assert.throws(() => parse(suffix), /invalid timing/, JSON.stringify(suffix));
  }
});

test('invalid SRT explains the issue instead of silently accepting a damaged file', () => {
  for (const value of ['', 'not subtitles', 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello']) {
    assert.throws(() => parseSrt(value), /subtitle|timing|\.srt/i);
  }
  assert.throws(() => parseSrt('1\n00:60:00,000 --> 01:00:01,000\nhello'), /timing/);
  assert.throws(() => parseSrt('1\n00:00:02,000 --> 00:00:01,000\nhello'), /end after/);
  assert.throws(() => parseSrt('1\n00:00:00,000 --> 00:00:01,000\n<i></i>'), /no subtitle text/);
  assert.throws(() => parseSrt(Array.from({ length: MAX_CUES + 1 }, () => '00:00:00,000 --> 00:00:01,000\ntext').join('\n\n')), /20,000/);
});

test('decodeSubtitle handles UTF-8 and BOM-marked UTF-16 in both byte orders', () => {
  const text = '字幕 café 😀';
  const utf8 = new TextEncoder().encode(text);
  assert.equal(decodeSubtitle(utf8.buffer), text);
  assert.equal(decodeSubtitle(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8])), text);
  const le = Buffer.from(text, 'utf16le');
  assert.equal(decodeSubtitle(new Uint8Array([0xff, 0xfe, ...le])), text);
  const be = Buffer.from(le);
  be.swap16();
  assert.equal(decodeSubtitle(new Uint8Array([0xfe, 0xff, ...be])), text);
  // A view must decode only its selected bytes rather than its whole backing buffer.
  assert.equal(decodeSubtitle(new Uint8Array([0xff, ...utf8, 0xff]).subarray(1, utf8.length + 1)), text);
});

test('invalid encoding, truncated UTF-16, and oversized files give actionable errors', () => {
  assert.throws(() => decodeSubtitle(new Uint8Array([0xe9])), /UTF-8/);
  assert.throws(() => decodeSubtitle(new Uint8Array([0xff, 0xfe, 0x61])), /UTF-8/);
  assert.throws(() => decodeSubtitle(new Uint8Array(MAX_FILE_BYTES + 1)), /2 MiB/);
  assert.throws(() => decodeSubtitle('text'), /readable/);
});

test('valid UTF-16 subtitles remain accepted when their UTF-8 representation exceeds the file limit', () => {
  const timestamp = (time) => [Math.floor(time / 3600), Math.floor(time / 60) % 60, time % 60]
    .map((part) => String(part).padStart(2, '0')).join(':') + ',000';
  const text = Array.from({ length: 10000 }, (_, index) =>
    `${index + 1}\n${timestamp(index * 2)} --> ${timestamp(index * 2 + 2)}\n${'字'.repeat(60)}`).join('\n\n');
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  assert.ok(bytes.byteLength < MAX_FILE_BYTES);
  assert.ok(Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES);
  const decoded = decodeSubtitle(new Uint8Array(bytes));
  assert.equal(decoded, text);
  assert.ok(decoded.length <= MAX_TEXT_LENGTH);
  assert.equal(parseSrt(decoded).length, 10000);
});

test('decoded text has its own bound and accepts the exact allowed length', () => {
  const header = '1\n00:00:00,000 --> 00:00:05,000\n';
  const body = 'x'.repeat(MAX_TEXT_LENGTH - header.length);
  assert.equal(parseSrt(header + body)[0].text, body);
  assert.throws(() => parseSrt(header + body + 'x'), /subtitle text is too large to process/);
  assert.throws(() => parseSrt(' '.repeat(MAX_TEXT_LENGTH + 1)), /subtitle text is too large to process/);
});

test('indexed playback handles overlaps, exact boundaries, gaps, and backward seeks', () => {
  const cues = [
    { start: 4, end: 6, text: 'later' },
    { start: 0, end: 20, text: 'long' },
    { start: 2, end: 4, text: 'short' },
    { start: 2, end: 5, text: 'same start' },
    { start: 30, end: 31, text: 'after gap' },
  ];
  const index = buildCueIndex(cues);
  const at = (time) => activeCues(index, time).map((cue) => cue.text);
  assert.deepEqual(at(-1), []);
  assert.deepEqual(at(2), ['long', 'short', 'same start']);
  assert.deepEqual(at(4), ['long', 'same start', 'later']);
  assert.deepEqual(at(5), ['long', 'later']);
  assert.deepEqual(at(20), []);
  assert.deepEqual(at(25), []);
  assert.deepEqual(at(3), ['long', 'short', 'same start']);
  assert.deepEqual(at(30), ['after gap']);
  assert.deepEqual(at(NaN), []);
  assert.equal(cues[0].text, 'later', 'building the index must not mutate caller order');
});

test('indexed queries match the complete timeline through long overlaps and irregular seeks', () => {
  const cues = [{ start: 0, end: 100000, text: 'long overlay' }];
  for (let i = 1; i < 18000; i += 1) cues.push({ start: i * 0.25, end: i * 0.25 + (i % 17) / 10 + 0.01, text: String(i) });
  const index = buildCueIndex(cues);
  for (const time of [4000, 1, 60.5, 4499.9, 70000, 0, 20.001, 100001, 8.9]) {
    assert.deepEqual(activeCues(index, time), cues.filter((cue) => cue.start <= time && cue.end > time));
  }
});

test('invalid saved cue data is rejected before index construction', () => {
  assert.throws(() => buildCueIndex([null, { start: 0, end: 1, text: 'valid' }]), /invalid cue/);
  assert.throws(() => buildCueIndex([{ start: -1, end: 1, text: 'invalid' }]), /invalid cue/);
  assert.throws(() => buildCueIndex([{ start: 0, end: 1, text: {} }]), /invalid cue/);
  assert.deepEqual(activeCues(buildCueIndex([]), 0), []);
});

test('appearance values are clamped, colors validated, and defaults preserved', () => {
  assert.deepEqual(normalizeStyle(), DEFAULT_STYLE);
  assert.deepEqual(normalizeStyle({ size: '120', color: '#AbC', background: 'url(evil)', x: -4, y: 8 }), {
    size: 64, color: '#aabbcc', background: 'transparent', x: 0.05, y: 0.95,
  });
  assert.deepEqual(normalizeStyle({ size: NaN, color: null, x: null, y: Infinity }), DEFAULT_STYLE);
  assert.equal(normalizeStyle({ size: 4 }).size, 16);
});

test('caption backgrounds default to transparent and migrate saved custom colors to transparent', () => {
  assert.equal(DEFAULT_STYLE.background, 'transparent');
  assert.equal(normalizeStyle({ background: '#000000' }).background, '#000000');
  assert.equal(normalizeStyle({ background: 'transparent' }).background, 'transparent');
  for (const background of ['#17243a', '#fff', '#FFFFFF', 'red', 'rgba(0,0,0,0)', 'url(evil)', null]) {
    assert.equal(normalizeStyle({ background }).background, 'transparent');
  }
});

test('YouTube identity survives URL variants, tracking, time changes, and ephemeral sources', () => {
  const urls = [
    'https://www.youtube.com/watch?v=abc-123_4567&t=25&list=playlist&utm_source=test',
    'https://youtu.be/abc-123_4567?si=track',
    'https://m.youtube.com/shorts/abc-123_4567',
    'https://www.youtube-nocookie.com/embed/abc-123_4567?start=10',
  ];
  const keys = urls.map((pageUrl, i) => videoKey({ pageUrl, src: `blob:https://youtube.com/random-${i}` }));
  assert.equal(new Set(keys).size, 1);
  assert.notEqual(keys[0], videoKey({ pageUrl: 'https://www.youtube.com/watch?v=different' }));
  assert.equal(keys[0], videoKey({ pageUrl: urls[0], ordinal: 1 }));
});

test('Bilibili multipart videos and bangumi episodes keep separate memories', () => {
  const first = videoKey({ pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=333.1007&vd_source=tracking' });
  assert.equal(first, videoKey({ pageUrl: 'https://m.bilibili.com/video/BV1xx411c7mD/?p=1&t=40' }));
  assert.equal(first, videoKey({ pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD', ordinal: 7 }));
  assert.notEqual(first, videoKey({ pageUrl: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2' }));
  assert.notEqual(first, videoKey({ pageUrl: 'https://www.bilibili.com/video/BVdifferent' }));
  assert.equal(videoKey({ pageUrl: 'https://www.bilibili.com/video/av123?t=2' }), videoKey({ pageUrl: 'https://m.bilibili.com/video/av123' }));
  assert.notEqual(videoKey({ pageUrl: 'https://www.bilibili.com/bangumi/play/ep123' }), videoKey({ pageUrl: 'https://www.bilibili.com/bangumi/play/ep124' }));
  assert.equal(videoKey({ pageUrl: 'https://www.bilibili.com/bangumi/play/ep123' }), videoKey({ pageUrl: 'https://www.bilibili.com/bangumi/play/ep123', ordinal: 3 }));
});

test('generic identity preserves video selection, normalizes source tracking, and excludes blob IDs', () => {
  const common = { pageUrl: 'https://example.com/watch?id=one&utm_campaign=test&t=8#t=9', src: 'https://cdn.example.com/one.mp4?token=old&quality=hd#t=5' };
  assert.equal(videoKey(common), videoKey({ pageUrl: 'https://example.com/watch?t=20&id=one', src: 'https://cdn.example.com/one.mp4?quality=hd&token=new' }));
  assert.notEqual(videoKey(common), videoKey({ ...common, pageUrl: 'https://example.com/watch?id=two' }));
  assert.notEqual(videoKey(common), videoKey({ ...common, src: 'https://cdn.example.com/two.mp4' }));
  assert.notEqual(videoKey(common), videoKey({ ...common, ordinal: 1 }));
  assert.equal(videoKey({ ...common, src: 'blob:https://example.com/old' }), videoKey({ ...common, src: 'blob:https://example.com/new' }));
  assert.notEqual(videoKey({ pageUrl: 'https://example.com/#/watch/one' }), videoKey({ pageUrl: 'https://example.com/#/watch/two' }));
  assert.equal(videoKey({ pageUrl: 'https://example.com/#/watch/one?t=3&utm_source=test' }), videoKey({ pageUrl: 'https://example.com/#/watch/one' }));
});

test('embedded videos include their own and their parent page identities', () => {
  const frame = { pageUrl: 'https://www.youtube.com/embed/first', topUrl: 'https://example.com/article?id=1', src: 'blob:one' };
  assert.notEqual(videoKey(frame), videoKey({ ...frame, pageUrl: 'https://www.youtube.com/embed/second' }));
  assert.notEqual(videoKey(frame), videoKey({ ...frame, topUrl: 'https://example.com/article?id=2' }));
  assert.equal(videoKey(frame), videoKey({ ...frame, src: 'blob:two', topUrl: 'https://example.com/article?utm_source=tracking&id=1#comments' }));
});

test('hashing produces a stable SHA-256 storage key', async () => {
  assert.equal(await hashKey('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.notEqual(await hashKey('first'), await hashKey('second'));
});

test('core loads directly as a browser content script without CommonJS globals', () => {
  const context = vm.createContext({ TextEncoder, TextDecoder, URL, URLSearchParams });
  vm.runInContext(fs.readFileSync(require.resolve('../core.js'), 'utf8'), context);
  assert.equal(typeof context.CaptionDropCore.parseSrt, 'function');
  assert.equal(context.CaptionDropCore.normalizeStyle().size, 28);
});
