'use strict';

const { extract } = require('../lib/extractor');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'GET') return res.status(200).json({ ok: true, service: 'robbin-video', status: 'ready' });
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Method tidak didukung.' }); }
  try {
    const input = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!input || typeof input.url !== 'string') return res.status(400).json({ error: 'Field url wajib berupa teks.' });
    const output = await extract(input.url);
    return res.status(200).json(output);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Gagal menganalisis URL.';
    const safe = /URL|Domain|Website|Alamat|Host|port|redirect|Halaman|jaringan|HTTP|Terlalu|hanya|hanya|di-resolve|terlalu|didukung|valid|bukan/i.test(message);
    return res.status(safe ? 422 : 502).json({ error: safe ? message : 'Website tidak dapat dianalisis saat ini.' });
  }
};
