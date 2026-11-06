'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isPublicIPv4, parseWebUrl, makePinnedLookup } = require('../lib/net');
const { findCandidates, findPlayerIframes, extract } = require('../lib/extractor');

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
