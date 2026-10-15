# Mathematic Bridge Race Online

Game balapan hitung multiplayer online. Pemain menjawab soal operasi campuran dengan berdiri di ubin
yang angkanya benar, dan yang pertama sampai FINISH menang. Lobby menampung maksimal 10 pemain dan
game bisa dimulai oleh host kalau sudah ada minimal 2 pemain. Mendukung HP (joystick di layar,
fullscreen) dan komputer (WASD / tombol panah).

## Menjalankan di komputer

Butuh [Node.js](https://nodejs.org) versi 18 atau lebih baru.

```
npm install
npm start
```

Lalu buka http://localhost:3000

## Deploy ke internet (Render)

1. Unggah proyek ini ke GitHub.
2. Di [render.com](https://render.com) pilih **New > Web Service** dan hubungkan repository ini.
3. Isi:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/healthz` (opsional)
4. Klik deploy. Buka alamat `https://nama-kamu.onrender.com` yang diberikan Render.

Server membaca port dari variabel `PORT`, jadi tidak ada yang perlu diubah di kode.
Paket gratis Render bisa "tidur" kalau lama tidak dipakai, jadi pembukaan pertama bisa agak lambat.

## Cara main online

- **Main Cepat:** masuk ke lobby umum.
- **Buat Room Teman:** dapat kode 4 huruf dan link untuk dibagikan.
- **Gabung:** masukkan kode room dari teman.
- Host menekan **MULAI** kalau sudah ada minimal 2 pemain.

## Struktur

```
server.js            server Node (HTTP + WebSocket, lobby, soal, timer, pemenang)
package.json         dependensi (ws)
public/index.html    game (tampilan, kontrol, joystick, jaringan)
public/manifest.webmanifest, public/icon.svg   pengaturan layar penuh di HP
```

## Pengaturan

| Variabel | Fungsi | Bawaan |
| --- | --- | --- |
| `PORT` | port server | 3000 |
| `GRACE` | masa tunggu sambung ulang pemain yang terputus (ms) | 30000 |
