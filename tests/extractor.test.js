'use strict';
const test = require('node:test');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { isPublicIPv4, parseWebUrl, makePinnedLookup, mediaTypeFromContentType, decodeHtmlBody } = require('../lib/net');
const { findCandidates, findPlayerIframes, findPlayerPages, extract } = require('../lib/extractor');

test('block private and reserved address ranges', () => {
  for (const ip of ['127.0.0.1', '10.3.5.7', '169.254.169.254', '192.168.1.1', '172.16.0.10', '100.64.0.1', '203.0.113.1', '0.0.0.0']) assert.equal(isPublicIPv4(ip), false, ip);
  assert.equal(isPublicIPv4('8.8.8.8'), true);
});
test('reject invalid schemes, local ports, credentials and IPv6', () => {
  for (const u of ['file:///etc/passwd', 'http://127.0.0.1:9000/', 'http://user:password@example.com', 'http://[::1]/', 'javascript:alert(1)']) {
    assert.throws(() => parseWebUrl(u), { name: 'Error' });
  }
});
test('extract main player while discarding obvious ads', () => {
  const html = '<title>Film test</title><video src="/media/movie.mp4"></video>' +
  '<source src="https://cdn.example.org/ads/preroll.mp4">' +
  "<script>var player = {file: 'https://cdn.example.org/stream/movie.m3u8'};</script>" +
  '<meta content="https://cdn.example.org/ads/banner.mp4" property="og:video">';
  const results = findCandidates(html, 'https://example.org/watch/1');
  assert.equal(results.length, 2);
  assert.equal(results[0].url, 'https://example.org/media/movie.mp4');
  assert.equal(results[1].kind, 'hls');
});
test('read metadata with different attribute order', () => {
  const html = '<meta content="https://cdn.example.org/real-video.mp4?token=abc&amp;x=1" property="og:video">';
  const r = findCandidates(html, 'https://example.org/watch');
  assert.equal(r[0].url, 'https://cdn.example.org/real-video.mp4?token=abc&x=1');
});
test('find plausible embedded players, not ad iframes', () => {
  const html = '<iframe src="https://video.example.org/embed/abc"></iframe><iframe src="https://ads.example.org/adserver/player"></iframe>';
  assert.deepEqual(findPlayerIframes(html, 'https://example.org/watch'), ['https://video.example.org/embed/abc']);
});
test('direct stream does not need network request', async () => {
  const result = await extract('https://media.example.org/clip.mp4');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].confidence, 'high');
});

test('pinned DNS lookup supports all-record and single-record callback modes', () => {
  const lookup = makePinnedLookup('8.8.8.8');
  let result;
  lookup('example.org', { all: true }, (...args) => { result = args; });
  assert.deepEqual(result, [null, [{ address: '8.8.8.8', family: 4 }]]);
  lookup('example.org', { all: false }, (...args) => { result = args; });
  assert.deepEqual(result, [null, '8.8.8.8', 4]);
});


test('find JS-built player iframe and prefetch, without revealing any real tokens', () => {
  const html = '<link rel="prefetch" href="https://media.example.org/stream.php?bucket=video&amp;id=sample">' +
    '<script>const playerPath = "https://media.example.org/stream.php?bucket=video\\u0026id=sample";</script>' +
    '<script>fetch("https://tracker.example.org/aclck");</script>';
  assert.deepEqual(findPlayerPages(html, 'https://media.example.org/watch/1'), ['https://media.example.org/stream.php?bucket=video&id=sample']);
});

test('do not fetch obvious advertising or private iframe destinations', () => {
  const html = '<iframe src="https://ads.example.org/adserver/player"></iframe>' +
    '<script>const playerPath = "http://127.0.0.1/private";</script>';
  assert.deepEqual(findPlayerPages(html, 'https://example.org/watch'), []);
});

test('recognize only well-defined media MIME types', () => {
  assert.equal(mediaTypeFromContentType('video/mp4; charset=binary'), 'video');
  assert.equal(mediaTypeFromContentType('application/vnd.apple.mpegurl'), 'hls');
  assert.equal(mediaTypeFromContentType('application/dash+xml'), 'dash');
  assert.equal(mediaTypeFromContentType('text/html; charset=utf-8'), null);
  assert.equal(mediaTypeFromContentType('application/octet-stream'), null);
});

