'use strict';
/* Mathematic Bridge Race Online: satu Vercel Function (POST /api/room) yang menangani semua aksi.
   Server = wasit: membuat soal, mengatur waktu ronde, menentukan pemenang. Posisi pemain dikirim klien tiap ~0,2 dtk.
   Serverless tidak punya proses latar, jadi tenggat ronde dijalankan "secara malas" di tiap request (tick). */
const crypto = require('crypto');
const core = require('../public/game-core.js');
const { getStore } = require('../lib/store.js');

const TTL = 6 * 3600;                 // room hilang 6 jam setelah aktivitas terakhir
const DEAD_MS = 20000;                // pemain dianggap terputus bila tidak sync selama ini
const PUB_KEY = 'pub:lobby';          // kode room publik yang sedang menunggu pemain (untuk MAIN CEPAT)
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const TOKEN_RE = /^[0-9a-f]{24}$/;

const fail = (status, msg) => { const e = new Error(msg); e.status = status; return e; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rid = n => crypto.randomBytes(n).toString('hex');
const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>&"]/g, '').trim().slice(0, 10);
const roomKey = c => 'room:' + c, posKey = c => 'pos:' + c, okKey = c => 'ok:' + c;
const normCode = c => { c = String(c || '').toUpperCase().replace(/[^A-Z]/g, ''); if (c.length !== 4) throw fail(400, 'Kode room harus 4 huruf.'); return c; };

/* Hash posisi `pos:<kode>`: field "T:<token>" = waktu sync terakhir (ms), "P:<token>" = JSON [x,y,z,vx,vz,face,grounded,skor,benar,salah,combo,t].
   Field memakai token (rahasia) supaya klien tidak bisa menulis posisi pemain lain. */
function parseHash(raw) {
  const o = {};
  if (Array.isArray(raw)) for (let i = 0; i + 1 < raw.length; i += 2) o[raw[i]] = raw[i + 1];
  else if (raw && typeof raw === 'object') Object.assign(o, raw);
  return o;
}
function posOf(hall, token) { try { const s = JSON.parse(hall['P:' + token]); return Array.isArray(s) ? s : null; } catch (e) { return null; } }
const lastSeen = (room, p, hall) => Math.max(Number(hall['T:' + p.token]) || 0, p.at || 0, room.lastStart || 0);
function cleanSt(a) {
  if (!Array.isArray(a) || a.length < 11) return null;
  const s = a.slice(0, 11).map(Number);
  return s.some(n => !isFinite(n)) ? null : s.map(n => Math.round(n * 100) / 100);
}

/* ---------- logika room ---------- */
function viewOf(room, now) {
  const v = {
    code: room.code, v: room.v, status: room.status, gn: room.gn, host: room.host, max: core.MAX_PLAYERS, min: core.MIN_PLAYERS,
    players: room.players.map(p => ({ id: p.id, name: p.name, ci: p.ci })), serverNow: now
  };
  if (room.status === 'playing') Object.assign(v, { gseed: room.gseed, goAt: room.goAt, rn: room.rn, ph: room.ph, phAt: room.phAt, q: room.q, seed: room.seed, forced: room.forced });
  if (room.win) v.win = room.win;
  return v;
}
function addPlayer(room, name, now) {
  const used = new Set(room.players.map(p => p.ci)); let ci = 0; while (used.has(ci)) ci++;
  const p = { id: room.nid++, token: rid(12), name, ci, at: now, fin: null };
  room.players.push(p); room.dirty = true;
  if (!room.host) room.host = p.id;
  return p;
}
function startGame(room, now) {
  room.gn++; room.status = 'playing'; room.win = null; room.lastStart = now;
  room.gseed = crypto.randomInt(1, 2147483647);
  room.goAt = now + core.COUNTDOWN_MS;                  // saat "GO!" selesai; ronde pertama dihitung dari sini
  room.rn = 0; room.ph = 'timer'; room.phAt = room.goAt;
  room.q = core.makeQuestion(0); room.seed = crypto.randomInt(1, 2147483647); room.forced = [];
  room.players.forEach(p => { p.fin = null; });
  room.dirty = true;
}
function buildWin(room, winner, now, hall, reason) {
  const prog = s => Math.round(Math.min(1, Math.max(0, s ? s[2] / core.FINISH_Z : 0)) * 100);
  const rows = room.players.map(p => {
    const s = posOf(hall, p.token);
    return { id: p.id, name: p.name, ci: p.ci, z: s ? s[2] : 0, prog: p.id === winner.id && !reason ? 100 : prog(s), rt: s ? s[8] | 0 : 0, wr: s ? s[9] | 0 : 0, sc: s ? s[7] | 0 : 0 };
  });
  rows.sort((a, b) => (b.id === winner.id) - (a.id === winner.id) || b.z - a.z);
  const out = { id: winner.id, name: winner.name, rank: rows.map(r => ({ id: r.id, name: r.name, ci: r.ci, prog: r.prog, rt: r.rt, wr: r.wr, sc: r.sc })) };
  if (reason) out.reason = reason; else out.time = Math.max(0, Math.round((now - room.goAt) / 100) / 10);
  return out;
}
function removePlayers(room, ids, hall, now) {
  if (!ids.length) return;
  room.players = room.players.filter(p => !ids.includes(p.id)); room.dirty = true;
  if (!room.players.length) { room.gone = true; return; }
  if (!room.players.some(p => p.id === room.host)) room.host = room.players[0].id;
  if (room.status === 'playing' && room.players.length < core.MIN_PLAYERS) {       // semua lawan keluar → sisa pemain menang
    room.win = buildWin(room, room.players[0], now, hall, 'Semua lawan keluar'); room.status = 'done';
  }
}
function pruneDead(room, hall, now, exceptToken) {
  removePlayers(room, room.players.filter(p => p.token !== exceptToken && now - lastSeen(room, p, hall) > DEAD_MS).map(p => p.id), hall, now);
}
/* Pemenang = pemain pertama yang MELAPOR sampai FINISH (dalam lock, jadi hanya satu yang menang). Posisi harus masuk akal. */
function tryFinish(room, token, st, now, hall) {
  const p = room.players.find(x => x.token === token);
  if (!p || p.fin || room.status !== 'playing' || now < room.goAt) return;
  if (!st || !(st[2] >= core.FINISH_Z - 2)) return;
  p.fin = now; room.win = buildWin(room, p, now, hall); room.status = 'done'; room.dirty = true;
}
const needsTick = (room, now) => room.status === 'playing' && now >= room.phAt + (room.ph === 'timer' ? core.TIMER_MS : core.DROP_MS);
async function takeForced(store, code) {
  const [h] = await store.pipeline([['HGETALL', okKey(code)], ['DEL', okKey(code)]]), out = [];
  Object.keys(parseHash(h)).forEach(f => {
    const [k, i] = f.split(':').map(Number);
    if (Number.isInteger(k) && Number.isInteger(i) && k >= 0 && k < core.SECTIONS && i >= 0 && i < core.ROWS * core.COLS) out.push([k, i]);
  });
  return out;
}
/* Maju ronde berdasarkan WAKTU (bukan waktu request) supaya tidak melenceng: timer → drop → ronde baru. */
async function tick(room, now, store) {
  if (room.status !== 'playing') return;
  for (let g = 0; g < 60; g++) {
    const end = room.phAt + (room.ph === 'timer' ? core.TIMER_MS : core.DROP_MS);
    if (now < end) break;
    room.dirty = true;
    if (room.ph === 'timer') { room.ph = 'drop'; room.phAt = end; }
    else {
      room.rn++; room.ph = 'timer'; room.phAt = end;
      room.q = core.makeQuestion(room.rn); room.seed = crypto.randomInt(1, 2147483647);
      room.forced = await takeForced(store, room.code);   // ubin tempat pemain berdiri (jawaban benar) tetap jadi ubin benar
    }
  }
}

/* ---------- akses data ---------- */
async function withRoom(code, fn) {
  const store = getStore(), lk = 'lock:' + code, id = rid(6);
  let got = false;
  for (let i = 0; i < 60 && !got; i++) {
    got = (await store.cmd(['SET', lk, id, 'NX', 'PX', 4000])) === 'OK';
    if (!got) await sleep(30 + Math.random() * 40);
  }
  if (!got) throw fail(503, 'Server sedang sibuk. Coba lagi.');
  try {
    const raw = await store.cmd(['GET', roomKey(code)]);
    if (!raw) throw fail(404, 'Room tidak ditemukan atau sudah kedaluwarsa.');
    const room = JSON.parse(raw);
    const out = await fn(room, store);
    if (room.gone) await store.pipeline([['DEL', roomKey(code)], ['DEL', posKey(code)], ['DEL', okKey(code)]]);
    else if (room.dirty) { delete room.dirty; room.v++; await store.cmd(['SET', roomKey(code), JSON.stringify(room), 'EX', TTL]); }
    return { room, out };
  } finally { await store.cmd(['DEL', lk]).catch(() => { }); }
}
function playerOf(room, token) {
  const p = token && room.players.find(x => x.token === token);
  if (!p) throw fail(401, 'Sesi tidak valid. Gabung ulang ke room.');
  return p;
}

/* ---------- aksi ---------- */
async function createRoom(name, pub) {
  const store = getStore(), now = Date.now();
  for (let i = 0; i < 20; i++) {
    let code = ''; for (let k = 0; k < 4; k++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
    const room = { code, v: 1, pub: !!pub, createdAt: now, status: 'lobby', host: null, nid: 1, players: [], gn: 0, win: null };
    const p = addPlayer(room, name, now); delete room.dirty;
    if ((await store.cmd(['SET', roomKey(code), JSON.stringify(room), 'NX', 'EX', TTL])) === 'OK') {
      await store.pipeline([['HSET', posKey(code), 'T:' + p.token, String(now)], ['EXPIRE', posKey(code), TTL]]);
      if (pub) await store.cmd(['SET', PUB_KEY, code, 'EX', 900]);
      return { code, token: p.token, id: p.id, room: viewOf(room, now) };
    }
  }
  throw fail(503, 'Gagal membuat room. Coba lagi.');
}
async function joinRoom(code, name, token) {
  const now = Date.now();
  const { room, out } = await withRoom(code, async (room, store) => {
    if (token) { const p = room.players.find(x => x.token === token); if (p) return { token, id: p.id, resumed: true }; }
    const hall = parseHash(await store.cmd(['HGETALL', posKey(code)]));
    pruneDead(room, hall, now);                                                       // singkirkan pemain "hantu" supaya room tidak terkunci penuh
    if (room.gone) { room.gone = false; room.status = 'lobby'; room.host = null; room.win = null; }
    if (room.status === 'playing') throw fail(409, 'Game di room ini sudah dimulai.');
    if (room.players.length >= core.MAX_PLAYERS) throw fail(409, 'Room penuh (maks ' + core.MAX_PLAYERS + ' pemain).');
    if (!name) throw fail(400, 'Isi nama terlebih dahulu.');
    const p = addPlayer(room, name, now);
    await store.cmd(['HSET', posKey(code), 'T:' + p.token, String(now)]);
    return { token: p.token, id: p.id };
  });
  const res = { code, token: out.token, id: out.id, room: viewOf(room, now) };
  if (out.resumed && room.status === 'playing') {                                      // sambung ulang di tengah game: pulihkan posisi terakhir
    const raw = await getStore().cmd(['HGET', posKey(code), 'P:' + token]);
    try { const s = JSON.parse(raw); if (Array.isArray(s)) res.pos = s.slice(0, 11); } catch (e) { }
  }
  return res;
}
async function actCreate(b) {
  const name = cleanName(b.name); if (!name) throw fail(400, 'Isi nama terlebih dahulu.');
  return createRoom(name, false);
}
async function actQuick(b) {
  const name = cleanName(b.name); if (!name) throw fail(400, 'Isi nama terlebih dahulu.');
  const code = await getStore().cmd(['GET', PUB_KEY]);
  if (code) { try { return await joinRoom(code, name, null); } catch (e) { if (e.status !== 404 && e.status !== 409) throw e; } }
  return createRoom(name, true);
}
async function actJoin(b) {
  return joinRoom(normCode(b.code), cleanName(b.name), TOKEN_RE.test(b.token || '') ? b.token : null);
}
async function actStart(b) {
  const code = normCode(b.code), now = Date.now();
  const { room } = await withRoom(code, async (room, store) => {
    const p = playerOf(room, b.token);
    if (room.host !== p.id) throw fail(403, 'Hanya host yang bisa memulai game.');
    if (room.status === 'playing') return;                                             // sudah mulai (tombol ditekan dua kali)
    if (room.players.length < core.MIN_PLAYERS) throw fail(400, 'Minimal ' + core.MIN_PLAYERS + ' pemain untuk mulai.');
    startGame(room, now);
    await store.pipeline([['DEL', okKey(code)], ['HDEL', posKey(code)].concat(room.players.map(x => 'P:' + x.token)), ['EXPIRE', posKey(code), TTL]]);
    if (room.pub && (await store.cmd(['GET', PUB_KEY])) === code) await store.cmd(['DEL', PUB_KEY]);   // lobby publik ini sudah tertutup
  });
  return { room: viewOf(room, now) };
}
async function actLeave(b) {
  const code = normCode(b.code), now = Date.now();
  await withRoom(code, async (room, store) => {
    const p = playerOf(room, b.token);
    const hall = parseHash(await store.cmd(['HGETALL', posKey(code)]));
    removePlayers(room, [p.id], hall, now);
  });
  return {};
}
/* Sync: satu round-trip ke Redis (HSET posisi sendiri + GET room + HGETALL posisi semua). Menulis room hanya bila ada
   tenggat yang lewat, pemain terputus, atau ada laporan FINISH. */
async function actSync(b) {
  const code = normCode(b.code), token = String(b.token || ''), have = Number(b.v) || 0, now = Date.now(), store = getStore();
  if (!TOKEN_RE.test(token)) throw fail(401, 'Sesi tidak valid. Gabung ulang ke room.');
  const st = cleanSt(b.st), pk = posKey(code), cmds = [];
  cmds.push(st ? ['HSET', pk, 'T:' + token, String(now), 'P:' + token, JSON.stringify(st.concat(now))] : ['HSET', pk, 'T:' + token, String(now)]);
  const oks = (Array.isArray(b.ok) ? b.ok : []).slice(0, 6).filter(a => Array.isArray(a) && Number.isInteger(a[0]) && Number.isInteger(a[1]) && a[0] >= 0 && a[0] < core.SECTIONS && a[1] >= 0 && a[1] < core.ROWS * core.COLS);
  if (oks.length) { const a = ['HSET', okKey(code)]; oks.forEach(o => a.push(o[0] + ':' + o[1], '1')); cmds.push(a, ['EXPIRE', okKey(code), 600]); }
  cmds.push(['GET', roomKey(code)], ['HGETALL', pk]);
  const res = await store.pipeline(cmds), raw = res[res.length - 2], hall = parseHash(res[res.length - 1]);
  if (!raw) { await store.pipeline([['DEL', pk], ['DEL', okKey(code)]]); throw fail(404, 'Room tidak ditemukan atau sudah kedaluwarsa.'); }
  let room = JSON.parse(raw);
  playerOf(room, token);
  const dead = room.players.some(p => p.token !== token && now - lastSeen(room, p, hall) > DEAD_MS);
  const wantFin = !!b.fin && room.status === 'playing' && !room.win;
  if (needsTick(room, now) || dead || wantFin) {
    const r = await withRoom(code, async (rm, s) => {
      if (!rm.players.some(p => p.token === token)) return;
      if (wantFin) tryFinish(rm, token, st, now, hall);
      pruneDead(rm, hall, now, token);
      await tick(rm, now, s);
    });
    room = r.room; playerOf(room, token);
  }
  const out = { v: room.v, serverNow: now };
  if (room.v !== have) out.room = viewOf(room, now);
  if (room.status === 'playing') {
    const ps = {};
    room.players.forEach(p => { if (p.token === token) return; const s = posOf(hall, p.token); if (s) ps[p.id] = s.slice(0, 11); });
    out.ps = ps;
  }
  return out;
}

/* ---------- handler HTTP (Vercel) ---------- */
function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { throw fail(400, 'Body tidak valid.'); } }
  return {};
}
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    let out;
    if (req.method === 'POST') {
      const b = readBody(req);
      const acts = { sync: actSync, quick: actQuick, create: actCreate, join: actJoin, start: actStart, leave: actLeave };
      if (!acts[b.action]) throw fail(400, 'Aksi tidak dikenal.');
      out = await acts[b.action](b);
    } else if (req.method === 'GET') out = { service: 'mathematic-bridge-race' };
    else throw fail(405, 'Metode tidak didukung.');
    res.status(200).json(Object.assign({ ok: true }, out));
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    res.status(status).json({ ok: false, error: status >= 500 && !e.status ? 'Terjadi kesalahan di server.' : e.message });
  }
};
module.exports._internal = { viewOf, needsTick, tick, startGame };
