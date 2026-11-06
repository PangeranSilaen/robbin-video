'use strict';

const form = document.querySelector('#extract-form');
const input = document.querySelector('#url-input');
const submitButton = document.querySelector('#submit-button');
const submitLabel = document.querySelector('#submit-label');
const sampleButton = document.querySelector('#sample-button');
const feedback = document.querySelector('#feedback');
const results = document.querySelector('#results');
const resultTitle = document.querySelector('#result-title');
const resultSource = document.querySelector('#result-source');
const resultCount = document.querySelector('#result-count');
const candidateList = document.querySelector('#candidate-list');
const warningsEl = document.querySelector('#warnings');
const playerSection = document.querySelector('#player-section');
const video = document.querySelector('#video-player');
const playerPlaceholder = document.querySelector('#video-placeholder');
const playerDescription = document.querySelector('#player-description');
const copyLink = document.querySelector('#copy-link');
let currentMediaUrl = '';
let activeController = null;

function setFeedback(message, variant = '') {
  feedback.textContent = message;
  feedback.className = `feedback ${variant}`;
  if (!message) feedback.classList.add('hidden');
}
function resetPlayback() {
  video.pause();
  video.removeAttribute('src');
  video.load();
  currentMediaUrl = '';
  playerSection.classList.add('hidden');
  playerPlaceholder.classList.remove('hidden');
}
function textNode(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text;
  return el;
}
function shortenUrl(value) {
  try {
    const u = new URL(value);
    // Do not display signed query tokens in the UI.
    return u.hostname + u.pathname.slice(0, 105);
  } catch { return 'Tautan media'; }
}
function renderWarnings(items) {
  warningsEl.replaceChildren();
  warningsEl.classList.toggle('hidden', !items.length);
  for (const warning of items) warningsEl.append(textNode('div', 'warning', warning));
}
function selectMedia(media) {
  currentMediaUrl = media.url;
  playerSection.classList.remove('hidden');
  playerPlaceholder.classList.add('hidden');
  video.pause();
  video.src = media.url;
  video.load();
  if (media.kind === 'dash') {
    setFeedback('DASH (.mpd) belum bisa diputar oleh player native ini. Coba kandidat MP4 atau HLS lain.', '');
    playerDescription.textContent = 'DASH terdeteksi, tetapi belum ada decoder DASH pada versi sederhana ini.';
  } else if (media.kind === 'hls' && !video.canPlayType('application/vnd.apple.mpegurl')) {
    setFeedback('HLS (.m3u8) biasanya langsung didukung Safari. Browser ini mungkin tidak dapat memutarnya.', '');
    playerDescription.textContent = 'Safari iPhone biasanya mendukung HLS secara native. Coba Safari jika video tidak muncul.';
  } else {
    setFeedback('Kandidat dipilih. Tekan Play untuk menguji apakah sumber mengizinkan pemutaran.', 'success');
    playerDescription.textContent = 'Media diambil langsung dari host aslinya. Tidak ada iframe atau JavaScript situs asal.';
  }
  playerSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function renderCandidates(data) {
  resultTitle.textContent = data.title || 'Hasil pencarian';
  resultSource.textContent = data.source || '';
  resultCount.textContent = `${data.candidates.length} kandidat`;
  candidateList.replaceChildren();
  renderWarnings(data.warnings || []);
  results.classList.remove('hidden');
  if (!data.candidates.length) return;
  for (const [index, media] of data.candidates.entries()) {
    const card = textNode('article', 'candidate', '');
    const symbol = textNode('div', 'media-icon', media.kind === 'video' ? 'MP4' : media.kind === 'hls' ? 'HLS' : 'DASH');
    const main = textNode('div', 'candidate-main', '');
    const head = textNode('div', 'candidate-head', '');
    head.append(textNode('strong', '', `Kandidat ${index + 1} | ${media.kind.toUpperCase()}`));
    const levels = { high: 'Sinyal kuat', medium: 'Perlu dicek', low: 'Sinyal lemah' };
    head.append(textNode('span', `confidence ${media.confidence}`, levels[media.confidence] || 'Belum pasti'));
    main.append(head, textNode('div', 'candidate-detail', `${media.evidence} | ${shortenUrl(media.url)}`));
    const button = textNode('button', 'candidate-button', 'Pilih video');
    button.type = 'button';
    button.addEventListener('click', () => selectMedia(media));
    card.append(symbol, main, button);
    candidateList.append(card);
  }
}
async function lookup(url) {
  if (activeController) activeController.abort();
  activeController = new AbortController();
  resetPlayback();
  results.classList.add('hidden');
  setFeedback('Sedang memeriksa HTML dan metadata video. Tidak menjalankan script dari website sumber.', 'loading');
  submitButton.disabled = true;
  submitLabel.textContent = 'Mencari...';
  try {
    const response = await fetch('/api/extract', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }), signal: activeController.signal
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Ekstraksi gagal.');
    renderCandidates(result);
    setFeedback(result.candidates.length ? 'Sumber media ditemukan. Pilih kandidat yang sesuai. Tidak ada autoplay.' : 'Belum ada sumber yang bisa dikenali dari halaman ini.', result.candidates.length ? 'success' : '');
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    if (err.name !== 'AbortError') setFeedback(err instanceof Error ? err.message : 'Koneksi gagal.');
  } finally {
    submitButton.disabled = false;
    submitLabel.textContent = 'Cari video';
  }
}
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const url = input.value.trim();
  if (!/^https?:\/\//i.test(url)) return setFeedback('Masukkan URL lengkap yang dimulai dengan https://');
  lookup(url);
});
sampleButton.addEventListener('click', () => {
  input.value = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
  form.requestSubmit();
});
video.addEventListener('error', () => {
  if (!currentMediaUrl) return;
  playerDescription.textContent = 'Video tidak bisa dibuka oleh browser. Server sumber mungkin membatasi hotlink, token, format, atau akses regional.';
  setFeedback('Media gagal diputar. Coba kandidat lain atau URL langsung yang masih aktif.', '');
});
copyLink.addEventListener('click', async () => {
  if (!currentMediaUrl) return;
  try {
    await navigator.clipboard.writeText(currentMediaUrl);
    copyLink.textContent = 'Tersalin!';
    setTimeout(() => { copyLink.textContent = 'Salin URL media'; }, 1700);
  } catch { setFeedback('Gagal menyalin URL media di browser ini.'); }
});
