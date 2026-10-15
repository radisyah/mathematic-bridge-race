"""E2E: 2 browser Chromium memainkan klien sungguhan melawan dev-server.
Butuh: pip install playwright && playwright install chromium.   Jalankan: python3 test/e2e.py"""
import json, os, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

PORT = 3917
BASE = f"http://localhost:{PORT}"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "test", "shots"); os.makedirs(SHOTS, exist_ok=True)

def api(body):
    req = urllib.request.Request(BASE + "/api/room", json.dumps(body).encode(), {"Content-Type": "application/json"})
    try: return json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e: return json.load(e)

ok = 0
def check(name, cond, extra=""):
    global ok
    print(("  ✔ " if cond else "  ✘ ") + name + (" " + str(extra) if not cond else ""))
    if not cond: raise SystemExit(1)
    ok += 1

srv = subprocess.Popen(["node", "dev-server.js"], cwd=ROOT, env=dict(os.environ, PORT=str(PORT)), stdout=subprocess.DEVNULL)
try:
    for _ in range(50):
        try: urllib.request.urlopen(BASE + "/api/room"); break
        except Exception: time.sleep(0.1)
    with sync_playwright() as p:
        br = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
        errs = []
        def mk(name):
            ctx = br.new_context(viewport={"width": 900, "height": 600}); pg = ctx.new_page()
            pg.on("pageerror", lambda e: errs.append(name + ": " + str(e)))
            pg.on("console", lambda m: errs.append(name + " console: " + m.text) if m.type == "error" else None)
            pg.goto(BASE); return pg
        A, B = mk("A"), mk("B")
        vis = lambda pg, sel: pg.eval_on_selector(sel, "e=>!e.classList.contains('hide')")
        in_game = lambda pg, t=6000: pg.wait_for_function("!document.getElementById('hud').classList.contains('hide')", timeout=t)

        A.fill("#nm", "Ayu"); A.click('[data-a="create"]'); A.wait_for_selector("#lobby:not(.hide)")
        code = A.inner_text("#lc"); check("A membuat room, kode 4 huruf", len(code) == 4 and code.isalpha(), code)
        B.fill("#nm", "Budi"); B.fill("#cd", code); B.click('[data-a="joincode"]'); B.wait_for_selector("#lobby:not(.hide)")
        B.wait_for_function("document.querySelectorAll('#lp .slot:not(.e)').length===2")
        A.wait_for_function("document.querySelectorAll('#lp .slot:not(.e)').length===2")
        check("lobby kedua pemain menampilkan 2 slot terisi", True)
        check("hanya host yang melihat tombol MULAI", vis(A, "#lgo") and not vis(B, "#lgo"))
        A.screenshot(path=SHOTS + "/1-lobby.png")

        A.click("#lgo", force=True)
        for pg in (A, B): in_game(pg, 5000)
        check("kedua klien masuk game setelah host menekan MULAI", True)
        A.wait_for_function("document.getElementById('cnt').classList.contains('hide')", timeout=9000)
        B.wait_for_function("document.getElementById('cnt').classList.contains('hide')", timeout=9000)
        qa, qb = A.inner_text("#q"), B.inner_text("#q")
        check("soal sama di kedua layar & berbentuk 'x = ?'", qa == qb and qa.endswith("= ?"), (qa, qb))

        A.keyboard.down("w"); time.sleep(2.2); A.keyboard.up("w")
        B.wait_for_function("[...document.querySelectorAll('#rk .rr')].some(r=>r.textContent.includes('Ayu')&&parseInt(r.querySelector('em').textContent)>0)", timeout=5000)
        check("B melihat A bergerak maju (posisi tersinkron lewat polling)", True)
        B.screenshot(path=SHOTS + "/2-game-B.png")

        t0 = time.time(); q0 = A.inner_text("#q")
        A.wait_for_function("document.getElementById('q').textContent!==%s" % json.dumps(q0), timeout=12000)
        B.wait_for_function("document.getElementById('q').textContent!==%s" % json.dumps(q0), timeout=3000)
        check("ronde berganti dikendalikan server (soal baru di kedua layar)", A.inner_text("#q") == B.inner_text("#q"), round(time.time() - t0, 1))

        tokB = json.loads(B.evaluate("sessionStorage.getItem('mbr_sess')"))
        B.reload(); in_game(B)
        check("reload di tengah game: B tersambung ulang otomatis ke game", vis(B, "#hud") and not vis(B, "#menu"))

        r = api({"action": "sync", "code": tokB["code"], "token": tokB["token"], "st": [0, 0, 271, 0, 0, 1, 1, 50, 5, 0, 3], "fin": 1})
        check("laporan FINISH diterima server", r.get("ok"), r)
        for pg in (A, B): pg.wait_for_selector("#res:not(.hide)", timeout=6000)
        check("kedua layar menampilkan hasil: Budi menang", "Budi" in A.inner_text("#res h2") and "Budi" in B.inner_text("#res h2"), A.inner_text("#res h2"))
        A.screenshot(path=SHOTS + "/3-hasil.png")

        A.click('#res [data-a="tolobby"]'); A.wait_for_selector("#lobby:not(.hide)")
        A.wait_for_function("document.querySelectorAll('#lp .slot:not(.e)').length===2")
        A.click("#lgo", force=True); in_game(A, 5000)
        B.wait_for_function("!document.getElementById('res').classList.contains('hide')===false", timeout=6000)
        check("main lagi: host mulai ulang, B yang masih di layar hasil ikut masuk game", vis(B, "#hud"))

        B.click('[data-a="pause"]'); B.click('#mod [data-a="leave"]'); B.wait_for_selector("#menu:not(.hide)")
        A.wait_for_function("document.getElementById('res').classList.contains('hide')===false", timeout=12000)
        check("B keluar → A menang otomatis (semua lawan keluar)", "keluar" in A.inner_text("#res").lower() or "Ayu" in A.inner_text("#res h2"), A.inner_text("#res"))
        check("tidak ada galat JavaScript di konsol", not errs, errs)
        br.close()
    print(f"\n{ok} pemeriksaan e2e lolos")
finally:
    srv.terminate()
