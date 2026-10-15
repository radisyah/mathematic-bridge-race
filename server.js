'use strict';
/* Mathematic Bridge Race - server online.
   Server mengatur: room/lobby, soal, timer, fase drop, ronde baru, pemenang.
   Klien mengatur gerak pemain sendiri dan mengirim posisinya (disiarkan ke semua). */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAXP = 10, MINP = 2, ROUNDS = 50, GR = 3, C = 6;
const TIME = 5000, BACK = 2000, COUNT = 3600;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

/* ===== HTTP statis ===== */
const server = http.createServer((req, res) => {
  let u = decodeURIComponent((req.url || '/').split('?')[0]);
  if (u === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (u === '/') u = '/index.html';
  const f = path.normalize(path.join(PUBLIC, u));
  if (!f.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(d);
  });
});

/* ===== Generator soal (sama seperti versi offline) ===== */
const R = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const OPS = ['+', '−', '×', '÷'];
function evalQ(nums, ops) {
  let tot = 0, sign = 1, cur = nums[0];
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i], b = nums[i + 1];
    if (o === '×') cur *= b;
    else if (o === '÷') { if (cur % b) return null; cur /= b; }
    else { tot += sign * cur; sign = o === '+' ? 1 : -1; cur = b; }
  }
  return tot + sign * cur;
}
const FB = ['8 ÷ 2', '3 × 4 − 5', '4 × 3 − 8 ÷ 2'], FBA = [4, 7, 8];
function genQ(d, last) {
  const n = d < 3 ? 2 : d < 6 ? 3 : 4;
  for (let i = 0; i < 3000; i++) {
    const nums = Array.from({ length: n }, () => R(1, 10)), ops = Array.from({ length: n - 1 }, () => OPS[R(0, 3)]);
    if (n > 2) {
      const md = ops.some(o => o === '×' || o === '÷'), pm = ops.some(o => o === '+' || o === '−');
      if (!md || !pm) continue;
    }
    let triv = false, ts = 0;
    for (let k = 0; k < ops.length; k++) {
      if (ops[k] === '+' || ops[k] === '−') ts = k + 1;
      else if (ops[k] === '÷' && nums.slice(ts, k + 1).includes(nums[k + 1])) triv = true;
    }
    if (triv) continue;
    if (ops.some((o, k) => (o === '×' || o === '÷') && (nums[k] === 1 || nums[k + 1] === 1))) continue;
    const v = evalQ(nums, ops);
    if (v === null || !(v >= 1 && v <= 10)) continue;
    let t = '' + nums[0];
    for (let k = 0; k < ops.length; k++) t += ' ' + ops[k] + ' ' + nums[k + 1];
    if (t === last) continue;
    return { t, ans: v, d };
  }
  return { t: FB[n - 2], ans: FBA[n - 2], d };
}

