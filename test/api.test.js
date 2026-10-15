'use strict';
/* Tes integrasi server: node test/api.test.js  (memori, atau Redis REST tiruan lewat test/redis-rest.test.js) */
const assert = require('assert');
const core = require('../public/game-core.js');
const { start } = require('../dev-server.js');
const { getStore } = require('../lib/store.js');

let base, pass = 0;
const post = async (action, o) => {
  const r = await fetch(base + '/api/room', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ action }, o)) });
  return Object.assign({ http: r.status }, await r.json());
};
const sync = (code, token, o) => post('sync', Object.assign({ code, token }, o));
const T = async (name, fn) => { try { await fn(); pass++; console.log('  ✔', name); } catch (e) { console.log('  ✘', name, '\n     ', e.stack.split('\n').slice(0, 3).join('\n      ')); process.exitCode = 1; } };
const store = () => getStore();
async function patchRoom(code, fn) { const r = JSON.parse(await store().cmd(['GET', 'room:' + code])); fn(r); await store().cmd(['SET', 'room:' + code, JSON.stringify(r), 'EX', 3600]); return r; }
const getRoom = async code => JSON.parse(await store().cmd(['GET', 'room:' + code]));
const st = (z, extra) => Object.assign([0, 0, z, 0, 0, 1, 1, 30, 3, 1, 2], extra || {});
async function lobby(n, name) {   // buat room berisi n pemain
  const host = await post('create', { name: name || 'Host' }); assert(host.ok, JSON.stringify(host));
  const ps = [host];
  for (let i = 1; i < n; i++) { const j = await post('join', { code: host.code, name: 'P' + i }); assert(j.ok, JSON.stringify(j)); ps.push(j); }
  return ps;
}
const rewind = (code, ms) => patchRoom(code, r => { r.goAt -= ms; r.phAt -= ms; });

