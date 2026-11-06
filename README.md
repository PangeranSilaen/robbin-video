# Robbin Video

Pemutar video sederhana tanpa framework. Tempel URL video/halaman, ekstrak kandidat media dari HTML dan metadata publik, pilih kandidat, lalu putar menggunakan elemen `<video>` bawaan browser. Tidak ada iframe, iklan, atau JavaScript dari halaman sumber yang dimuat.

## Teknologi

- Frontend: `public/index.html`, `public/style.css`, `public/app.js` (vanilla HTML/CSS/JS).
- Backend: `api/extract.js` (Vercel Node.js Function) + `lib/`.
- Dependencies eksternal: **0**. Tidak ada database, akun, yt-dlp, atau browser headless.

## Deploy Vercel

Hubungkan repository GitHub ke Vercel, pilih preset **Other** / framework **None**, root directory `./`, dan deploy. Vercel melayani `public/` sebagai static assets serta `api/extract.js` sebagai Function. `vercel.json` membatasi Function hingga 20 detik.

## Tes lokal

```bash
npm test
npx vercel dev
```

`npm test` tidak membutuhkan instalasi dependency.

## Keterbatasan penting

- **Bukan universal extractor 100%.** Backend hanya mengambil HTML/metadata statis dan hingga dua iframe player yang relevan, tanpa menjalankan JavaScript. Video yang muncul hanya setelah browser menjalankan script, memerlukan login, signed headers, anti-bot, atau DRM tidak selalu ditemukan.
- Pemutar native iPhone Safari mendukung MP4 dan HLS (.m3u8). Browser desktop bisa punya dukungan format berbeda. DASH (.mpd) saat ini hanya ditemukan sebagai kandidat, belum bisa diputar native.
- Backend **tidak mem-proxy video**, jadi server media tetap dapat menolak hotlink, referer, CORS, geoblocking, atau token kedaluwarsa.
- Kandidat dinilai berdasarkan markup dan metadata, lalu filter pola iklan yang jelas. Ini **bukan jaminan** video tersebut bukan iklan. Untuk mencegah salah putar, tidak ada autoplay, dan pengguna memilih kandidat sendiri.
- Karena URL publik sebarang dapat menyebabkan pemakaian fungsi backend, pertimbangkan Deployment Protection atau rate limiting Vercel jika aplikasi dibuka publik secara luas.
- Gunakan untuk media yang boleh kamu akses sesuai hak dan ketentuan sumber. Aplikasi tidak membypass DRM/login.

## Keamanan

- Backend menerima hanya HTTP(S) dan port default (80/443); kredensial URL ditolak.
- DNS IPv4 di-resolve sebelum request, IP private/reserved ditolak, alamat terpilih dipin untuk koneksi TCP dan setiap redirect diperiksa ulang. IPv6 langsung belum didukung demi default fail-closed.
- Maksimal 3 redirect, 9 detik per request, HTML <= 1.5 MB, iframe eksternal maksimal 2. Tidak ada cookies, header Authorization, atau halaman asal yang dieksekusi.
- Response `no-store`, player memakai referrer policy `no-referrer`, dan HTML merender data melalui `textContent`, bukan `innerHTML`.