/* ===== Room ===== */
const rooms = new Map();
const CODE_CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function newCode() {
  for (let i = 0; i < 200; i++) {
    let c = ''; for (let k = 0; k < 4; k++) c += CODE_CH[R(0, CODE_CH.length - 1)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
let nextId = 1;
const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
const bcast = (room, m) => { const s = JSON.stringify(m); room.players.forEach(p => { if (p.ws.readyState === 1) p.ws.send(s); }); };
const pub = (p) => ({ id: p.id, name: p.name, ci: p.ci });
function roomInfo(room) {
  return { t: 'room', code: room.code, host: room.host, state: room.state, public: room.public, max: MAXP, min: MINP, players: room.players.map(pub) };
}
function clearTimers(room) { clearTimeout(room.tm); room.tm = null; }
function freeColor(room) {
  const used = new Set(room.players.map(p => p.ci));
  for (let i = 0; i < MAXP; i++) if (!used.has(i)) return i;
  return 0;
}
function cleanName(n) {
  n = String(n || '').replace(/[<>&"]/g, '').trim().slice(0, 10);
  return n || 'Pemain';
}

function makeRound(room) {
  const d = Math.max(0, ...room.players.map(p => p.right));
  const q = genQ(d, room.lastQ);
  room.lastQ = q.t;
  room.q = q;
  const forced = [];
  room.players.forEach(p => { if (p.ck) forced.push(p.ck); });
  return { q, seed: (Math.random() * 4294967295) >>> 0, forced };
}
function startGame(room) {
  clearTimers(room);
  room.state = 'playing';
  room.gseed = (Math.random() * 4294967295) >>> 0;
  room.lastQ = '';
  room.players.forEach(p => { p.right = 0; p.wrong = 0; p.score = 0; p.ck = null; p.st = { x: 0, y: 0, z: -1.5, vx: 0, vz: 0, f: 1, g: 1 }; p.fin = false; });
  const rd = makeRound(room);
  bcast(room, { t: 'start', gseed: room.gseed, rounds: ROUNDS, round: rd, players: room.players.map(pub) });
  bcast(room, roomInfo(room));
  room.tm = setTimeout(() => timerPhase(room), COUNT);
}
function timerPhase(room) {
  if (room.state !== 'playing') return;
  room.tm = setTimeout(() => dropPhase(room), TIME);
}
function dropPhase(room) {
  if (room.state !== 'playing') return;
  bcast(room, { t: 'drop' });
  room.tm = setTimeout(() => {
    if (room.state !== 'playing') return;
    bcast(room, Object.assign({ t: 'round' }, makeRound(room)));
    timerPhase(room);
  }, BACK);
}
function ranking(room) {
  return room.players.slice().sort((a, b) => (b.fin - a.fin) || (b.st.z - a.st.z)).map(p => ({
    id: p.id, name: p.name, ci: p.ci, sc: p.score | 0, rt: p.right | 0, wr: p.wrong | 0,
    prog: Math.round(Math.max(0, Math.min(1, p.st.z / (ROUNDS * GR * 1.8))) * 100) }));
}
function endGame(room, winner, time, reason) {
  if (room.state !== 'playing') return;
  clearTimers(room);
  room.state = 'lobby';
  if (winner) winner.fin = true;
  bcast(room, { t: 'win', id: winner ? winner.id : 0, name: winner ? winner.name : '', time, reason: reason || '', rank: ranking(room) });
  bcast(room, roomInfo(room));
}
function removePlayer(ws) {
  const room = ws.room;
  if (!room) return;
  ws.room = null;
  room.players = room.players.filter(p => p.ws !== ws);
  if (!room.players.length) { clearTimers(room); rooms.delete(room.code); return; }
  if (room.host === ws.pid) room.host = room.players[0].id;
  bcast(room, { t: 'left', id: ws.pid });
  if (room.state === 'playing' && room.players.length < MINP) {
    endGame(room, room.players[0], (Date.now() - room.t0) / 1000, 'Semua lawan keluar');
  } else bcast(room, roomInfo(room));
}
function joinRoom(ws, room, name) {
  const p = { id: ws.pid, ws, name: cleanName(name), ci: freeColor(room), right: 0, wrong: 0, score: 0, ck: null, fin: false, st: { x: 0, y: 0, z: -1.5, vx: 0, vz: 0, f: 1, g: 1 } };
  room.players.push(p);
  ws.room = room;
  send(ws, { t: 'joined', id: p.id, ci: p.ci });
  bcast(room, roomInfo(room));
}

/* ===== WebSocket ===== */
const wss = new WebSocketServer({ server, maxPayload: 4096 });
wss.on('connection', (ws) => {
  ws.pid = nextId++; ws.room = null; ws.alive = true; ws.lastMsg = 0;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    const room = ws.room;
    if (m.t === 'join') {
      if (room) return;
      let r = null;
      if (m.mode === 'create') {
        const code = newCode();
        if (!code) return send(ws, { t: 'err', m: 'Server penuh, coba lagi nanti' });
        r = { code, players: [], host: ws.pid, state: 'lobby', public: !!m.pub, tm: null, q: null, lastQ: '', gseed: 0, t0: 0 };
        rooms.set(code, r);
      } else if (m.mode === 'code') {
        r = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!r) return send(ws, { t: 'err', m: 'Room tidak ditemukan' });
      } else {
        for (const x of rooms.values()) if (x.public && x.state === 'lobby' && x.players.length < MAXP) { r = x; break; }
        if (!r) {
          const code = newCode();
          if (!code) return send(ws, { t: 'err', m: 'Server penuh, coba lagi nanti' });
          r = { code, players: [], host: ws.pid, state: 'lobby', public: true, tm: null, q: null, lastQ: '', gseed: 0, t0: 0 };
          rooms.set(code, r);
        }
      }
      if (r.state !== 'lobby') return send(ws, { t: 'err', m: 'Game di room ini sedang berjalan' });
      if (r.players.length >= MAXP) return send(ws, { t: 'err', m: 'Room penuh (maks ' + MAXP + ' pemain)' });
      joinRoom(ws, r, m.name);
      return;
    }
    if (!room) return;
    const me = room.players.find(p => p.ws === ws);
    if (!me) return;
    switch (m.t) {
      case 'start':
        if (room.host !== me.id || room.state !== 'lobby') return;
        if (room.players.length < MINP) return send(ws, { t: 'err', m: 'Minimal ' + MINP + ' pemain untuk mulai' });
        room.t0 = Date.now() + COUNT;
        startGame(room);
        break;
      case 'st':
        if (room.state !== 'playing') return;
        { const s = me.st, n = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
          s.x = n(m.x, s.x); s.y = n(m.y, s.y); s.z = n(m.z, s.z); s.vx = n(m.vx, 0); s.vz = n(m.vz, 0);
          s.f = m.f ? 1 : 0; s.g = m.g ? 1 : 0;
          me.score = n(m.sc, me.score); me.right = n(m.rt, me.right); me.wrong = n(m.wr, me.wrong); me.cb = n(m.cb, 0); }
        break;
      case 'ok':
        if (room.state !== 'playing') return;
        { const k = m.k | 0, i = m.i | 0;
          if (k >= 0 && k < ROUNDS && i >= 0 && i < GR * C) me.ck = [k, i]; }
        break;
      case 'fin':
        if (room.state !== 'playing') return;
        endGame(room, me, Math.max(0, (Date.now() - room.t0) / 1000));
        break;
      case 'leave':
        removePlayer(ws);
        break;
      case 'name':
        me.name = cleanName(m.name); bcast(room, roomInfo(room));
        break;
    }
  });
  ws.on('close', () => removePlayer(ws));
  ws.on('error', () => {});
});

/* Siarkan posisi semua pemain ~15 kali/detik */
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.state !== 'playing') continue;
    const p = {};
    room.players.forEach(pl => {
      const s = pl.st;
      p[pl.id] = [+s.x.toFixed(2), +s.y.toFixed(2), +s.z.toFixed(2), +s.vx.toFixed(2), +s.vz.toFixed(2), s.f, s.g, pl.score | 0, pl.right | 0, pl.wrong | 0, pl.cb | 0];
    });
    bcast(room, { t: 'ps', p });
  }
}, 66);

/* Buang koneksi mati */
setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; try { ws.ping(); } catch (e) {} });
}, 15000);

server.listen(PORT, () => console.log('Mathematic Bridge Race online di http://localhost:' + PORT));