(async () => {
  const srv = await start(0); base = 'http://localhost:' + srv.address().port;
  console.log('Tes API pada', base, '(penyimpanan: ' + store().kind + ')');

  await T('generator soal: jawaban 1–10, jumlah angka naik, ekspresi benar', () => {
    for (let r = 0; r <= 12; r++) for (let i = 0; i < 1500; i++) {
      const q = core.makeQuestion(r), n = q.t.split(' ').filter((_, k) => k % 2 === 0).length;
      assert(Number.isInteger(q.ans) && q.ans >= 1 && q.ans <= 10, q.t);
      assert.strictEqual(n, r < 3 ? 2 : r < 6 ? 3 : 4, 'jumlah angka ronde ' + r + ': ' + q.t);
      q.t.split(' ').filter((_, k) => k % 2 === 0).forEach(x => assert(x >= 1 && x <= 10));
      assert.strictEqual(Function('return ' + q.t.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-'))(), q.ans, q.t);
    }
  });

  await T('validasi dasar: nama kosong, kode salah, room tidak ada, token salah, aksi tak dikenal', async () => {
    assert.strictEqual((await post('create', { name: '  ' })).http, 400);
    assert.strictEqual((await post('quick', { name: '' })).http, 400);
    assert.strictEqual((await post('join', { code: 'AB', name: 'x' })).http, 400);
    assert.strictEqual((await post('join', { code: 'ZZZZ', name: 'x' })).http, 404);
    assert.strictEqual((await sync('ZZZZ', 'a'.repeat(24))).http, 404);
    assert.strictEqual((await sync('ZZZZ', 'salah')).http, 401);
    assert.strictEqual((await post('hack', {})).http, 400);
    const A = await post('create', { name: 'Ayu' });
    assert.strictEqual((await sync(A.code, 'b'.repeat(24))).http, 401);
    assert.strictEqual((await post('start', { code: A.code, token: 'x' })).http, 401);
  });

  await T('buat room 4 huruf, nama dibersihkan & dipotong 10 karakter', async () => {
    const A = await post('create', { name: '<b>Nama Yang Sangat Panjang</b>' });
    assert(A.ok && /^[A-Z]{4}$/.test(A.code) && A.room.status === 'lobby');
    assert.strictEqual(A.room.players[0].name, 'bNama Yang'); assert.strictEqual(A.room.host, A.id);
  });

  await T('10 pemain bergabung dengan warna unik, pemain ke-11 ditolak', async () => {
    const ps = await lobby(10); const v = (await sync(ps[0].code, ps[0].token, {})).room;
    assert.strictEqual(v.players.length, 10);
    assert.strictEqual(new Set(v.players.map(p => p.ci)).size, 10); assert(v.players.every(p => p.ci >= 0 && p.ci < 10));
    const full = await post('join', { code: ps[0].code, name: 'Lebih' }); assert(!full.ok && full.http === 409);
  });

  await T('mulai: hanya host, minimal 2 pemain, tidak bocor token di view', async () => {
    const solo = await post('create', { name: 'Solo' });
    assert.strictEqual((await post('start', { code: solo.code, token: solo.token })).http, 400);
    const [A, B] = await lobby(2);
    assert.strictEqual((await post('start', { code: A.code, token: B.token })).http, 403);
    const s = await post('start', { code: A.code, token: A.token });
    assert(s.ok && s.room.status === 'playing' && s.room.gn === 1 && s.room.ph === 'timer' && s.room.rn === 0);
    assert(s.room.goAt > Date.now() && s.room.goAt - Date.now() <= core.COUNTDOWN_MS);
    assert(s.room.q.ans >= 1 && s.room.q.ans <= 10 && s.room.q.d === 0);
    assert(!JSON.stringify(s.room).includes(A.token) && !JSON.stringify(s.room).includes(B.token));
    assert((await post('start', { code: A.code, token: A.token })).ok);                       // dobel klik aman
    assert.strictEqual((await post('join', { code: A.code, name: 'Telat' })).http, 409);      // tak bisa gabung saat jalan
  });

  await T('sinkron posisi: lawan terlihat, diri sendiri tidak; tanpa perubahan → tanpa view room', async () => {
    const [A, B, C] = await lobby(3); const s = await post('start', { code: A.code, token: A.token });
    const a1 = await sync(A.code, A.token, { v: s.room.v, st: st(12.5) });
    assert(a1.ok && !a1.room && a1.v === s.room.v);
    const b1 = await sync(B.code, B.token, { v: s.room.v, st: st(7) });
    assert.deepStrictEqual(Object.keys(b1.ps).sort(), [String(A.id)]);
    assert.strictEqual(b1.ps[A.id][2], 12.5); assert.strictEqual(b1.ps[A.id].length, 11); assert(!(B.id in b1.ps));
    const c1 = await sync(C.code, C.token, { v: s.room.v, st: st(1) });
    assert.deepStrictEqual(Object.keys(c1.ps).sort(), [String(A.id), String(B.id)].sort());
    assert((await sync(A.code, A.token, { v: 0 })).room, 'v berbeda → kirim room');
  });

  await T('ronde: timer → drop → ronde baru; ubin "ok" jadi forced; ok tak valid diabaikan', async () => {
    const [A, B] = await lobby(2); let s = (await post('start', { code: A.code, token: A.token })).room;
    await rewind(A.code, core.COUNTDOWN_MS + core.TIMER_MS + 50);
    let r = await sync(A.code, A.token, { v: s.room && s.room.v || s.v }); assert(r.room && r.room.ph === 'drop' && r.room.rn === 0);
    await sync(A.code, A.token, { ok: [[3, 5], [999, 1], [2, -1], 'x'] });
    await sync(B.code, B.token, { ok: [[10, 17]] });
    await rewind(A.code, core.DROP_MS + 50);
    r = await sync(B.code, B.token, { v: r.room.v }); assert(r.room && r.room.ph === 'timer' && r.room.rn === 1);
    assert.deepStrictEqual(r.room.forced.map(x => x.join(',')).sort(), ['10,17', '3,5']);
    assert(r.room.q.ans >= 1 && r.room.q.d === 1);
    await rewind(A.code, core.TIMER_MS + core.DROP_MS + 50);   // forced hanya berlaku satu ronde
    r = await sync(B.code, B.token, { v: r.room.v }); assert.strictEqual(r.room.rn, 2); assert.deepStrictEqual(r.room.forced, []);
  });

  await T('10 pemain sinkron serentak saat tenggat: ronde maju TEPAT sekali', async () => {
    const ps = await lobby(10); await post('start', { code: ps[0].code, token: ps[0].token });
    await patchRoom(ps[0].code, r => { r.ph = 'drop'; r.phAt = Date.now() - core.DROP_MS - 30; });
    const rs = await Promise.all(ps.map((p, i) => sync(p.code, p.token, { v: 0, st: st(i) })));
    assert(rs.every(r => r.ok && r.room.rn === 1 && r.room.ph === 'timer'), JSON.stringify(rs.map(r => r.http)));
    assert.strictEqual((await getRoom(ps[0].code)).rn, 1);
    assert.strictEqual(new Set(rs.map(r => r.room.q.t + r.room.seed)).size, 1, 'semua pemain melihat soal yang sama');
  });

  await T('FINISH: laporan palsu ditolak, pemenang pertama dikunci, hasil & peringkat benar', async () => {
    const [A, B, C] = await lobby(3); await post('start', { code: A.code, token: A.token }); await rewind(A.code, core.COUNTDOWN_MS + 1000);
    await sync(A.code, A.token, { st: st(120) }); await sync(C.code, C.token, { st: st(40, { 7: 90, 8: 5, 9: 2 }) });
    await sync(B.code, B.token, { st: st(100), fin: 1 });                                      // belum sampai FINISH → ditolak
    assert.strictEqual((await getRoom(A.code)).status, 'playing');
    await Promise.all([sync(B.code, B.token, { st: st(271), fin: 1 }), sync(C.code, C.token, { st: st(271), fin: 1 })]);   // serentak
    const room = await getRoom(A.code); assert.strictEqual(room.status, 'done'); assert(room.win);
    const w = room.win.id; assert(w === B.id || w === C.id);
    assert.strictEqual(room.win.rank.length, 3); assert.strictEqual(room.win.rank[0].id, w); assert.strictEqual(room.win.rank[0].prog, 100);
    assert(room.win.rank[1].prog >= room.win.rank[2].prog, 'sisanya urut menurut progres');
    assert(room.win.time > 0 && room.win.time < 30 && !room.win.reason);
    const a = await sync(A.code, A.token, { v: 0 }); assert(a.room.status === 'done' && a.room.win.id === w && !a.ps);
    const loser = w === B.id ? C : B; await sync(loser.code, loser.token, { st: st(271), fin: 1 });
    assert.strictEqual((await getRoom(A.code)).win.id, w, 'pemenang tidak berubah');
  });

  await T('main lagi: host mulai dari status selesai, game baru, pemain baru bisa gabung saat selesai', async () => {
    const [A, B] = await lobby(2); await post('start', { code: A.code, token: A.token }); await rewind(A.code, core.COUNTDOWN_MS + 1000);
    await sync(A.code, A.token, { st: st(271), fin: 1 }); assert.strictEqual((await getRoom(A.code)).status, 'done');
    const C = await post('join', { code: A.code, name: 'Baru' }); assert(C.ok && C.room.status === 'done');
    const s = await post('start', { code: A.code, token: A.token });
    assert(s.ok && s.room.status === 'playing' && s.room.gn === 2 && !s.room.win && s.room.rn === 0 && s.room.players.length === 3);
  });

  await T('pemain terputus disingkirkan; host dialihkan; sisa satu pemain menang otomatis', async () => {
    const [A, B, C] = await lobby(3);
    const old = Date.now() - 60000;
    await patchRoom(A.code, r => r.players.forEach(p => { if (p.id !== B.id) p.at = old; }));
    await store().cmd(['HSET', 'pos:' + A.code, 'T:' + A.token, String(old), 'T:' + C.token, String(old)]);
    const b = await sync(B.code, B.token, { v: 0 });
    assert.deepStrictEqual(b.room.players.map(p => p.id), [B.id]); assert.strictEqual(b.room.host, B.id);
    assert.strictEqual((await sync(A.code, A.token)).http, 401);
    // dalam game: lawan keluar → menang otomatis
    const [X, Y] = await lobby(2); await post('start', { code: X.code, token: X.token }); await rewind(X.code, core.COUNTDOWN_MS + 1000);
    await sync(X.code, X.token, { st: st(33) });
    assert((await post('leave', { code: Y.code, token: Y.token })).ok);
    const x = await sync(X.code, X.token, { v: 0 });
    assert(x.room.status === 'done' && x.room.win.id === X.id && x.room.win.reason === 'Semua lawan keluar' && x.room.players.length === 1);
  });

  await T('keluar: host pindah, room terakhir dihapus', async () => {
    const [A, B] = await lobby(2);
    assert((await post('leave', { code: A.code, token: A.token })).ok);
    const b = await sync(B.code, B.token, { v: 0 }); assert.strictEqual(b.room.host, B.id); assert.strictEqual(b.room.players.length, 1);
    assert((await post('leave', { code: B.code, token: B.token })).ok);
    assert.strictEqual((await post('join', { code: A.code, name: 'x' })).http, 404);
    assert.strictEqual(await store().cmd(['GET', 'room:' + A.code]), null);
  });

  await T('MAIN CEPAT: pemain masuk lobby publik yang sama; setelah mulai dibuat lobby baru', async () => {
    await store().cmd(['DEL', 'pub:lobby']);
    const a = await post('quick', { name: 'Q1' }), b = await post('quick', { name: 'Q2' });
    assert(a.ok && b.ok && a.code === b.code && b.room.players.length === 2);
    assert((await post('start', { code: a.code, token: a.token })).ok);
    const c = await post('quick', { name: 'Q3' }); assert(c.ok && c.code !== a.code && c.room.players.length === 1);
    const d = await post('quick', { name: 'Q4' }); assert.strictEqual(d.code, c.code);
  });

  await T('sambung ulang dengan token: id sama, posisi pulih di tengah game, token salah tidak masuk', async () => {
    const [A, B] = await lobby(2); await post('start', { code: A.code, token: A.token }); await rewind(A.code, core.COUNTDOWN_MS + 1000);
    await sync(B.code, B.token, { st: st(55.5) });
    const r = await post('join', { code: A.code, token: B.token }); assert(r.ok && r.id === B.id && r.token === B.token && r.pos && r.pos[2] === 55.5);
    const bad = await post('join', { code: A.code, token: 'c'.repeat(24) }); assert(!bad.ok && bad.http === 409);
  });

  srv.close();
  console.log(process.exitCode ? '\nADA TES GAGAL' : '\n' + pass + ' tes lolos');
  process.exit(process.exitCode || 0);
})();
