'use strict';
/* Penyimpanan room. Produksi (Vercel): Upstash Redis lewat REST (tanpa dependensi npm).
   Lokal: memori proses (hanya untuk pengembangan/tes; TIDAK andal di Vercel karena tiap request bisa di instance berbeda).
   Perintah yang dipakai: GET SET(NX/EX/PX) DEL EXISTS EXPIRE HSET HGET HGETALL HDEL. */

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

function restStore(cfg) {
  const call = async (path, body) => {
    const r = await fetch(cfg.url + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error('Redis ' + r.status);
    return r.json();
  };
  return {
    kind: 'redis',
    async cmd(args) { const j = await call('', args); if (j.error) throw new Error(j.error); return j.result; },
    async pipeline(cmds) {
      const arr = await call('/pipeline', cmds);
      return arr.map(x => { if (x.error) throw new Error(x.error); return x.result; });
    }
  };
}

function memoryStore() {
  const m = new Map();   // key -> { v: string | Map, exp: ms | 0 }
  const alive = k => { const e = m.get(k); if (!e) return null; if (e.exp && e.exp < Date.now()) { m.delete(k); return null; } return e; };
  const hash = (k, create) => { let e = alive(k); if (!e && create) { e = { v: new Map(), exp: 0 }; m.set(k, e); } return e && e.v instanceof Map ? e : null; };
  const run = args => {
    const op = String(args[0]).toUpperCase(), k = args[1];
    switch (op) {
      case 'GET': { const e = alive(k); return e && typeof e.v === 'string' ? e.v : null; }
      case 'EXISTS': return alive(k) ? 1 : 0;
      case 'DEL': { let n = 0; for (let i = 1; i < args.length; i++) { if (alive(args[i])) n++; m.delete(args[i]); } return n; }
      case 'EXPIRE': { const e = alive(k); if (!e) return 0; e.exp = Date.now() + Number(args[2]) * 1000; return 1; }
      case 'SET': {
        let nx = false, exp = 0;
        for (let i = 3; i < args.length; i++) {
          const o = String(args[i]).toUpperCase();
          if (o === 'NX') nx = true;
          else if (o === 'EX') exp = Date.now() + Number(args[++i]) * 1000;
          else if (o === 'PX') exp = Date.now() + Number(args[++i]);
        }
        if (nx && alive(k)) return null;
        m.set(k, { v: String(args[2]), exp }); return 'OK';
      }
      case 'HSET': { const h = hash(k, true); let n = 0; for (let i = 2; i + 1 < args.length; i += 2) { if (!h.v.has(String(args[i]))) n++; h.v.set(String(args[i]), String(args[i + 1])); } return n; }
      case 'HGET': { const h = hash(k); return h && h.v.has(String(args[2])) ? h.v.get(String(args[2])) : null; }
      case 'HGETALL': { const h = hash(k), out = []; if (h) h.v.forEach((v, f) => out.push(f, v)); return out; }   // format datar seperti Upstash REST
      case 'HDEL': { const h = hash(k); let n = 0; if (h) for (let i = 2; i < args.length; i++) if (h.v.delete(String(args[i]))) n++; return n; }
    }
    throw new Error('perintah tidak didukung: ' + op);
  };
  return { kind: 'memory', async cmd(a) { return run(a); }, async pipeline(c) { return c.map(run); } };
}

let cached = null;
function getStore() {
  if (cached) return cached;
  const cfg = redisConfig();
  if (cfg) cached = restStore(cfg);
  else if (process.env.VERCEL) { const e = new Error('Database belum dikonfigurasi. Hubungkan Upstash Redis ke proyek Vercel ini lalu deploy ulang.'); e.status = 500; throw e; }
  else cached = memoryStore();
  return cached;
}
function _resetForTests() { cached = null; }
module.exports = { getStore, _resetForTests };
