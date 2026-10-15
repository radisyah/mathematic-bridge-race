'use strict';
/* Memeriksa sintaks skrip inline di public/index.html (tanpa browser). */
const fs = require('fs'), vm = require('vm'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!scripts.length) { console.error('Skrip inline tidak ditemukan'); process.exit(1); }
scripts.forEach((s, i) => new vm.Script(s, { filename: 'index.html#script' + i }));
for (const f of ['manifest.webmanifest', 'icon.svg', 'game-core.js']) if (!fs.existsSync(path.join(__dirname, '../public', f))) { console.error('Berkas hilang: public/' + f); process.exit(1); }
if (/new WebSocket|ws:\/\//.test(html)) { console.error('Masih ada kode WebSocket (tidak jalan di Vercel)'); process.exit(1); }
console.log('✔ sintaks klien OK, aset PWA lengkap, tanpa WebSocket');
