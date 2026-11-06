'use strict';

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');

const blocked = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) blocked.addSubnet(network, prefix, 'ipv4');

function isPublicIPv4(ip) {
  return net.isIP(ip) === 4 && !blocked.check(ip, 'ipv4');
}

function parseWebUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('URL tidak valid atau terlalu panjang.');
  let url;
  try { url = new URL(input.trim()); } catch { throw new Error('Masukkan URL lengkap yang dimulai dengan https://'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Hanya URL HTTP(S) tanpa username/password yang didukung.');
  }
  if (!url.hostname || url.hostname.length > 253 || url.port && !['80', '443'].includes(url.port)) {
    throw new Error('Host atau port URL tidak didukung.');
  }
  if (net.isIP(url.hostname) === 6 || url.hostname.includes(':')) throw new Error('Alamat IPv6 langsung belum didukung.');
  if (net.isIP(url.hostname) === 4 && !isPublicIPv4(url.hostname)) throw new Error('Alamat jaringan internal tidak boleh diakses.');
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')) throw new Error('Domain lokal tidak didukung.');
  return url;
}

async function resolvePublicIPv4(hostname) {
  if (net.isIP(hostname) === 4) {
    if (!isPublicIPv4(hostname)) throw new Error('Alamat jaringan internal tidak boleh diakses.');
    return hostname;
  }
  if (net.isIP(hostname)) throw new Error('Alamat IP tidak didukung.');
  let records;
  try { records = await dns.lookup(hostname, { family: 4, all: true }); }
  catch { throw new Error('Domain tidak dapat di-resolve ke IPv4 publik.'); }
  if (!records.length || records.some(r => !isPublicIPv4(r.address))) {
    throw new Error('Domain mengarah ke jaringan privat atau alamat terlarang.');
  }
  return records[0].address;
}

// Pin a validated DNS address for the actual TCP connection to avoid a DNS rebinding race.
async function fetchHtml(input, redirects = 0) {
  if (redirects > 3) throw new Error('Terlalu banyak redirect.');
  const url = parseWebUrl(input);
  const ip = await resolvePublicIPv4(url.hostname);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    function fail(err) { if (!settled) { settled = true; reject(err); } }
    const req = transport.get(url, {
      lookup: (_host, _opts, cb) => cb(null, ip, 4),
      timeout: 9000,
      headers: {
        'User-Agent': 'RobbinVideo/1.0 (+metadata-only)',
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'Accept-Encoding': 'identity'
      }
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        fetchHtml(next, redirects + 1).then(resolve, reject);
        settled = true;
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume(); return fail(new Error(`Website merespons HTTP ${status}.`));
      }
      const type = String(res.headers['content-type'] || '').toLowerCase();
      if (type && !/text\/html|application\/xhtml\+xml/.test(type)) {
        res.resume(); return fail(new Error('URL ini bukan halaman HTML. Gunakan tautan media langsung jika tersedia.'));
      }
      const length = Number(res.headers['content-length'] || 0);
      if (length > 1_500_000) { res.destroy(); return fail(new Error('Halaman terlalu besar untuk dianalisis.')); }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1_500_000) {
          res.destroy(); fail(new Error('Halaman melebihi batas ukuran.')); return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => { if (!settled) { settled = true; resolve({ html: Buffer.concat(chunks).toString('utf8'), finalUrl: url.toString() }); } });
      res.on('error', fail);
    });
    req.on('timeout', () => req.destroy(new Error('Website terlalu lama merespons.')));
    req.on('error', fail);
  });
}

module.exports = { parseWebUrl, resolvePublicIPv4, isPublicIPv4, fetchHtml };
