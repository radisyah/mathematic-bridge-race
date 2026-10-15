/* Mathematic Bridge Race: inti permainan (dipakai SERVER untuk membuat soal & aturan, dan KLIEN untuk konstanta). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GameCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';
const ROWS = 3, COLS = 6, SECTIONS = 50, TD = 1.8;        // jembatan: 50 bagian x 3 baris x 6 kolom ubin
const TIMER_MS = 5000, DROP_MS = 2000;                    // 5 dtk untuk menjawab, 2 dtk ubin salah hilang
const COUNTDOWN_MS = 4500;                                // jeda dari tombol MULAI sampai "GO!" selesai
const MAX_PLAYERS = 10, MIN_PLAYERS = 2;
const FINISH_Z = SECTIONS * ROWS * TD;                    // z tempat ubin FINISH mulai
const SYMBOL = { '+': '+', '-': '−', '*': '×', '/': '÷' };

const rnd = (rng, a, b) => a + Math.floor(rng() * (b - a + 1));

/* Hitung ekspresi dengan urutan operasi (× ÷ dulu). Mengembalikan null bila ada pembagian tidak bulat
   atau hasil antara negatif (tidak ada bilangan negatif di soal). */
function evaluate(nums, ops) {
  const n = [nums[0]], o = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i] === '*' || ops[i] === '/') {
      const a = n.pop(), b = nums[i + 1];
      if (ops[i] === '/') { if (a % b) return null; n.push(a / b); } else n.push(a * b);
    } else { n.push(nums[i + 1]); o.push(ops[i]); }
  }
  let r = n[0];
  for (let j = 0; j < o.length; j++) { r = o[j] === '+' ? r + n[j + 1] : r - n[j + 1]; if (r < 0) return null; }
  return r;
}
/* Kesulitan d naik tiap ronde (maks 8): d 0–2 → 2 angka, d 3–5 → 3 angka, d 6+ → 4 angka.
   Semua angka 1–10 dan jawaban selalu bilangan bulat 1–10. */
function makeQuestion(round, rng) {
  rng = rng || Math.random;
  const d = Math.min(8, Math.max(0, round | 0)), count = d < 3 ? 2 : d < 6 ? 3 : 4;
  const pool = d === 0 ? ['+', '-'] : d === 1 ? ['+', '-', '*'] : ['+', '-', '*', '/'];
  for (let tries = 0; tries < 2000; tries++) {
    const nums = Array.from({ length: count }, () => rnd(rng, 1, 10));
    const ops = Array.from({ length: count - 1 }, () => pool[rnd(rng, 0, pool.length - 1)]);
    if (count > 2 && ops.every(x => x === ops[0])) continue;          // hindari soal monoton (mis. 3 + 4 + 2 + 1)
    const ans = evaluate(nums, ops);
    if (ans == null || ans < 1 || ans > 10) continue;
    let t = String(nums[0]); ops.forEach((op, i) => { t += ' ' + SYMBOL[op] + ' ' + nums[i + 1]; });
    return { t, ans, d };
  }
  const a = rnd(rng, 1, 5), b = rnd(rng, 1, 5);
  return { t: a + ' + ' + b, ans: a + b, d };
}
return { ROWS, COLS, SECTIONS, TD, TIMER_MS, DROP_MS, COUNTDOWN_MS, MAX_PLAYERS, MIN_PLAYERS, FINISH_Z, evaluate, makeQuestion };
});
