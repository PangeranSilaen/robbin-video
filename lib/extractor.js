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
function mimeKind(type) {
  const mime = String(type || '').split(';', 1)[0].trim().toLowerCase();
  if (/^video\/(?:mp4|webm|quicktime|x-m4v|ogg)$/.test(mime)) return 'video';
  if (['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'].includes(mime)) return 'hls';
  if (mime === 'application/dash+xml') return 'dash';
  return null;
}
function findCandidates(html, baseUrl, originLabel = 'Halaman utama') {
  const found = new Map();
  function add(raw, label, confidence, kindHint = null) {
    if (!raw || String(raw).length > 2048) return;
    const value = unescapeText(raw);
    let url;
    try { url = parseWebUrl(new URL(value, baseUrl).toString()); } catch { return; }
    const kind = mediaKind(url.toString()) || kindHint;
    if (!kind || AD_PATTERN.test(url.hostname + url.pathname)) return;
    url.hash = '';
    const key = url.toString();
    const existing = found.get(key);
    if (!existing || existing.confidence < confidence) found.set(key, { url: key, kind, confidence, evidence: originLabel + ': ' + label });
  }
  // A video element is reliable evidence even when its signed URL has no extension.
  for (const match of html.matchAll(/<video\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    add(attrs.src, 'Elemen video', 95, 'video');
    add(attrs['data-src'], 'Data source video', 80, 'video');
  }
  // A source inside <video> is also evidence of media, but a <picture>
  // <source> is not. Recognized MIME types can safely disambiguate.
  for (const match of html.matchAll(/<video\b[^>]*>[\s\S]*?<\/video\s*>/gi)) {
    for (const source of match[0].matchAll(/<source\b[^>]*>/gi)) {
      const attrs = attributes(source[0]);
      const type = String(attrs.type || '').toLowerCase();
      if (type && !mimeKind(type) && !mediaKind(attrs.src || attrs['data-src'] || '')) continue;
      const kind = mimeKind(type) || 'video';
      add(attrs.src, 'Source dalam video', 94, kind);
      add(attrs['data-src'], 'Data source dalam video', 80, kind);
    }
  }
  // Standalone source tags only count when they explicitly declare video media
  // or their URL already has a known media extension.
  for (const match of html.matchAll(/<source\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const hint = mimeKind(attrs.type);
    add(attrs.src, 'Elemen source', 88, hint);
    add(attrs['data-src'], 'Data source', 75, hint);
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
    const hint = mimeKind(a.type);
    if (hint) add(a.href, 'Tautan media', 80, hint);
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

function findPlayerPages(html, baseUrl) {
  // Parse static hints only. Never execute JavaScript from the source website.
  const links = new Set();
  function add(raw) {
    if (!raw || raw.length > 2048 || links.size >= 3) return;
    try {
      const u = parseWebUrl(new URL(unescapeText(raw), baseUrl).toString());
      if (AD_PATTERN.test(u.hostname + u.pathname) || mediaKind(u.toString())) return;
      u.hash = '';
      links.add(u.toString());
    } catch { /* invalid or unsafe player address */ }
  }

  for (const match of html.matchAll(/<iframe\b[^>]*>/gi)) {
    const a = attributes(match[0]);
    const src = a.src || a['data-src'] || '';
    if (/(player|embed|video|stream|watch)/i.test(src + ' ' + (a.class || '') + ' ' + (a.id || ''))) add(src);
  }

  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const a = attributes(match[0]);
    if (/\b(prefetch|preload)\b/i.test(a.rel || '') && /(?:player|embed|stream)\b/i.test(a.href || '')) add(a.href);
  }

  const normalized = unescapeText(html);
  for (const match of normalized.matchAll(/\b(?:playerPath|playerUrl|embedUrl|iframeUrl|frameUrl|videoIframe|streamPageUrl|embedSrc)\s*[:=]\s*(["'])([^"'<>]{3,2048})\1/gi)) {
    add(match[2]);
  }
  return [...links];
}

function uniqueRanked(candidates) {
  const unique = new Map();
  for (const c of candidates) {
    if (!unique.has(c.url) || unique.get(c.url).confidence < c.confidence) unique.set(c.url, c);
  }
  return [...unique.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 12)
    .map((c, index) => ({ ...c, id: 'media-' + (index + 1), confidence: c.confidence >= 85 ? 'high' : c.confidence >= 65 ? 'medium' : 'low' }));
}
async function extract(input, options = {}) {
  const fetchPage = options.fetchPage || fetchHtml;
  const url = parseWebUrl(input);
  const direct = mediaKind(url.toString());
  if (direct) return { title: 'Media langsung', source: url.origin, candidates: uniqueRanked([{ url: url.toString(), kind: direct, confidence: 100, evidence: 'URL media langsung' }]), warnings: [] };

  const root = await fetchPage(url.toString());
  if (root.mediaKind) return { title: 'Media langsung', source: new URL(root.finalUrl).hostname, candidates: uniqueRanked([{ url: root.finalUrl, kind: root.mediaKind, confidence: 97, evidence: 'Respons media langsung' }]), warnings: [] };

  const { html, finalUrl } = root;
  let candidates = findCandidates(html, finalUrl);
  const warnings = [];
  const visited = new Set([finalUrl]);
  const queue = findPlayerPages(html, finalUrl).map(link => ({ link, depth: 1, referer: finalUrl }));
  let discoveredPages = 0;

  // Hard cap requests and depth. Handles JS-built iframe pages, not arbitrary JS execution.
  while (queue.length && discoveredPages < 3 && !candidates.some(c => c.confidence >= 90)) {
    const item = queue.shift();
    if (visited.has(item.link)) continue;
    visited.add(item.link);
    discoveredPages++;
    try {
      const page = await fetchPage(item.link, 0, item.referer);
      if (page.mediaKind) {
        candidates.push({ url: page.finalUrl, kind: page.mediaKind, confidence: 97, evidence: 'Respons media dari halaman player' });
        continue;
      }
      candidates.push(...findCandidates(page.html, page.finalUrl, 'Embedded player'));
      if (item.depth < 2 && !candidates.some(c => c.confidence >= 90)) {
        for (const nested of findPlayerPages(page.html, page.finalUrl)) {
          if (!visited.has(nested)) queue.push({ link: nested, depth: item.depth + 1, referer: page.finalUrl });
        }
      }
    } catch {
      warnings.push('Salah satu halaman player tidak dapat diakses oleh extractor server.');
    }
  }
  candidates = uniqueRanked(candidates);
  if (!candidates.length && discoveredPages) warnings.push('Halaman player ditemukan, tetapi sumber videonya masih tersembunyi. Periksa request Network setelah video benar-benar diputar.');
  if (!candidates.length && !discoveredPages) warnings.push('Tidak menemukan tautan video atau halaman player yang bisa dianalisis tanpa menjalankan JavaScript situs.');
  if (candidates.some(c => c.confidence === 'low')) warnings.push('Sebagian kandidat hanya ditemukan dari teks HTML. Pastikan videonya benar sebelum memutar.');
  return { title: titleFromHtml(html) || new URL(finalUrl).hostname, source: new URL(finalUrl).hostname, candidates, warnings };
}
module.exports = { extract, findCandidates, findPlayerIframes, findPlayerPages, mediaKind, unescapeText, uniqueRanked };
