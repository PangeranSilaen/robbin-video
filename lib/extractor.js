'use strict';

const { parseWebUrl, fetchHtml } = require('./net');

function unescapeText(value) {
  return String(value || '')
    .replace(/\\u0026/gi, '&').replace(/\\u003d/gi, '=')
    .replace(/\\u002f/gi, '/').replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#(x[0-9a-f]+|\d+);?/gi, (_, raw) => String.fromCodePoint(raw[0].toLowerCase() === 'x' ? parseInt(raw.slice(1), 16) : Number(raw)))
    .trim();
}
function attributes(tag) {
  const out = {};
  const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = re.exec(tag))) out[match[1].toLowerCase()] = unescapeText(match[2] ?? match[3] ?? match[4]);
  return out;
}
function mediaKind(url) {
  const path = new URL(url).pathname.toLowerCase();
  if (/\.(mp4|m4v|webm|mov)$/.test(path)) return 'video';
  if (/\.m3u8$/.test(path)) return 'hls';
  if (/\.mpd$/.test(path)) return 'dash';
  return null;
}
const AD_PATTERN = /(?:^|[./_?=&-])(ads?|advert|preroll|pre-roll|midroll|mid-roll|vast|vmap|doubleclick|googlesyndication|adserver|adservice|tracking|tracker|banner|promo|commercial)(?:[./_?=&-]|$)/i;
function titleFromHtml(html) {
  const found = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return found ? unescapeText(found[1].replace(/<[^>]+>/g, '')).slice(0, 120) : '';
}
function findCandidates(html, baseUrl, originLabel = 'Halaman utama') {
  const found = new Map();
  function add(raw, label, confidence) {
    if (!raw || String(raw).length > 2048) return;
    const value = unescapeText(raw);
    let url;
    try { url = parseWebUrl(new URL(value, baseUrl).toString()); } catch { return; }
    const kind = mediaKind(url.toString());
    if (!kind || AD_PATTERN.test(url.hostname + url.pathname)) return;
    url.hash = '';
    const key = url.toString();
    const existing = found.get(key);
    if (!existing || existing.confidence < confidence) found.set(key, { url: key, kind, confidence, evidence: originLabel + ': ' + label });
  }
  for (const match of html.matchAll(/<(video|source)\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    add(attrs.src, match[1].toLowerCase() === 'video' ? 'Elemen video' : 'Elemen source', 95);
    add(attrs['data-src'], 'Data source video', 80);
  }
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attributes(match[0]);
    const name = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (/^(og:video(?::url|:secure_url)?|twitter:player:stream|contenturl|video)$/.test(name)) {
      add(a.content, 'Metadata ' + name, 92);
    }
  }
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const a = attributes(match[0]);
    if (/mpegurl|dash\+xml|video\//i.test(a.type || '')) add(a.href, 'Tautan media', 80);
  }
  // Content can be JSON-LD, escaped URLs in player configuration, or static JS objects.
  const normalized = unescapeText(html);
  for (const match of normalized.matchAll(/(?:"|')?(?:contentUrl|videoUrl|video_url|videoSrc|streamUrl|playlistUrl|manifestUrl|hlsUrl|file|sources?)\s*(?:"|')?\s*[:=]\s*(?:"|')([^"'\s<>]{8,2048})(?:"|')/gi)) {
    add(match[1], 'Konfigurasi player', 75);
  }
  for (const match of normalized.matchAll(/https?:\/\/[^\s"'<>\\]{8,2048}/gi)) {
    add(match[0].replace(/[),;]+$/, ''), 'URL media di HTML', 48);
  }
  return [...found.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 20);
}
function findPlayerIframes(html, baseUrl) {
  const urls = [];
  for (const match of html.matchAll(/<iframe\b[^>]*>/gi)) {
    const a = attributes(match[0]);
    const raw = a.src || a['data-src'];
    if (!raw || !/(?:player|embed|video|stream|watch)/i.test(raw + ' ' + (a.class || '') + ' ' + (a.id || ''))) continue;
    try {
      const url = parseWebUrl(new URL(raw, baseUrl).toString());
      if (!AD_PATTERN.test(url.hostname + url.pathname) && url.origin !== new URL(baseUrl).origin) urls.push(url.toString());
    } catch { /* ignore invalid iframe */ }
    if (urls.length >= 2) break;
  }
  return urls;
}
function uniqueRanked(candidates) {
  const unique = new Map();
  for (const c of candidates) {
    if (!unique.has(c.url) || unique.get(c.url).confidence < c.confidence) unique.set(c.url, c);
  }
  return [...unique.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 12)
    .map((c, index) => ({ ...c, id: 'media-' + (index + 1), confidence: c.confidence >= 85 ? 'high' : c.confidence >= 65 ? 'medium' : 'low' }));
}
async function extract(input) {
  const url = parseWebUrl(input);
  const direct = mediaKind(url.toString());
  if (direct) return { title: 'Media langsung', source: url.origin, candidates: uniqueRanked([{ url: url.toString(), kind: direct, confidence: 100, evidence: 'URL media langsung' }]), warnings: [] };
  const { html, finalUrl } = await fetchHtml(url.toString());
  let candidates = findCandidates(html, finalUrl);
  const warnings = [];
  if (candidates.length < 2) {
    const iframes = findPlayerIframes(html, finalUrl);
    for (const iframe of iframes) {
      try {
        const nested = await fetchHtml(iframe);
        candidates.push(...findCandidates(nested.html, nested.finalUrl, 'Embedded player'));
      } catch { warnings.push('Sebagian embedded player tidak bisa dianalisis tanpa JavaScript atau akses khusus.'); }
    }
  }
  candidates = uniqueRanked(candidates);
  if (!candidates.length) warnings.push('Belum menemukan sumber media statis. Situs mungkin memuat video lewat JavaScript, autentikasi, atau DRM.');
  if (candidates.some(c => c.confidence === 'low')) warnings.push('Beberapa kandidat hanya terdeteksi dari URL HTML. Pastikan ini video yang benar sebelum memutar.');
  return { title: titleFromHtml(html) || new URL(finalUrl).hostname, source: new URL(finalUrl).hostname, candidates, warnings };
}
module.exports = { extract, findCandidates, findPlayerIframes, mediaKind, unescapeText, uniqueRanked };