test('follow dynamically declared player and classify an HTML media link', async () => {
  const calls = [];
  const root = 'https://videos.example.org/watch/example';
  const next = 'https://videos.example.org/stream.php?id=sample';
  const result = await extract(root, { fetchPage: async (url) => {
    calls.push(url);
    if (url === root) return { finalUrl: root, html: '<title>Example video</title><script>const playerPath = "' + next + '";</script>' };
    if (url === next) return { finalUrl: next, html: '<video src="https://cdn.example.org/film.mp4"></video>' };
    throw new Error('Unexpected request');
  } });
  assert.deepEqual(calls, [root, next]);
  assert.equal(result.candidates[0].url, 'https://cdn.example.org/film.mp4');
  assert.equal(result.warnings.length, 0);
});

test('only promote dynamic PHP response to playable media when its MIME is video', async () => {
  const root = 'https://media.example.org/watch/abc';
  const link = 'https://media.example.org/stream.php?token=fake';
  const result = await extract(root, { fetchPage: async (url) => url === root
    ? { finalUrl: root, html: '<script>const playerPath="' + link + '";</script>' }
    : { finalUrl: link, html: '', mediaKind: 'video' } });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].url, link);
  assert.equal(result.candidates[0].confidence, 'high');
});


test('decode Brotli HTML carrying a dynamically assigned player URL', () => {
  const html = '<link rel="prefetch" href="https://cdn.example.org/stream.php?id=test">' +
    '<script>const playerPath = "https://cdn.example.org/stream.php?id=test";</script>';
  const compressed = zlib.brotliCompressSync(Buffer.from(html));
  assert.equal(decodeHtmlBody([compressed], 'br'), html);
  assert.deepEqual(findPlayerPages(decodeHtmlBody([compressed], 'br'), 'https://cdn.example.org/watch'), ['https://cdn.example.org/stream.php?id=test']);
});

test('decode gzip and deflate HTML and reject unknown content encoding', () => {
  const html = '<title>Source test</title>';
  assert.equal(decodeHtmlBody([zlib.gzipSync(html)], 'gzip'), html);
  assert.equal(decodeHtmlBody([zlib.deflateSync(html)], 'deflate'), html);
  assert.throws(() => decodeHtmlBody([Buffer.from(html)], 'zstd'));
});

test('decompression has output size limit to reject oversized HTML', () => {
  const oversized = zlib.brotliCompressSync(Buffer.alloc(1_500_001, 65));
  assert.throws(() => decodeHtmlBody([oversized], 'br'));
});


test('detect signed extensionless video src in embedded HTML', () => {
  const html = '<video controls src="https://mp4-09.example.org/s/demo/1794000000/a/signed-id"></video>';
  const result = findCandidates(html, 'https://player.example.org/stream.php');
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'video');
  assert.equal(result[0].confidence, 95);
});

test('detect extensionless nested source without mistaking picture source for video', () => {
  const html = '<picture><source srcset="https://images.example.org/render?id=1" type="image/webp"></picture>' +
    '<video controls><source src="https://mp4.example.org/s/signed-token" type="video/mp4"></video>';
  const result = findCandidates(html, 'https://player.example.org/stream.php');
  assert.deepEqual(result.map(r => r.url), ['https://mp4.example.org/s/signed-token']);
});

test('ignore extensionless video candidates carrying obvious ad patterns', () => {
  const html = '<video src="https://cdn.example.org/ads/preroll?token=abc"></video>' +
    '<video src="https://cdn.example.org/stream/signed-video"></video>';
  const result = findCandidates(html, 'https://player.example.org');
  assert.equal(result.length, 1);
  assert.equal(result[0].url, 'https://cdn.example.org/stream/signed-video');
});

test('follow embedded HTML and find extensionless media URL', async () => {
  const root = 'https://videos.example.org/watch/id';
  const player = 'https://videos.example.org/stream.php?id=test';
  const src = 'https://cdn.example.org/s/tokenized-content';
  const out = await extract(root, { fetchPage: async (url) => {
    if (url === root) return { finalUrl: root, html: '<script>const playerPath = "' + player + '";</script>' };
    if (url === player) return { finalUrl: player, html: '<video><source src="' + src + '" type="video/mp4"></video>' };
    throw new Error('unexpected');
  } });
  assert.equal(out.candidates.length, 1);
  assert.equal(out.candidates[0].url, src);
  assert.equal(out.candidates[0].kind, 'video');
});
