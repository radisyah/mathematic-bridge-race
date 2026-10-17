# Mathematic Bridge Race — Online (sampai 10 pemain) untuk Vercel

Balapan hitung di jembatan: satu soal berlaku untuk seluruh jembatan, kamu harus berdiri di ubin berangka jawaban
benar sebelum ubin salah hilang. Siapa yang lebih dulu sampai **FINISH** menang. Struktur proyek ini sengaja
disamakan dengan *War of Kingdoms Online* (Vercel Function + Upstash Redis + polling).

## Kenapa bukan WebSocket?

Versi awal `index.html` memakai `new WebSocket(...)` yang butuh server yang terus hidup. **Vercel Functions tidak
bisa menahan koneksi WebSocket**, jadi jaringannya diganti polling ke satu endpoint `/api/room`. Tampilan, fisika,
joystick, audio, dan aturan permainan tidak diubah.

```
Browser 1 ─┐                                   ┌─ Upstash Redis (state room, posisi, kunci)
Browser 2 ─┼─ polling ~0,2 dtk ─ /api/room ────┤
   ...     │   (Vercel Function)               └─ public/game-core.js (soal & aturan, dipakai server + klien)
Browser 10 ┘
```

- **Server = wasit**: membuat soal, mengatur waktu ronde (5 dtk jawab → 2 dtk ubin salah hilang → soal baru),
  dan menentukan pemenang. Semua pemain selalu melihat soal & angka ubin yang sama.
- **Posisi pemain** dikirim tiap ~0,2 dtk bersama polling, lalu diperhalus di klien (interpolasi + prediksi singkat).
- **Tenggat ronde dijalankan "secara malas"** di tiap request (serverless tidak punya proses latar). Lock Redis
  memastikan ronde maju tepat sekali walau 10 pemain sync bersamaan.
- Pemenang = pemain pertama yang melapor sampai FINISH **di dalam lock**, dengan pemeriksaan posisi dasar.

## Deploy ke Vercel

1. Taruh folder ini di repositori GitHub/GitLab/Bitbucket, lalu **Add New → Project** di Vercel dan impor
   repositorinya (preset "Other", tanpa build command). Atau dari terminal: `npm i -g vercel && vercel`.
2. Di dashboard proyek buka **Storage** (atau **Marketplace**) → tambahkan **Upstash Redis** → hubungkan ke proyek ini.
   Integrasi otomatis mengisi `KV_REST_API_URL` + `KV_REST_API_TOKEN` (atau `UPSTASH_REDIS_REST_URL` +
   `UPSTASH_REDIS_REST_TOKEN`). Kode mendukung kedua pasang nama itu.
   **Pilih region Singapore (ap-southeast-1)** untuk database-nya.
3. **Deploy ulang** (Deployments → ⋯ → Redeploy). Variabel lingkungan baru hanya berlaku untuk deployment baru.
4. Buka URL proyek. *Buat Room Teman* → kirim kode 4 huruf atau tombol **Bagikan link**; atau *Main Cepat* untuk lobby umum.

`vercel.json` menetapkan Function berjalan di **`sin1` (Singapura)** supaya dekat dengan pemain di Indonesia dan dengan
database Redis. Bila database-mu di region lain, ubah/hapus baris `regions`. Latensi function↔Redis langsung
terasa di kehalusan gerakan pemain lain.

Bila Redis belum terhubung, API membalas pesan jelas: *"Database belum dikonfigurasi…"*.

## Menjalankan lokal

```bash
node dev-server.js        # http://localhost:3000  (penyimpanan memori, hanya untuk pengembangan)
```

Untuk mencoba beberapa pemain, buka beberapa jendela samaran / profil browser berbeda (sesi disimpan di `sessionStorage`).

## Tes

```bash
npm test                  # sintaks klien + 14 tes API (10 pemain, ronde, FINISH serentak, terputus, dst.)
                          # dijalankan lewat memori DAN lewat jalur Redis REST (server tiruan format Upstash)
python3 test/e2e.py       # 2 browser Chromium memainkan klien sungguhan (butuh: pip install playwright && playwright install chromium)
```

## Perilaku

| Hal | Perilaku |
|---|---|
| Lobby | Maks 10 pemain, host menekan MULAI (minimal 2). Host pergi → host berpindah ke pemain berikutnya. |
| Main Cepat | Masuk lobby umum yang sedang menunggu; bila tidak ada, dibuat baru. Lobby ditutup saat game dimulai. |
| Room Master | Peserta ke-11 di luar 10 pemain, **hanya menonton**: melihat semua pemain bermain, kamera mengikuti pemain terdepan (AUTO) atau pemain yang dipilih (◀ ▶, klik nama di peringkat, tombol ← → / F). Tidak punya karakter, tidak bisa menang/curang, boleh menekan MULAI. Maks 1 per room; boleh masuk kapan saja (juga saat game berjalan). Buat room lewat **🎥 Buat Room sebagai Room Master**, atau isi kode lalu **🎥 Gabung sebagai Room Master**. Master keluar/terputus → game pemain tetap lanjut. |
| Mulai | Hitung mundur disinkronkan jam server, jadi semua pemain mulai bersamaan walau polling berbeda ±0,7 dtk. |
| Soal | Naik tiap ronde: 2 angka → 3 angka (mulai ronde 4) → 4 angka (mulai ronde 7). Angka 1–10, jawaban bulat 1–10. |
| Ubin benar | Ubin tempat pemain berhasil berdiri tetap menjadi ubin benar di ronde berikutnya (`forced`), seperti di klien. |
| Terputus | Muat ulang halaman: sesi (`sessionStorage`) otomatis kembali ke room, juga di tengah game (di posisi terakhir). Tidak aktif >20 dtk → dikeluarkan. |
| Keluar | Lawan diberi tahu. Bila semua lawan keluar saat game berjalan, pemain terakhir menang otomatis. |
| Selesai | Semua melihat hasil. *Kembali ke Lobby* lalu host bisa MULAI lagi di room yang sama; pemain baru boleh bergabung. |

## Catatan biaya & batasan

- Terukur dengan 10 bot: **±3 perintah Redis per sync, 1 round-trip ke Redis per request**. Satu race 10 pemain
  ±2 menit ≈ **15–20 ribu perintah**; race 2 pemain ≈ 3 ribu. Paket gratis Upstash (500 ribu perintah/bulan, per Okt 2026)
  cukup untuk puluhan race 10 pemain per bulan; sesudahnya pay-as-you-go ≈ $0,20 per 100 ribu perintah.
- Tab yang disembunyikan melambat (browser menahan timer), jadi pemain itu tampak "diam" bagi lawan sampai kembali.
- Posisi pemain dipercaya dari klien (seperti versi WebSocket). Server hanya memeriksa bahwa laporan FINISH
  datang dari posisi yang masuk akal; tidak ada pembatasan kecepatan/anti-cheat penuh. Cukup untuk bermain dengan teman.
  Untuk trafik publik besar, tambahkan pembatasan laju (mis. Vercel Firewall).
- Tidak ada akun/login. Siapa pun yang tahu kode 4 huruf dan room belum dimulai/penuh bisa bergabung.
- Room kedaluwarsa 6 jam setelah aktivitas terakhir.
- Bila ingin gerakan lebih halus lagi (latensi ~50 ms), tahap berikutnya adalah layanan realtime (Ably, Pusher,
  PartyKit, Supabase Realtime) sebagai pengganti polling; logika wasit di `api/room.js` bisa dipertahankan.
