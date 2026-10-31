#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
watchdog_sltp.py — Watchdog eksekusi SL/TP independen (lapis pengaman ke-2).
Dibuat 12 Okt 2026 setelah kasus CKBUSDT: trigger SL Binance (MARK_PRICE) tidak
cukup sensitif — mark menyentuh level tapi order book sudah jatuh, fill slip
15 tick (loss real $1.54 vs risk $1.00).

TUGAS: setiap 1 detik cek harga TERAKHIR (LAST price, bukan mark). Saat harga
MENYENTUH level SL/TP yang TERPASANG, langsung kirim MARKET reduce-only close.

PRINSIP (perintah operator):
  - TIDAK menghitung ulang level: SL/TP dibaca dari algo order yang terpasang
    di Binance (fallback: kolom slPrice/tp1Price tabel Position di DB).
  - SL/TP utama di Binance TETAP — watchdog hanya lapisan kedua.
  - reduce-only SELALU: tidak pernah bisa membuka posisi baru.
  - dry_run=true: semua aksi dicatat TANPA kirim order (mode uji).
  - TIDAK ada LLM di jalur eksekusi — murni deterministik.

CP-2 (exit hardening, F-02 & F-03):
  - ACK/NEW/FILLED dari satu respons order TIDAK dianggap bukti posisi flat.
    Posisi hanya ditandai selesai (FLAT_CONFIRMED) setelah positionRisk
    exchange menunjukkan amt=0 untuk simbol tersebut.
  - State per simbol: MONITORING -> EXIT_PENDING -> FLAT_CONFIRMED / DEGRADED.
    Status exit dipersist ATOMIK (tulis+fsync+rename) SEBELUM network request,
    memakai identitas exit stabil (exitId deterministik dari posisi+generasi).
  - Timeout/putus koneksi = AMBIGUOUS: TIDAK ada blind retry. Tick berikutnya
    query order via origClientOrderId + rekonsiliasi positionRisk dulu.
    Order "not found" harus terkonfirmasi N kali berturut-turut sebelum
    recovery order baru dikirim (dengan clientOrderId generasi baru).
  - Batas retry terbatas (exit_max_attempts). Lewat batas -> DEGRADED:
    monitoring/rekonsiliasi jalan terus, proteksi native TETAP, tanpa
    mengirim order baru.
  - State file rusak/hilang/format lama -> recovery scan (allOrders per simbol
    terbuka): adopsi HANYA order WDG_ yang masih AKTIF dan konsisten dengan
    posisi sekarang (side close, tipe MARKET, sisa qty == positionAmt).
    Order terminal historis (FILLED/CANCELED/EXPIRED/REJECTED) tidak pernah
    diadopsi; kandidat ambigu -> MONITORING + diagnostik, tanpa order otomatis.
    Tidak pernah mengasumsikan flat.
  - Kandidat WDG_ AKTIF yang bisa konflik (side close + MARKET, tidak diadopsi)
    dicatat di state dan diarbitrase TERBATAS sebelum close baru: query ->
    cancel -> re-fetch posisi; hasil ambigu -> tunda tick ini (tanpa order);
    lewat batas checks -> DEGRADED terlihat (tanpa false-flat, proteksi native
    tetap, re-arm pasif saat kandidat tuntas). Kandidat side/tipe salah tidak
    menekan trigger.

Jalankan:  python3 watchdog_sltp.py
Stop:      Ctrl+C / systemctl stop artatrade-watchdog
"""
import hashlib
import hmac
import json
import os
import signal
import socket
import subprocess
import threading
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from runtime_config import default_config, load_config, load_environment

# P3: telemetri latensi eksekusi (fail-open; tidak mempengaruhi jalur eksekusi).
# Aktif HANYA bila config "latency_sink_file" diset — tanpa itu zero overhead.
try:
    import exit_latency as _lat
except Exception:  # pragma: no cover - modul hilang tidak boleh mematikan watchdog
    _lat = None

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "watchdog_config.json")

RUNNING = True


def _stop(signum, frame):
    global RUNNING
    RUNNING = False


LOG_MAX_BYTES = 5 * 1024 * 1024  # 5 MB per file
LOG_KEEP_FILES = 3               # simpan 3 file rotasi


def _rotate_log(path):
    """Rotasi log sederhana: path -> path.1 -> path.2 -> hapus yang lebih lama."""
    try:
        for i in range(LOG_KEEP_FILES - 1, 0, -1):
            src = "%s.%d" % (path, i) if i > 1 else path
            dst = "%s.%d" % (path, i + 1) if i > 1 else "%s.%d" % (path, i + 1)
            if i == 1:
                src = path
                dst = "%s.1" % path
            if os.path.exists(src):
                if os.path.exists(dst):
                    os.remove(dst)
                os.rename(src, dst)
    except Exception:
        pass


def log(msg):
    line = "%s %s" % (datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z", msg)
    print(line, flush=True)
    if not _runtime_configured:
        return
    try:
        log_path = CFG["log_file"]
        # P5.f: rotasi log saat cap tercapai (fail-open)
        if os.path.exists(log_path) and os.path.getsize(log_path) >= LOG_MAX_BYTES:
            _rotate_log(log_path)
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def load_env(path):
    return load_environment(path)


CFG = default_config()
ENV = {}
API_KEY = ""
API_SECRET = ""
_runtime_configured = False
BASE = CFG["binance_base"].rstrip("/")
DRY_RUN = bool(CFG.get("dry_run", True))
POLL_SEC = float(CFG.get("poll_interval_sec", 1.0))
# 25 Okt 2026 (FASE 3): cooldown global REST Binance (429/418) — epoch detik.
REST_COOLDOWN_UNTIL = 0.0
ALERT_PCT = float(CFG.get("alert_pct", 0.3))
STATE_PATH = CFG["state_file"]
RECV_WINDOW = int(CFG.get("recv_window_ms", 5000))
ALLOWED = {s.upper() for s in CFG.get("allowed_symbols", []) or []}

# Parameter exit lifecycle (CP-2). Default di kode; config produksi tidak diubah.
EXIT_MAX_ATTEMPTS = int(CFG.get("exit_max_attempts", 3))
NOTFOUND_CONFIRMS = int(CFG.get("notfound_confirmations", 2))
QUERY_FAIL_MAX = int(CFG.get("query_fail_max", 5))
CANDIDATE_MAX_CHECKS = int(CFG.get("candidate_max_checks", 5))

# 13 Okt 2026 — hardening fetch posisi (insiden GTCUSDT #3032, 08:00:01 satu
# "Connection reset by peer" membutakan watchdog persis di detik spike +9%):
#   - POS_FETCH_FAIL sekarang di-retry CEPAT (POS_RETRY_MAX x, jeda 0.25 dtk)
#     sebelum kembali ke jeda poll normal — satu reset tidak lagi memakan
#     satu interval poll penuh; retry berbatas supaya tidak flood REST.
#   - HEARTBEAT tiap HEARTBEAT_SEC membedakan "diam sehat" (tidak ada posisi,
#     tidak ada event) dari proses stuck: age tick terakhir selalu tercatat.
POS_RETRY_MAX = int(CFG.get("pos_fetch_retry_max", 3))
POS_RETRY_SLEEP_SEC = float(CFG.get("pos_fetch_retry_sleep_sec", 0.25))
HEARTBEAT_SEC = float(CFG.get("heartbeat_sec", 60))

# P3: sink latensi (None = telemetri nonaktif). Diaktifkan lewat config saat
# deployment (runbook), bukan di sini.
LAT_PATH = CFG.get("latency_sink_file") or None
LAT_EVENTS = {}  # (sym, coid) -> event timeline (in-memory; hilang saat restart)


class _LevelsCache:
    """P4: cache level SL/TP per simbol — bounded + invalidasi benar.
    - TTL pendek (levels_ttl_sec, default 2.0s = <= 2x poll): menghemat 2 signed
      GET per tick tanpa menutupi edit manual di HP (staleness maksimum = TTL).
    - Identitas posisi bagian dari kunci: posisi baru -> cache otomatis basi.
    - Level dari algo order yang SUKSES di-cache; DB fallback / hasil query
      kosong-gagal TIDAK pernah di-cache (tidak ada stale override)."""

    def __init__(self, ttl):
        self.ttl = max(0.0, float(ttl))
        self.by_sym = {}

    def get(self, sym, identity):
        if self.ttl <= 0:
            return None
        ent = self.by_sym.get(sym)
        if not ent:
            return None
        if ent["identity"] != identity or (time.monotonic() - ent["at"]) > self.ttl:
            self.by_sym.pop(sym, None)
            return None
        return ent["levels"]

    def put(self, sym, identity, levels):
        if self.ttl <= 0 or not levels:
            return
        self.by_sym[sym] = {
            "identity": identity, "levels": dict(levels),
            "at": time.monotonic(),
        }

    def invalidate(self, sym):
        self.by_sym.pop(sym, None)


LEVELS_TTL = float(CFG.get("levels_ttl_sec", 2.0))
LEVELS_CACHE = _LevelsCache(LEVELS_TTL)


def configure_runtime(config_path=None):
    """Explicit CLI initialization; never called as an import side effect."""
    global CFG, ENV, API_KEY, API_SECRET, BASE, DRY_RUN, POLL_SEC, ALERT_PCT
    global STATE_PATH, RECV_WINDOW, ALLOWED, EXIT_MAX_ATTEMPTS, NOTFOUND_CONFIRMS
    global QUERY_FAIL_MAX, CANDIDATE_MAX_CHECKS, POS_RETRY_MAX, POS_RETRY_SLEEP_SEC
    global HEARTBEAT_SEC, LAT_PATH, LEVELS_TTL, LEVELS_CACHE, _runtime_configured
    CFG = load_config(config_path)
    ENV = load_env(CFG["env_file"])
    API_KEY, API_SECRET = ENV.get("BINANCE_API_KEY", ""), ENV.get("BINANCE_API_SECRET", "")
    if not API_KEY or not API_SECRET:
        raise ValueError("Watchdog credentials are unavailable")
    BASE = CFG["binance_base"].rstrip("/")
    DRY_RUN = CFG.get("dry_run", True) is not False
    POLL_SEC, ALERT_PCT = float(CFG.get("poll_interval_sec", 1)), float(CFG.get("alert_pct", .3))
    STATE_PATH, RECV_WINDOW = CFG["state_file"], int(CFG.get("recv_window_ms", 5000))
    ALLOWED = {s.upper() for s in CFG.get("allowed_symbols", []) or []}
    EXIT_MAX_ATTEMPTS = int(CFG.get("exit_max_attempts", 3))
    NOTFOUND_CONFIRMS = int(CFG.get("notfound_confirmations", 2))
    QUERY_FAIL_MAX, CANDIDATE_MAX_CHECKS = int(CFG.get("query_fail_max", 5)), int(CFG.get("candidate_max_checks", 5))
    POS_RETRY_MAX = int(CFG.get("pos_fetch_retry_max", 3))
    POS_RETRY_SLEEP_SEC = float(CFG.get("pos_fetch_retry_sleep_sec", .25))
    HEARTBEAT_SEC = float(CFG.get("heartbeat_sec", 60))
    LAT_PATH = CFG.get("latency_sink_file") or None
    LEVELS_TTL = float(CFG.get("levels_ttl_sec", 2))
    LEVELS_CACHE = _LevelsCache(LEVELS_TTL)
    _runtime_configured = True

# P5: feed WebSocket (default NONAKTIF — config "ws_enabled": true utk aktif).
# Board harga LAST push-based; REST tetap fallback + seed setelah reconnect.
WS_FEED = None
WS_DEGRADED_LAST = False


def init_ws_feed():
    """Bangun + mulai feed WS bila config memintanya. Fail-closed: kegagalan
    init TIDAK mematikan watchdog — jatuh ke jalur REST penuh."""
    global WS_FEED
    if not CFG.get("ws_enabled"):
        return None
    try:
        import ws_market as _wsm
        board = _wsm.PriceBoard(max_age_sec=float(CFG.get("ws_max_price_age_sec", 3.0)))
        feed = _wsm.WsMarketFeed(
            board, symbols=(), seed_fn=get_last_price,
            health_file=CFG.get("ws_health_file") or None,
            max_age_sec=float(CFG.get("ws_max_price_age_sec", 3.0)))
        feed.start()
        WS_FEED = feed
        log("WS_MARKET_FEED_START symbols=%s" % sorted(feed.symbols()))
        return feed
    except Exception as e:
        log("WS_MARKET_FEED_INIT_FAIL %s — jalur REST dipakai" % e)
        WS_FEED = None
        return None


def _last_price_for(sym):
    """P5: sumber harga LAST — WS board bila fresh (return receipt monotonic
    utk telemetri), else REST (jalur lama). Stale/putus = DEGRADED tercatat
    sekali per transisi; TIDAK PERNAH trigger dari harga basi."""
    global WS_DEGRADED_LAST
    if WS_FEED is not None:
        det = WS_FEED.board.get_fresh_detail(sym)
        if det is not None:
            if WS_DEGRADED_LAST:
                WS_DEGRADED_LAST = False
                log("WS_RECOVERED sym=%s — harga push segar kembali" % sym)
            return det[0], det[1]
        if not WS_DEGRADED_LAST:
            WS_DEGRADED_LAST = True
            log("WS_DEGRADED sym=%s — board basi/putus, fallback REST (gap deteksi mungkin ada; proteksi native TETAP)" % sym)
    return get_last_price(sym), None


def _lat_begin(sym, coid, reason, level, receipt_at=None):
    """Mulai timeline exit. receipt_at = monotonic saat harga pemicu teramati
    (WS receipt / poll). None -> dianggap sama dgn keputusan (poll loop).
    Return event atau None (fail-open)."""
    if _lat is None or not LAT_PATH:
        return None
    try:
        ev = _lat.new_event(sym, reason, level, coid)
        _lat.mark(ev, "trigger")
        if receipt_at is not None:
            ev["monotonic"]["receipt"] = float(receipt_at)
        else:
            ev["monotonic"]["receipt"] = ev["monotonic"]["trigger"]
        LAT_EVENTS[(sym, coid)] = ev
        return ev
    except Exception:
        return None


def _lat_get(sym, coid):
    try:
        return LAT_EVENTS.get((sym, coid))
    except Exception:
        return None


def _lat_finish(sym, coid, rec, closer):
    """Tutup timeline saat flat terkonfirmasi; tulis ke sink (fail-open)."""
    try:
        ev = LAT_EVENTS.pop((sym, coid), None)
        if ev is None or _lat is None or not LAT_PATH:
            return
        _lat.mark(ev, "flat")
        _lat.finalize(ev, closer, (rec.get("exit") or {}).get("remainingQty"))
        _lat.JsonlSink(LAT_PATH).write(ev)
    except Exception:
        pass

# Fase state per simbol.
PH_MONITORING = "MONITORING"        # posisi dipantau, belum ada exit
PH_EXIT_PENDING = "EXIT_PENDING"    # close dikirim / hasil belum final
PH_FLAT_CONFIRMED = "FLAT_CONFIRMED"  # posisi flat terkonfirmasi dari exchange
PH_DEGRADED = "DEGRADED"            # recovery mentok; monitoring jalan terus

# ── Stale MONITORING cleanup (30 Okt 2026) ──────────────────────────────────
# Posisi yang ditutup SL/TP native (atau dari dashboard/server) TIDAK pernah
# masuk fase EXIT_PENDING / FLAT_CONFIRMED. Record MONITORING-nya karena itu
# kekal selamanya, membuat status watchdog STALE dan — lebih berbahaya —
# ORPHAN_SWEEP_SKIP terus aktif sehingga sweep algo SLA_/TPA_ yatim ikut mati.
# Bersihkan HANYA setelah snapshot positionRisk (yang berhasil dibaca) tidak
# memuat simbol itu selama N tick BERTURUT-TURUT. Jangan pernah menghapus
# berdasarkan DB saja atau saat fetch posisi gagal (tick sudah return lebih dulu).
FLAT_CLEANUP_CONFIRMS = max(1, int(CFG.get("flat_cleanup_confirms", 3)))


def next_flat_misses(rec, present):
    """Jumlah konfirmasi berturut-turut bahwa posisi TIDAK ada di exchange."""
    return 0 if present else int(rec.get("flatMisses", 0)) + 1


def should_clear_stale_monitoring(rec, present, confirms=None):
    """True bila record MONITORING tanpa kandidat boleh dihapus (posisi flat).

    Syarat keras:
      - fase MONITORING (bukan EXIT_PENDING/DEGRADED/FLAT_CONFIRMED — jalur
        itu punya rekonsiliasi sendiri),
      - tidak ada kandidat ambigu yang harus diarbitrase,
      - counter flatMisses (SUDAH diperbarui tick ini oleh next_flat_misses)
        mencapai ambang confirms.
    """
    if present:
        return False
    if rec.get("phase") != PH_MONITORING:
        return False
    if rec.get("candidate"):
        return False
    limit = FLAT_CLEANUP_CONFIRMS if confirms is None else int(confirms)
    return int(rec.get("flatMisses", 0)) >= max(1, limit)


# Status order Binance.
ORDER_ACTIVE = ("NEW", "PARTIALLY_FILLED")
ORDER_TERMINAL_FAIL = ("CANCELED", "EXPIRED", "REJECTED")
# Error code Binance yang ambigu (request mungkin diproses mungkin tidak).
AMBIGUOUS_BINANCE_CODES = (-1003, -1006, -1007, -1021)


def _ts():
    return str(int(time.time() * 1000))


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def signed_request(method, path, params=None):
    global REST_COOLDOWN_UNTIL
    # 25 Okt 2026 (FASE 3 rate-limit): budget bersama IP Binance. Saat kena
    # 429/418, semua request berikutnya FAIL-FAST tanpa menyentuh jaringan
    # sampai cooldown lewat (hormati Retry-After bila ada) — jangan retry
    # agresif yang justru memperpanjang blokir.
    if time.time() < REST_COOLDOWN_UNTIL:
        return {"_error": True, "_ambiguous": True, "body": "REST_COOLDOWN_ACTIVE"}
    if DRY_RUN and method.upper() != "GET":
        return {"_error": True, "_dry_run": True, "_ambiguous": False, "body": "DRY_RUN_MUTATION_BLOCKED"}
    if not _runtime_configured or not API_KEY or not API_SECRET:
        return {"_error": True, "_ambiguous": False, "body": "RUNTIME_NOT_CONFIGURED"}
    params = dict(params or {})
    params["timestamp"] = _ts()
    params["recvWindow"] = str(RECV_WINDOW)
    qs = urllib.parse.urlencode(params)
    sig = hmac.new(API_SECRET.encode(), qs.encode(), hashlib.sha256).hexdigest()
    url = "%s%s?%s&signature=%s" % (BASE, path, qs, sig)
    req = urllib.request.Request(url, method=method)
    req.add_header("X-MBX-APIKEY", API_KEY)
    if method == "POST":
        req.add_header("content-type", "application/x-www-form-urlencoded")
        req.data = qs.encode()
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:300]
        bcode = None
        try:
            bcode = json.loads(body).get("code")
        except Exception:
            pass
        log("HTTP_%s %s %s" % (e.code, path, body))
        # 25 Okt 2026 (FASE 3): 429/418 -> cooldown global dengan Retry-After.
        if e.code in (429, 418):
            try:
                ra = float((e.headers or {}).get("Retry-After", "") or 0)
            except Exception:
                ra = 0.0
            if ra <= 0:
                ra = 900.0 if e.code == 418 else 60.0
            REST_COOLDOWN_UNTIL = max(REST_COOLDOWN_UNTIL, time.time() + ra)
            log("REST_RATE_LIMITED code=%d cooldown=%.0fs" % (e.code, ra))
        # HTTPError = server menjawab definitif, KECUALI code rate-limit/timeout
        # internal Binance — di situ hasil request belum pasti.
        return {
            "_error": True, "code": e.code, "binance_code": bcode,
            "_ambiguous": bcode in AMBIGUOUS_BINANCE_CODES, "body": body,
        }
    except (socket.timeout, TimeoutError) as e:
        log("REQ_TIMEOUT %s %s" % (path, e))
        return {"_error": True, "_ambiguous": True, "body": str(e)[:200]}
    except urllib.error.URLError as e:
        log("REQ_URLFAIL %s %s" % (path, e))
        return {"_error": True, "_ambiguous": True, "body": str(e)[:200]}
    except Exception as e:
        log("REQ_FAIL %s %s" % (path, e))
        return {"_error": True, "_ambiguous": True, "body": str(e)[:200]}


def public_get(path, params=None):
    if not _runtime_configured:
        return None
    qs = urllib.parse.urlencode(params or {})
    url = "%s%s%s" % (BASE, path, ("?" + qs) if qs else "")
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        log("PUB_FAIL %s %s" % (path, e))
        return None


# ── state exit lifecycle (CP-2) ──────────────────────────────────────────────
def new_state(recovery_scan):
    return {"schema": 2, "symbols": {}, "_recovery_scan": bool(recovery_scan)}


def load_state():
    """Muat state. File hilang/rusak/format lama -> state baru DENGAN recovery
    scan: jangan pernah mengasumsikan flat atau langsung kirim order baru."""
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        log("STATE_MISSING recovery_scan=1")
        return new_state(recovery_scan=True)
    except Exception as e:
        log("STATE_CORRUPT %s recovery_scan=1" % e)
        return new_state(recovery_scan=True)
    if not isinstance(data, dict) or data.get("schema") != 2 or not isinstance(data.get("symbols"), dict):
        log("STATE_OLD_FORMAT recovery_scan=1")
        return new_state(recovery_scan=True)
    # buang entri yang strukturnya rusak (recovery scan tetap jaga-jaga)
    clean = {}
    for sym, rec in data["symbols"].items():
        if isinstance(rec, dict) and rec.get("phase") in (
                PH_MONITORING, PH_EXIT_PENDING, PH_FLAT_CONFIRMED, PH_DEGRADED):
            clean[str(sym).upper()] = rec
    data["symbols"] = clean
    data.setdefault("_recovery_scan", False)
    return data


def save_state(st):
    """Tulis atomik: file sementara + fsync + rename. State exit dipersist
    SEBELUM network request supaya restart tidak kehilangan identitas exit."""
    try:
        tmp = STATE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(st, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, STATE_PATH)
    except Exception as e:
        log("STATE_SAVE_FAIL %s" % e)
        raise RuntimeError("Watchdog state persistence failed; action stopped") from None


def position_identity(pos):
    """Identitas posisi One-way: symbol+side+entry. amt berubah (partial fill)
    TIDAK mengubah identitas — itu posisi yang sama."""
    return "%s|%s|%.10f" % (pos["symbol"], pos["side"], pos.get("entry") or 0.0)


def make_exit_id(sym, side, qty_str, entry, gen):
    """Identitas exit stabil per (posisi, generasi exit). Deterministik —
    dipakai sebagai newClientOrderId untuk KORELASI/rekonsiliasi (bukan
    jaminan idempotensi server; bukti final tetap positionRisk)."""
    raw = "%s|%s|%s|%.10f|g%d" % (sym, side, qty_str, entry or 0.0, gen)
    return "WDG_" + hashlib.sha1(raw.encode()).hexdigest()[:18]


# ── orphan SL/TP cleanup (13 Okt 2026) ──────────────────────────────────────
# Insiden 12-13 Okt: posisi ditutup SL native, sibling TP (algo TPA_) tetap
# NEW di exchange. Root cause: tidak ada jalur "posisi flat -> cancel proteksi
# sibling" (server ATAU watchdog). Blok ini lapisan watchdog-nya:
#   - HANYA saat positionRisk amt==0 (bukti flat exchange, bukan DB);
#   - HANYA algo SLA_/TPA_ (milik bot, dari bracketAlgoIds preEntryBracket.ts)
#     yang basis-nya = OrderExec.entry posisi ATAU posisi itu tidak dikenal;
#   - cancel TIDAK dianggap berhasil dari respons: selalu query ulang
#     (timeout transport BISA berarti terkirim); retry bounded;
#   - POSISI TERBUKA / aman berubah: TIDAK ada cancel (aturan F);
#   - idempotent: cancel ulang = -2011 -> terkonfirmasi via query.
ACTIVE_ALGO_STATUSES = ("NEW", "WORKING", "LIVE", "ACTIVE", "TRIGGERED")
TERMINAL_ALGO_STATUSES = ("CANCELED", "FINISHED", "EXPIRED", "REJECTED")
CANCEL_CONFIRM_RETRIES = 2
ORPHAN_SWEEP_INTERVAL_SEC = 60          # sweep akun-penuh maks 1x/menit
_ENTRY_INFLIGHT_WINDOW_MS = 600_000     # entry NEW <10 mnt = bracket mungkin in-flight
_orphan_sweep_last = 0.0


def _db_entry_coid_for_symbol(sym):
    """clientOrderId entry (reduceOnly=0) TERBARU simbol — basis atribusi algo
    SLA_/TPA_ posisi terakhir. None = tidak diketahui."""
    db = CFG.get("db_path")
    if not db or not os.path.exists(db):
        return None
    try:
        import sqlite3
        con = sqlite3.connect(db, timeout=5)
        try:
            cur = con.execute(
                "SELECT clientOrderId FROM OrderExec WHERE symbol=? AND reduceOnly=0 "
                "ORDER BY id DESC LIMIT 1", (sym,))
            row = cur.fetchone()
        finally:
            con.close()
        return row[0] if row and row[0] else None
    except Exception as e:
        log("DB_ENTRY_LOOKUP_FAIL %s %s" % (sym, e))
        return None


def sweep_orphan_protective(st=None):
    """Lapis recovery: algo SLA_/TPA_ NEW di exchange sementara TIDAK ADA posisi
    terbuka sama sekali (bukti positionRisk — pemanggil menjamin) = orphan.
    Guard (semua wajib lolos sebelum satu pun cancel):
      G2 tidak ada OrderExec NEW reduceOnly=0 yang MUDA (<10 mnt) — entry bracket
         server sedang in-flight (DB ditulis SEBELUM POST, orderExecutor.ts);
      G3 tidak ada state exit/watchdog aktif.
    Setiap cancel diverifikasi status akhirnya via query (_cancel_with_confirmation).
    Algo non-SLA_/TPA_ (manual) tidak pernah disentuh (filter di _open_algo_ids)."""
    if DRY_RUN:
        return {"skipped": "DRY_RUN", "cancelled": [], "unconfirmed": []}
    # G2: entry NEW in-flight (hanya yang muda yang memblokir).
    # Fail-closed: DB tidak terbaca (hilang/rusak/error) = TIDAK ADA sweep —
    # kita tidak bisa membuktikan tidak ada entry in-flight.
    db = CFG.get("db_path")
    if not db or not os.path.exists(db):
        log("ORPHAN_SWEEP_SKIP db_unavailable path=%s" % db)
        return {"skipped": "DB_FAIL", "cancelled": [], "unconfirmed": []}
    try:
        import sqlite3
        con = sqlite3.connect(db, timeout=5)
        try:
            cur = con.execute(
                "SELECT clientOrderId FROM OrderExec WHERE status='NEW' AND reduceOnly=0 "
                "AND createdAt > ?", ((int(time.time() * 1000) - _ENTRY_INFLIGHT_WINDOW_MS),))
            inflight = [r[0] for r in cur.fetchall()]
        finally:
            con.close()
        if inflight:
            log("ORPHAN_SWEEP_SKIP entry_inflight=%s" % inflight[:3])
            return {"skipped": "ENTRY_INFLIGHT", "cancelled": [], "unconfirmed": []}
    except Exception as e:
        log("ORPHAN_SWEEP_SKIP db_fail=%s" % e)
        return {"skipped": "DB_FAIL", "cancelled": [], "unconfirmed": []}
    # G3: state watchdog aktif (exit pending / degraded / kandidat)
    active = st if st is not None else load_state()
    if active.get("symbols"):
        log("ORPHAN_SWEEP_SKIP state_symbols_aktif=%s" % sorted(active["symbols"].keys()))
        return {"skipped": "STATE_ACTIVE", "cancelled": [], "unconfirmed": []}
    out = {"cancelled": [], "unconfirmed": []}
    for sym, cid in _open_algo_ids():
        r = _cancel_with_confirmation(sym, cid)
        if r["confirmed"]:
            out["cancelled"].append((sym, cid))
            log("ORPHAN_SWEEP_CANCELLED sym=%s cid=%s status=%s" % (sym, cid, r["final_status"]))
        else:
            out["unconfirmed"].append((sym, cid))
            log("ORPHAN_SWEEP_UNCONFIRMED sym=%s cid=%s status=%s" % (sym, cid, r["final_status"]))
    return out


def _open_algo_ids(sym=None):
    """Daftar (symbol, clientAlgoId) algo NEW milik akun; sym=None = seluruh akun
    (dipakai sweep orphan berkala). Hanya prefix SLA_/TPA_ (milik bot)."""
    params = {} if sym is None else {"symbol": sym}
    res = signed_request("GET", "/fapi/v1/openAlgoOrders", params)
    rows = res if isinstance(res, list) else (res.get("orders", []) if isinstance(res, dict) else [])
    out = []
    for o in rows:
        if not isinstance(o, dict):
            continue
        s = str(o.get("symbol", "")).upper()
        if sym and s != sym:
            continue
        cid = str(o.get("clientAlgoId") or o.get("clientOrderId") or "")
        if cid.startswith(("SLA_", "TPA_", "TPB_")):
            out.append((s, cid))
    return out


def _algo_status(sym, cid):
    """Status algo TERKINI dari exchange. Return (status_str, known)."""
    res = signed_request("GET", "/fapi/v1/algoOrder", {"clientAlgoId": cid})
    if res.get("_error"):
        bc = res.get("binance_code")
        if bc in (-2013, -2011):
            return "NOT_FOUND", True
        return None, False  # query gagal: state TIDAK diketahui
    st = str(res.get("algoStatus", "")).upper()
    return st, True


def _cancel_with_confirmation(sym, cid):
    """Cancel algo + verifikasi status akhir via query. Return dict hasil:
    final_status + confirmed (True = terminal terverifikasi dari exchange).
    -2011/-2013 dari DELETE = exchange menyatakan order tidak ada (definitif)."""
    if DRY_RUN:
        return {"final_status": "DRY_RUN", "confirmed": False}
    st, known = None, False
    for attempt in range(CANCEL_CONFIRM_RETRIES + 1):
        res = signed_request("DELETE", "/fapi/v1/algoOrder", {"clientAlgoId": cid})
        if res.get("_error"):
            bc = res.get("binance_code")
            if bc in (-2011, -2013):
                return {"final_status": "NOT_FOUND", "confirmed": True}
            # timeout/tak pasti: jangan simpulkan; keputusan lewat query di bawah
        st, known = _algo_status(sym, cid)
        if known and (st in TERMINAL_ALGO_STATUSES or st == "NOT_FOUND"):
            return {"final_status": st, "confirmed": True}
        if attempt < CANCEL_CONFIRM_RETRIES:
            time.sleep(0.75)
    return {"final_status": st if known else "QUERY_UNKNOWN", "confirmed": False}


def _position_amt(sym):
    """positionAmt simbol dari exchange (float) atau None = tidak diketahui."""
    res = signed_request("GET", "/fapi/v2/positionRisk", {"symbol": sym})
    rows = res if isinstance(res, list) else []
    if len(rows) != 1:
        return None
    try:
        return float(rows[0].get("positionAmt", 0))
    except Exception:
        return None


def cleanup_flat_position_protective(sym, entry=None, reason="FLAT"):
    """Bersihkan proteksi SLA_/TPA_ milik bot untuk posisi sym yang SUDAH FLAT.
    entry = OrderExec.clientOrderId entry posisi (str, opsional). Return dict
    ringkas utk log. TIDAK pernah cancel algo non-SLA_/TPA_ (order manual)."""
    out = {"symbol": sym, "reason": reason, "cancelled": [], "unconfirmed": [], "skipped": [], "entry": None}
    if DRY_RUN:
        out["dry_run"] = True
        return out
    open_ids = [(s, cid) for (s, cid) in _open_algo_ids(sym) if s == sym]
    base = "".join(c for c in str(entry or "") if c.isalnum() or c in "_-")[:30] if entry else None
    for _s, cid in open_ids:
        # Re-verify flat sebelum TIAP cancel (jendela race diminimalkan): posisi
        # terbuka lagi / tidak diketahui = ABORT sisa cancel (fail-closed).
        amt = _position_amt(sym)
        if amt is None:
            out["skipped"].append(cid)
            log("ORPHAN_CLEANUP_ABORT sym=%s cid=%s why=POSITION_UNKNOWN" % (sym, cid))
            continue
        if amt != 0:
            out["skipped"].append(cid)
            log("ORPHAN_CLEANUP_ABORT sym=%s cid=%s why=POSITION_REOPENED amt=%s" % (sym, cid, amt))
            continue
        if base and cid[4:] == base:
            pass  # milik pasti posisi ini
        elif base:
            out["skipped"].append(cid)   # basis lain = posisi OPEN lain: JANGAN sentuh
            continue
        else:
            pass  # entry tak diketahui (flat saat watchdog poll): listing NEW + prefix bot cukup
        r = _cancel_with_confirmation(sym, cid)
        if r["confirmed"]:
            out["cancelled"].append(cid)
            log("ORPHAN_ALGO_CANCELLED sym=%s cid=%s status=%s reason=%s" % (sym, cid, r["final_status"], reason))
        else:
            out["unconfirmed"].append(cid)
            log("ORPHAN_ALGO_UNCONFIRMED sym=%s cid=%s status=%s — dicek ulang tick berikutnya" % (sym, cid, r["final_status"]))
    if out["skipped"]:
        log("ORPHAN_ALGO_SKIPPED sym=%s cids=%s — basis entry tidak cocok (posisi lain/ambigu)" % (sym, out["skipped"]))
    return out


# ── sumber level SL/TP: query algo order LIVE di Binance (fallback: DB) ──────
def levels_from_algo_orders(positions):
    """Query trigger price ASLI dari algo order yang terpasang, per posisi.
    refId = OrderExec.clientOrderId (entry) -> algo id = SLA_/TPA_ + refId
    (bracketAlgoIds di preEntryBracket.ts). Ini ikut perubahan SL manual lo di HP."""
    out = {}
    db = CFG.get("db_path")
    if not db or not os.path.exists(db):
        return out
    for pos in positions:
        try:
            import sqlite3
            con = sqlite3.connect(db, timeout=5)
            try:
                # 23 Okt 2026 (F-A): hanya baris LIVE (source LIKE 'LIVE%').
                # Posisi PAPER tidak boleh jadi sumber level posisi exchange.
                cur = con.execute(
                    "SELECT clientOrderId FROM OrderExec WHERE positionId="
                    "(SELECT id FROM Position WHERE symbol=? AND status='OPEN' "
                    "AND source LIKE 'LIVE%' ORDER BY id DESC LIMIT 1)"
                    " ORDER BY id ASC LIMIT 1", (pos["symbol"],))
                row = cur.fetchone()
            finally:
                con.close()
            if not row or not row[0]:
                continue
            base = "".join(c for c in str(row[0]) if c.isalnum() or c in "_-")[:30]
            for kind, prefix in (("sl", "SLA_"), ("tp", "TPA_")):
                res = signed_request("GET", "/fapi/v1/algoOrder", {"clientAlgoId": prefix + base})
                if res.get("_error"):
                    continue
                rows = res if isinstance(res, list) else [res]
                for o in rows:
                    if not isinstance(o, dict):
                        continue
                    px = o.get("triggerPrice") or 0
                    try:
                        px = float(px)
                    except Exception:
                        continue
                    status = str(o.get("algoStatus", "")).upper()
                    if px > 0 and status in ("", "NEW", "WORKING", "LIVE", "TRIGGERED"):
                        out.setdefault(pos["symbol"], {})[kind] = px
        except Exception as e:
            log("ALGO_LEVEL_FAIL %s %s" % (pos["symbol"], e))
    return out


def levels_from_db():
    """Fallback: kolom slPrice/tp1Price baris Position yang statusnya OPEN.

    23 Okt 2026 (F-A): WAJIB hanya baris LIVE. Posisi PAPER (source='PAPER_AI')
    TIDAK boleh jadi sumber level untuk posisi exchange: kalau simbol PAPER
    kebetulan sama dengan simbol exchange yang dipantau watchdog, level PAPER
    akan dipakai untuk menutup posisi exchange (salah harga, salah arah
    management). Baris non-LIVE di-SKIP, bukan dipakai.
    """
    out = {}
    db = CFG.get("db_path")
    if not db or not os.path.exists(db):
        return out
    try:
        import sqlite3
        con = sqlite3.connect(db, timeout=5)
        try:
            # source LIKE 'LIVE%' -> hanya posisi live exchange.
            # Kolom source mungkin belum ada di DB lama -> fallback aman:
            # tanpa kolom source, JANGAN memakai level DB sama sekali
            # (algo order LIVE adalah sumber utama; DB hanya cadangan).
            try:
                cur = con.execute(
                    "SELECT symbol, slPrice, tp1Price, mode, source FROM Position "
                    "WHERE status='OPEN' AND source LIKE 'LIVE%'")
            except sqlite3.OperationalError:
                log("DB_LEVELS_SKIP_NO_SOURCE_COLUMN")
                return out
            for sym, sl, tp, mode, source in cur.fetchall():
                sym = str(sym).upper()
                e = out.setdefault(sym, {})
                e["tpPolicy"] = "LADDER" if str(mode).upper() == "SWING" else "SINGLE_TARGET"
                e["source"] = str(source)
                if sl:
                    e["sl"] = float(sl)
                if tp:
                    e["tp"] = float(tp)
        finally:
            con.close()
    except Exception as e:
        log("DB_LEVELS_FAIL %s" % e)
    return out


def get_open_positions():
    """Return (positions, ok). ok=False berarti query GAGAL — posisi TIDAK
    boleh dianggap kosong (jangan clear state, jangan simpulkan flat)."""
    res = signed_request("GET", "/fapi/v2/positionRisk", {})
    if not isinstance(res, list):
        return [], False
    out = []
    for p in res:
        try:
            amt = float(p.get("positionAmt", 0))
        except Exception:
            continue
        sym = str(p.get("symbol", "")).upper()
        if amt == 0:
            continue
        out.append({
            "symbol": sym,
            "amt": amt,
            "side": "LONG" if amt > 0 else "SHORT",
            "entry": float(p.get("entryPrice", 0) or 0),
            "mark": float(p.get("markPrice", 0) or 0),
        })
    return out, True


def get_last_price(symbol):
    r = public_get("/fapi/v1/ticker/price", {"symbol": symbol})
    try:
        return float(r["price"])
    except Exception:
        return None


def decide_touch(px, side, sl, tp):
    """Tentukan level yang TERSENTUH. LONG: SL bila px<=sl, TP bila px>=tp.
    SHORT: kebalikannya. SL diprioritaskan bila keduanya tersentuh (fail-safe)."""
    long = side == "LONG"
    if sl and ((long and px <= sl) or (not long and px >= sl)):
        return ("SL", sl)
    if tp and ((long and px >= tp) or (not long and px <= tp)):
        return ("TP", tp)
    return None


def fmt_qty(qty):
    return ("%.8f" % qty).rstrip("0").rstrip(".")


# ── exit lifecycle (CP-2: F-02 & F-03) ───────────────────────────────────────
def query_order(sym, client_order_id):
    """Query status order exit sebelumnya via origClientOrderId.
    Return {"found": True/False/None, "order": {...}} — None = hasil query
    tidak diketahui (jangan disamakan dengan 'order tidak ada')."""
    res = signed_request("GET", "/fapi/v1/order", {
        "symbol": sym, "origClientOrderId": client_order_id})
    if res.get("_error"):
        if res.get("binance_code") == -2013:  # "Order does not exist."
            return {"found": False, "order": None}
        return {"found": None, "order": None}
    if not isinstance(res, dict) or not res.get("clientOrderId") and not res.get("orderId"):
        return {"found": None, "order": None}
    return {"found": True, "order": res}


def cancel_order(sym, client_order_id):
    """Cancel order exit/kandidat via origClientOrderId.
    Return {"found"/"canceled": ...} gaya query_order:
      - {"canceled": True}  -> cancel diterima exchange (definitif).
      - {"canceled": False} -> definitif gagal (mis. -2011 Unknown order / -2013).
      - {"canceled": None}  -> ambigu: hasil belum diketahui.
    """
    if DRY_RUN:
        return {"canceled": None, "order": None, "res": {"_dry_run": True}}
    res = signed_request("DELETE", "/fapi/v1/order", {
        "symbol": sym, "origClientOrderId": client_order_id})
    if res.get("_error"):
        if res.get("_ambiguous"):
            return {"canceled": None, "order": None, "res": res}
        if res.get("binance_code") in (-2011, -2013):
            return {"canceled": False, "order": None, "res": res}
        return {"canceled": None, "order": None, "res": res}
    return {"canceled": True, "order": res, "res": res}


def submit_close_order(sym, side, qty_str, client_order_id):
    """MARKET reduce-only close One-way Mode — hanya bisa MENUTUP.
    closePosition=true TIDAK dipakai (known -4509)."""
    if DRY_RUN:
        return {"_error": True, "_dry_run": True, "_ambiguous": False, "body": "DRY_RUN_MUTATION_BLOCKED"}
    return signed_request("POST", "/fapi/v1/order", {
        "symbol": sym,
        "side": side,
        "type": "MARKET",
        "quantity": qty_str,
        "reduceOnly": "true",
        "newClientOrderId": client_order_id,
    })


def apply_submit_result(sym, rec, res, st):
    """Klasifikasikan hasil submit. Respons order TIDAK pernah langsung
    dianggap bukti flat — rekonsiliasi positionRisk di tick berikutnya."""
    ex = rec["exit"]
    ex["updatedAt"] = now_iso()
    if res.get("_error"):
        if res.get("_ambiguous"):
            # F-03: timeout/putus koneksi -> hasil BELUM DIKETAHUI.
            # State EXIT_PENDING dipertahankan; TIDAK ada resend buta.
            ex["lastOutcome"] = "TIMEOUT_AMBIGUOUS"
            log("EXIT_SUBMIT_AMBIGUOUS sym=%s coid=%s attempt=%d body=%s" % (
                sym, ex["clientOrderId"], ex["attempts"], str(res.get("body"))[:120]))
        else:
            # Server menjawab definitif (reject). Tetap TIDAK dianggap sukses;
            # rekonsiliasi berikutnya yang menentukan langkah.
            ex["lastOutcome"] = "SUBMIT_REJECTED"
            ex["rejectInfo"] = "binance_code=%s body=%s" % (
                res.get("binance_code"), str(res.get("body"))[:120])
            log("EXIT_SUBMIT_REJECTED sym=%s coid=%s attempt=%d %s" % (
                sym, ex["clientOrderId"], ex["attempts"], ex["rejectInfo"]))
        save_state(st)
        return
    status = str(res.get("status", "")).upper()
    ex["orderId"] = res.get("orderId")
    ex["orderStatus"] = status
    if status == "FILLED":
        ex["lastOutcome"] = "ACK_FILLED"  # tetap wajib rekonsiliasi flat
    elif status in ORDER_ACTIVE:
        ex["lastOutcome"] = "ACK_ACTIVE"
    elif status in ORDER_TERMINAL_FAIL:
        ex["lastOutcome"] = "ACK_" + status  # bukan sukses
    else:
        ex["lastOutcome"] = "ACK_UNKNOWN_" + (status or "EMPTY")
    log("EXIT_SUBMIT_ACK sym=%s coid=%s orderId=%s status=%s outcome=%s" % (
        sym, ex["clientOrderId"], ex.get("orderId"), status, ex["lastOutcome"]))
    save_state(st)


def _arbitrate_candidates(sym, pos, rec, touched, st):
    """CP-2 final hardening — arbitrase kandidat ambigu SEBELUM close baru.

    Contract (approval CP-2 FINAL HARDENING):
      1. Posisi flat menurut snapshot FRESH -> confirm_flat, TANPA close baru.
      2. Kandidat terminal / definitif absen -> hapus kandidat, rekonsiliasi
         posisi, close baru HANYA bila trigger masih valid (re-checked di
         pemanggil lewat re-touch state), dengan qty sisa FRESH.
      3. Kandidat masih aktif & bisa konflik -> cancel terbatas:
           - cancel sukses / terminal -> re-fetch sisa posisi, tunggu tick
             berikutnya utk close (state kembali murni MONITORING).
           - cancel ambigu (timeout, hasil tak dikenal) -> TIDAK ada order,
             TIDAK false-flat; tick berikutnya query ulang (bounded).
         Partial-fill kandidat sebelum cancel: sisa posisi di-re-fetch dari
         exchange, qty close berikutnya otomatis mengikuti sisa aktual.
      4. Bounded: CANDIDATE_MAX_CHECKS checks tanpa resolusi -> DEGRADED
         terlihat (log + state), monitoring/rekonsiliasi jalan terus,
         proteksi native TETAP, TANPA false-flat, TANPA order baru dari
         arbitrase; re-arm pasif begitu kandidat terbukti tuntas.
      5. Kandidat side/tipe salah TIDAK PERNAH dicatat (recovery_scan), jadi
         tidak menekan trigger — dijaga juga di sini bila state lama.
    Return True = trigger boleh lanjut ke begin_exit tick ini.
    """
    cand = rec.get("candidate")
    if not cand or not cand.get("clientOrderId"):
        return True  # tidak ada kandidat: jalur normal
    if DRY_RUN:
        # Mode uji: TIDAK ada request signed (query/cancel) dari arbitrase.
        log("DRY_RUN CANDIDATE_SKIP sym=%s coid=%s" % (
            sym, str(cand.get("clientOrderId"))))
        return True
    coid = str(cand["clientOrderId"])

    # (A) Posisi flat / sudah hilang dari snapshot FRESH -> tanpa close baru.
    if pos is None or pos["amt"] == 0:
        rec["phase"] = PH_FLAT_CONFIRMED
        rec["closer"] = "CANDIDATE_FLAT"
        rec["flatConfirmedAt"] = now_iso()
        rec.pop("candidate", None)
        rec["updatedAt"] = now_iso()
        log("CANDIDATE_FLAT sym=%s coid=%s — tanpa close baru" % (sym, coid))
        save_state(st)
        return False
    want_side = "SELL" if pos["side"] == "LONG" else "BUY"

    # (B) Query kandidat via clientOrderId-nya.
    q = query_order(sym, coid)
    if rec["phase"] != PH_DEGRADED:
        cand["checks"] = int(cand.get("checks", 0)) + 1
    cand["updatedAt"] = now_iso()

    if q["found"] is True:
        o = q["order"]
        status = str(o.get("status", "")).upper()
        cand["lastStatus"] = status
        if status in ORDER_ACTIVE:
            side = str(o.get("side", "")).upper()
            otype = str(o.get("type", "")).upper()
            if side != want_side or (otype and otype != "MARKET"):
                # Tidak bisa konflik dgn close posisi ini: jangan suppress.
                rec.pop("candidate", None)
                _candidate_rearm(sym, rec, "INCOMPATIBLE", st)
                log("CANDIDATE_INCOMPATIBLE sym=%s coid=%s side=%s type=%s — trigger jalan" % (
                    sym, coid, side or "?", otype or "?"))
                save_state(st)
                return True
            # Masih aktif & bisa konflik -> cancel terbatas.
            cres = cancel_order(sym, coid)
            outcome = cres.get("canceled")
            if outcome is None:
                # Cancel ambigu (mungkin sukses mungkin tidak): TIDAK ada
                # order kedua tick ini; query ulang kandidat tick berikutnya.
                log("CANDIDATE_CANCEL_AMBIGUOUS sym=%s coid=%s — tanpa order tick ini" % (
                    sym, coid))
            elif outcome is False:
                # Definitif gagal cancel (mis. -2011): jangan kirim order
                # bersaing; query tick berikutnya yang memutuskan (bounded).
                log("CANDIDATE_CANCEL_REJECTED sym=%s coid=%s body=%s" % (
                    sym, coid, str((cres.get("res") or {}).get("body"))[:120]))
            else:
                # Cancel diterima exchange (definitif). RESELECT: re-fetch sisa
                # posisi SEKARANG (kandidat bisa sudah partial fill sebelum
                # cancel); close baru tetap tick berikutnya (dgn qty fresh).
                positions, ok = get_open_positions()
                fresh = None
                if ok:
                    for p in positions:
                        if p["symbol"] == sym:
                            fresh = p
                            break
                if ok and (fresh is None or fresh["amt"] == 0):
                    # Flat: kandidat (atau native SL/TP) sudah menutup semua.
                    rec["phase"] = PH_FLAT_CONFIRMED
                    rec["closer"] = "CANDIDATE_CANCELLED_FILLED"
                    rec["flatConfirmedAt"] = now_iso()
                    rec.pop("candidate", None)
                    log("CANDIDATE_FLAT_AFTER_CANCEL sym=%s coid=%s" % (sym, coid))
                    save_state(st)
                    return False
                if ok:
                    log("CANDIDATE_CANCELLED sym=%s coid=%s sisa=%s — close baru tick berikutnya dgn qty fresh" % (
                        sym, coid, fmt_qty(abs(fresh["amt"]))))
                    rec.pop("candidate", None)
                else:
                    # Re-fetch gagal: belum bisa dipastikan apa pun; kandidat
                    # dipertahankan, tick berikutnya query ulang (bounded).
                    log("CANDIDATE_RESELECT_FAIL sym=%s coid=%s — kandidat dipertahankan" % (
                        sym, coid))
            save_state(st)
            return False  # tanpa close tick ini — tidak ada order bersaing
        if status in ORDER_TERMINAL_FAIL or status in ("EXPIRED", "DONE"):
            # Terminal tanpa menutup posisi -> bukan ancaman lagi.
            rec.pop("candidate", None)
            _candidate_rearm(sym, rec, "TERMINAL", st)
            log("CANDIDATE_TERMINAL sym=%s coid=%s status=%s — trigger jalan" % (
                sym, coid, status))
            save_state(st)
            return True
        # FILLED tapi posisi masih terbuka: kandidat menutup sebagian.
        rec.pop("candidate", None)
        _candidate_rearm(sym, rec, "FILLED_PARTIAL", st)
        log("CANDIDATE_FILLED sym=%s coid=%s executed=%s sisa=%s — close sisa via trigger" % (
            sym, coid, o.get("cumQty", o.get("executedQty")), fmt_qty(abs(pos["amt"]))))
        save_state(st)
        return True

    if q["found"] is False:
        # Definitif absen dari exchange -> bukan ancaman; trigger jalan.
        rec.pop("candidate", None)
        _candidate_rearm(sym, rec, "ABSENT", st)
        log("CANDIDATE_ABSENT sym=%s coid=%s — trigger jalan" % (sym, coid))
        save_state(st)
        return True

    # (C) found=None: hasil query tidak diketahui. Bukan bukti apa pun:
    #     TIDAK false-flat, TIDAK order; hitung checks, bounded.
    log("CANDIDATE_QUERY_UNKNOWN sym=%s coid=%s checks=%d/%d" % (
        sym, coid, cand["checks"], CANDIDATE_MAX_CHECKS))
    if cand["checks"] >= CANDIDATE_MAX_CHECKS:
        rec["phase"] = PH_DEGRADED
        rec["degradedWhy"] = "CANDIDATE_UNRESOLVED"
        rec["updatedAt"] = now_iso()
        log("CANDIDATE_DEGRADED sym=%s coid=%s — batas checks tercapai; monitoring & rekonsiliasi jalan terus, proteksi native TETAP, tanpa false-flat" % (
            sym, coid))
    save_state(st)
    return False


def cres_ok(res):
    """True bila respons cancel definitif sukses (tidak dipakai lagi oleh
    arbitrase; dipertahankan sebagai util kecil)."""
    return not res.get("_error")


def _candidate_rearm(sym, rec, why, st):
    """Setelah kandidat terbukti tuntas / tidak bisa konflik: bila rekaman
    ada di DEGRADED HANYA karena kandidat itu (tanpa record exit), kembali ke
    MONITORING — re-arm pasif; jalur trigger normal berlanjut. Proteksi native
    tidak pernah disentuh oleh re-arm ini."""
    if rec.get("phase") == PH_DEGRADED and not rec.get("exit"):
        rec["phase"] = PH_MONITORING
        rec["updatedAt"] = now_iso()
        log("CANDIDATE_REARM sym=%s why=%s — kembali MONITORING, trigger normal" % (
            sym, why))


def begin_exit(sym, pos, reason, level, st, receipt_at=None):
    """Mulai satu logical exit: bentuk identitas stabil, persist EXIT_PENDING
    SEBELUM kirim, lalu submit. Trigger berulang tidak membuat order kedua
    karena fase sudah EXIT_PENDING (dicek pemanggil)."""
    rec = st["symbols"].get(sym)
    if rec is None or rec.get("positionId") != position_identity(pos):
        rec = {"phase": PH_MONITORING, "positionId": position_identity(pos), "gen": 0}
        st["symbols"][sym] = rec
    if rec["phase"] in (PH_EXIT_PENDING, PH_DEGRADED):
        log("EXIT_DUPLICATE_IGNORED sym=%s phase=%s" % (sym, rec["phase"]))
        return
    # CP-2 final hardening: kandidat ambigu harus diarbitrase dulu. Return
    # False = close baru DITAHAN tick ini (tanpa order bersaing, tanpa
    # false-flat); trigger re-fire tick berikutnya setelah state jelas.
    if rec.get("candidate") and not _arbitrate_candidates(sym, pos, rec, (reason, level), st):
        return
    if DRY_RUN:
        qty_str = fmt_qty(abs(pos["amt"]))
        log("DRY_RUN CLOSE %s" % json.dumps({
            "symbol": sym, "side": "SELL" if pos["side"] == "LONG" else "BUY",
            "qty": qty_str, "reason": reason, "triggerLevel": level,
            "mark": pos.get("mark"), "entry": pos.get("entry")}))
        return
    rec["gen"] = int(rec.get("gen", 0)) + 1
    qty_str = fmt_qty(abs(pos["amt"]))
    side = "SELL" if pos["side"] == "LONG" else "BUY"
    coid = make_exit_id(sym, pos["side"], qty_str, pos.get("entry"), rec["gen"])
    rec["phase"] = PH_EXIT_PENDING
    rec["updatedAt"] = now_iso()
    rec["exit"] = {
        "exitId": coid, "clientOrderId": coid, "orderId": None,
        "reason": reason, "level": level, "side": side, "qty": qty_str,
        "attempts": 1, "sentAt": now_iso(), "updatedAt": now_iso(),
        "lastOutcome": None, "orderStatus": None,
        "executedQty": None, "remainingQty": qty_str,
        "notFoundCount": 0, "queryFailCount": 0,
    }
    log("EXIT_BEGIN sym=%s reason=%s level=%.8f side=%s qty=%s attempt=1 coid=%s posAmt=%s" % (
        sym, reason, level, side, qty_str, coid, pos["amt"]))
    _lat_begin(sym, coid, reason, level, receipt_at=receipt_at)  # P3: trigger t=0
    save_state(st)  # persist SEBELUM network request (F-03 req 2)
    _lat_mark_send = _lat_get(sym, coid)
    if _lat_mark_send:
        _lat.mark(_lat_mark_send, "send")
    res = submit_close_order(sym, side, qty_str, coid)
    if _lat_mark_send:
        _lat.mark(_lat_mark_send, "ack")
        if isinstance(res, dict) and not res.get("_error"):
            _lat.mark_exchange(_lat_mark_send, "orderUpdateTimeMs", res.get("updateTime"))
            if res.get("orderId") is not None:
                _lat_mark_send["exchangeOrderId"] = res.get("orderId")
    apply_submit_result(sym, rec, res, st)


def recovery_close(sym, rec, pos, why, st):
    """Retry TERKENDALI setelah rekonsiliasi membuktikan order sebelumnya
    tidak menyelesaikan posisi (terminal fail / filled-but-open / not-found
    terkonfirmasi). Kuantitas = sisa aktual dari exchange. Lewat batas
    attempts -> DEGRADED, tanpa order baru."""
    if DRY_RUN:
        log("DRY_RUN recovery close suppressed sym=%s" % sym)
        return
    ex = rec["exit"]
    if ex["attempts"] >= EXIT_MAX_ATTEMPTS:
        rec["phase"] = PH_DEGRADED
        rec["updatedAt"] = now_iso()
        log("EXIT_DEGRADED sym=%s attempts=%d why=%s remaining=%s — monitoring jalan terus, proteksi native TETAP, tidak ada order baru" % (
            sym, ex["attempts"], why, ex.get("remainingQty")))
        save_state(st)
        return
    rec["gen"] = int(rec.get("gen", 0)) + 1
    qty_str = fmt_qty(abs(pos["amt"]))
    side = "SELL" if pos["side"] == "LONG" else "BUY"
    coid = make_exit_id(sym, pos["side"], qty_str, pos.get("entry"), rec["gen"])
    ex.update({
        "exitId": coid, "clientOrderId": coid, "orderId": None,
        "side": side, "qty": qty_str, "remainingQty": qty_str,
        "attempts": ex["attempts"] + 1, "sentAt": now_iso(),
        "updatedAt": now_iso(), "lastOutcome": None, "orderStatus": None,
        "notFoundCount": 0, "queryFailCount": 0,
    })
    log("EXIT_RECOVERY sym=%s why=%s attempt=%d coid=%s qty=%s" % (
        sym, why, ex["attempts"], coid, qty_str))
    save_state(st)  # persist identitas baru SEBELUM kirim
    res = submit_close_order(sym, side, qty_str, coid)
    apply_submit_result(sym, rec, res, st)


def _lat_note(sym, coid, order_obj):
    """Catat bukti fill pertama (observasi lokal) + identitas exchange."""
    try:
        ev = _lat_get(sym, coid)
        if ev is None:
            return
        if order_obj:
            _lat.mark_exchange(ev, "orderUpdateTimeMs", order_obj.get("updateTime"))
            if order_obj.get("orderId") is not None:
                ev["exchangeOrderId"] = order_obj.get("orderId")
        cum = order_obj.get("cumQty", order_obj.get("executedQty")) if order_obj else None
        try:
            if float(cum or 0) > 0 and ev["monotonic"].get("first_fill") is None:
                _lat.mark(ev, "first_fill")
        except Exception:
            pass
    except Exception:
        pass


def _lat_finish_all(sym, current_coid, rec, closer):
    """Tutup timeline simbol ini saat flat. Event dgn coid lain (attempt lama /
    superseded) dibuang tanpa ditulis — sampel parsial tidak boleh jadi statistik."""
    try:
        for key in [k for k in LAT_EVENTS if k[0] == sym]:
            ev = LAT_EVENTS.pop(key)
            if key[1] == current_coid and ev is not None and _lat and LAT_PATH:
                _lat.mark(ev, "flat")
                _lat.finalize(ev, closer, (rec.get("exit") or {}).get("remainingQty"))
                _lat.JsonlSink(LAT_PATH).write(ev)
    except Exception:
        pass


def confirm_flat(sym, rec, closer, st):
    if rec["phase"] != PH_FLAT_CONFIRMED:
        log("EXIT_FLAT_CONFIRMED sym=%s closer=%s orderStatus=%s attempts=%s" % (
            sym, closer, (rec.get("exit") or {}).get("orderStatus"),
            (rec.get("exit") or {}).get("attempts")))
        # Fase 2 (13 Okt): posisi FLAT terkonfirmasi = proteksi sibling yang
        # tersisa (satu leg native menutup penuh) WAJIB dibersihkan. Terjadi
        # di sini untuk SEMUA closer (NATIVE_SLTP / WATCHDOG / manual). Read-only
        # listing dulu; cancel hanya algo SLA_/TPA_ (milik bot). Guard anti-race:
        # bukti flat AMAN diperbarui dulu (amt 1s lalu), cancel hanya menyentuh
        # algo — reduceOnly aman bahkan bila fill partial menyusul.
        try:
            entry = _db_entry_coid_for_symbol(sym)
            r = cleanup_flat_position_protective(sym, entry=entry, reason="EXIT_FLAT_%s" % closer)
            if r["unconfirmed"]:
                rec["orphanCleanup"] = {"pending": r["unconfirmed"], "ts": now_iso()}
        except Exception as e:
            log("ORPHAN_CLEANUP_FAIL sym=%s %s" % (sym, e))
    rec["phase"] = PH_FLAT_CONFIRMED
    rec["closer"] = closer
    rec["flatConfirmedAt"] = now_iso()
    rec["updatedAt"] = now_iso()
    save_state(st)
    _lat_finish_all(sym, (rec.get("exit") or {}).get("clientOrderId"), rec, closer)


def reconcile_exit(sym, rec, pos, st):
    """Satu langkah rekonsiliasi untuk simbol dengan exit aktif.
    pos = posisi aktual tick ini (None bila amt=0 / tidak ada di exchange).
    Urutan: (1) fakta posisi dari positionRisk, (2) query order sebelumnya,
    (3) keputusan terbatas — tidak pernah blind retry."""
    ex = rec.get("exit")
    if not ex or not ex.get("clientOrderId"):
        # Catatan exit tidak lengkap (mis. entri rusak): jangan tebak,
        # tahan di DEGRADED sampai recovery scan/manual.
        if rec["phase"] != PH_DEGRADED:
            rec["phase"] = PH_DEGRADED
            log("EXIT_RECONCILE_NOEXIT sym=%s -> DEGRADED" % sym)
            save_state(st)
        return

    # (1) Fakta posisi dari exchange.
    if pos is None or pos["amt"] == 0:
        # Flat menurut positionRisk. Konfirmasi atribusi best-effort.
        q = query_order(sym, ex["clientOrderId"])
        if q["found"] is True:
            o = q["order"]
            status = str(o.get("status", "")).upper()
            if status == "FILLED":
                closer = "WATCHDOG"
            else:
                closer = "WATCHDOG_PARTIAL_THEN_NATIVE"
            ex["orderStatus"] = status
            ex["executedQty"] = o.get("cumQty", o.get("executedQty"))
        elif q["found"] is False:
            closer = "NATIVE_SLTP"  # native SL/TP menang race
        else:
            closer = "FLAT_QUERY_UNKNOWN"  # flat per positionRisk; query gagal
        ex["remainingQty"] = "0"
        confirm_flat(sym, rec, closer, st)
        return

    # Posisi MASIH terbuka.
    remaining = abs(pos["amt"])
    remaining_str = fmt_qty(remaining)
    if ex.get("qty") != remaining_str:
        ex["qtyChanged"] = True
    ex["remainingQty"] = remaining_str

    if rec["phase"] == PH_DEGRADED:
        # Sudah mentok: TIDAK ada order baru dari watchdog. Rekonsiliasi pasif
        # jalan terus (deteksi flat di cabang atas; proteksi native TETAP).
        save_state(st)
        return

    # (2) Query order exit sebelumnya (korelasi via origClientOrderId).
    q = query_order(sym, ex["clientOrderId"])
    if q["found"] is None:
        # Hasil query tidak diketahui -> tetap ambigu, jangan bertindak.
        ex["queryFailCount"] = int(ex.get("queryFailCount", 0)) + 1
        ex["notFoundCount"] = 0
        log("EXIT_QUERY_FAIL sym=%s coid=%s failCount=%d" % (
            sym, ex["clientOrderId"], ex["queryFailCount"]))
        if ex["queryFailCount"] >= QUERY_FAIL_MAX and rec["phase"] != PH_DEGRADED:
            rec["phase"] = PH_DEGRADED
            rec["updatedAt"] = now_iso()
            log("EXIT_DEGRADED sym=%s why=QUERY_FAIL attempts=%d — monitoring jalan terus" % (
                sym, ex["attempts"]))
        save_state(st)
        return

    ex["queryFailCount"] = 0
    if q["found"] is True:
        o = q["order"]
        _lat_note(sym, ex["clientOrderId"], o)  # P3: bukti fill pertama
        status = str(o.get("status", "")).upper()
        ex["orderId"] = o.get("orderId", ex.get("orderId"))
        ex["orderStatus"] = status
        ex["executedQty"] = o.get("cumQty", o.get("executedQty"))
        ex["updatedAt"] = now_iso()
        if status == "FILLED":
            # Order close filled penuh tapi posisi masih terbuka: kuantitas
            # posisi berubah saat exit pending. Recovery utk sisa aktual.
            recovery_close(sym, rec, pos, "FILLED_BUT_OPEN", st)
            return
        if status in ORDER_ACTIVE:
            # Order masih kerja di book (partial fill mungkin terjadi).
            # Biarkan selesai — JANGAN kirim order kedua.
            if status == "PARTIALLY_FILLED":
                log("EXIT_PARTIAL_ACTIVE sym=%s coid=%s executed=%s remaining=%s" % (
                    sym, ex["clientOrderId"], ex.get("executedQty"), remaining_str))
            save_state(st)
            return
        if status in ORDER_TERMINAL_FAIL:
            # Order terminal TANPA menutup posisi -> recovery terkendali.
            recovery_close(sym, rec, pos, "TERMINAL_" + status, st)
            return
        # Status tak dikenal: perlakukan ambigu, tunggu re-check.
        log("EXIT_UNKNOWN_STATUS sym=%s status=%s" % (sym, status))
        save_state(st)
        return

    # (3) Order TIDAK ditemukan. Belum pasti (mungkin query terlalu dini):
    # wajib NOTFOUND_CONFIRMS kali berturut-turut + posisi masih terbuka
    # sebelum recovery order baru boleh dikirim.
    ex["notFoundCount"] = int(ex.get("notFoundCount", 0)) + 1
    log("EXIT_NOTFOUND sym=%s coid=%s count=%d/%d remaining=%s" % (
        sym, ex["clientOrderId"], ex["notFoundCount"], NOTFOUND_CONFIRMS, remaining_str))
    if ex["notFoundCount"] >= NOTFOUND_CONFIRMS:
        recovery_close(sym, rec, pos, "NOT_FOUND_CONFIRMED", st)
        return
    save_state(st)


def _adoption_verdict(wdg, pos):
    """Validasi kandidat adopsi pada recovery scan (Gate 4). Order terminal
    historis (FILLED/CANCELED/EXPIRED/REJECTED/...) TIDAK pernah dianggap exit
    pending posisi sekarang. Order AKTIF hanya diadopsi bila konsisten dengan
    posisi sekarang: side close benar (SELL utk LONG / BUY utk SHORT), tipe
    MARKET, dan sisa qty order == positionAmt aktual. Selain itu simbol
    dikembalikan ke MONITORING; tidak ada order otomatis dari recovery."""
    if not wdg:
        return {"verdict": "CLEAN", "order": None, "detail": "no WDG_ orders"}
    o = wdg[-1]  # paling akhir
    status = str(o.get("status", "")).upper()
    coid = str(o.get("clientOrderId", ""))
    if status not in ORDER_ACTIVE:
        return {"verdict": "SKIP_TERMINAL", "order": None,
                "detail": "coid=%s status=%s" % (coid, status or "?")}
    want_side = "SELL" if pos["side"] == "LONG" else "BUY"
    otype = str(o.get("type", "")).upper()
    if otype and otype != "MARKET":
        return {"verdict": "AMBIGUOUS_TYPE", "order": None,
                "detail": "coid=%s type=%s" % (coid, otype)}
    if str(o.get("side", "")).upper() != want_side:
        return {"verdict": "AMBIGUOUS_SIDE", "order": None,
                "detail": "coid=%s side=%s want=%s" % (
                    coid, o.get("side"), want_side)}
    try:
        orig = float(o.get("origQty"))
        cum = float(o.get("cumQty", 0) or 0)
    except Exception:
        return {"verdict": "AMBIGUOUS_QTY", "order": o,
                "detail": "coid=%s qty tidak terbaca" % coid}
    remaining = orig - cum
    if remaining <= 0 or fmt_qty(remaining) != fmt_qty(abs(pos["amt"])):
        return {"verdict": "AMBIGUOUS_QTY", "order": o,
                "detail": "coid=%s orderRemaining=%s posAmt=%s" % (
                    coid,
                    fmt_qty(remaining) if remaining > 0 else str(remaining),
                    fmt_qty(abs(pos["amt"])))}
    return {"verdict": "adopt", "order": o, "detail": coid}


def recovery_scan(st, positions):
    """State hilang/rusak/format lama: sebelum boleh kirim exit baru, periksa
    dulu apakah ada order WDG_ yang masih AKTIF di exchange (allOrders per
    simbol) dan adopsi hanya bila lolos validasi _adoption_verdict. Order
    terminal historis tidak pernah diadopsi sebagai exit posisi sekarang.
    Query gagal -> scan diulang tick depan (fail-closed); tidak pernah
    mengasumsikan flat."""
    open_pos = [p for p in positions if p["amt"] != 0]
    if not open_pos:
        st["_recovery_scan"] = False
        save_state(st)
        return
    all_ok = True
    for pos in open_pos:
        sym = pos["symbol"]
        if sym in st["symbols"]:
            continue
        res = signed_request("GET", "/fapi/v1/allOrders", {"symbol": sym, "limit": 100})
        if not isinstance(res, list):  # error dict / respons tak dikenal
            all_ok = False
            log("RECOVERY_SCAN_FAIL sym=%s" % sym)
            continue
        wdg = [o for o in res if isinstance(o, dict)
               and str(o.get("clientOrderId", "")).startswith("WDG_")]
        verdict = _adoption_verdict(wdg, pos)
        if verdict["verdict"] == "adopt":
            o = verdict["order"]
            coid = str(o.get("clientOrderId"))
            st["symbols"][sym] = {
                "phase": PH_EXIT_PENDING,
                "positionId": position_identity(pos),
                "gen": int(time.time()),  # basis generasi baru (unik)
                "updatedAt": now_iso(),
                "exit": {
                    "exitId": coid, "clientOrderId": coid,
                    "orderId": o.get("orderId"), "reason": "RECOVERED",
                    "level": None, "side": o.get("side"),
                    "qty": str(o.get("origQty", "")),
                    "attempts": 1, "sentAt": now_iso(), "updatedAt": now_iso(),
                    "lastOutcome": "RECOVERED_SCAN",
                    "orderStatus": str(o.get("status", "")).upper() or None,
                    "executedQty": o.get("cumQty", o.get("executedQty")),
                    "remainingQty": fmt_qty(abs(pos["amt"])),
                    "notFoundCount": 0, "queryFailCount": 0,
                },
            }
            log("RECOVERY_SCAN_ADOPT sym=%s coid=%s status=%s" % (
                sym, coid, o.get("status")))
        else:
            # Terminal historis / kandidat ambigu -> jalur MONITORING normal:
            # proteksi native TETAP, trigger SL/TP yang tidak berubah tetap
            # berhak memutuskan exit baru. TIDAK ada order otomatis di sini.
            st["symbols"][sym] = {
                "phase": PH_MONITORING,
                "positionId": position_identity(pos),
                "gen": 0, "updatedAt": now_iso(),
            }
            if verdict["verdict"] == "AMBIGUOUS_QTY" and verdict["order"]:
                # Kandidat AKTIF yang BISA KONFLIK dgn close posisi ini
                # (MARKET, side close benar, sisa qty ambigu): catat utk
                # arbitrase terbatas sebelum close baru.
                st["symbols"][sym]["candidate"] = {
                    "clientOrderId": str(verdict["order"].get("clientOrderId")),
                    "reason": "AMBIGUOUS_QTY",
                    "detail": verdict["detail"],
                    "checks": 0,
                    "recordedAt": now_iso(),
                }
                log("RECOVERY_SCAN_CANDIDATE sym=%s %s" % (sym, verdict["detail"]))
            else:
                # SKIP_TERMINAL / AMBIGUOUS_SIDE / AMBIGUOUS_TYPE / CLEAN:
                # tidak bisa konflik dgn posisi ini (side/tipe salah atau
                # sudah terminal) -> TIDAK menekan trigger monitoring.
                log("RECOVERY_SCAN_%s sym=%s %s" % (
                    verdict["verdict"], sym, verdict["detail"]))
    if all_ok:
        st["_recovery_scan"] = False
        log("RECOVERY_SCAN_DONE")
    save_state(st)


def tick(st):
    """Satu iterasi watchdog. per-simbol try/except: masalah satu simbol tidak
    memblokir simbol lain. Tidak ada sleep di sini (sleep di main loop).
    Return: True bila snapshot posisi OK (fetch sukses), False bila gagal."""
    positions, positions_ok = get_open_positions()
    if not positions_ok and time.time() < REST_COOLDOWN_UNTIL:
        # 25 Okt 2026 (FASE 3): sedang kena rate-limit 429/418 — jangan retry,
        # biarkan cooldown; tick berikutnya mencoba lagi.
        log("POS_FETCH_SKIP_REST_COOLDOWN tick dilewati")
        ensure_monitor(True)
        return False
    if not positions_ok:
        # 13 Okt 2026: retry cepat berbatas — satu connection reset tidak
        # boleh memakan satu interval poll penuh (insiden GTCUSDT #3032:
        # buta tepat di detik spike). Tetap fail-closed: gagal terus = tick dilewati.
        for attempt in range(2, POS_RETRY_MAX + 1):
            time.sleep(POS_RETRY_SLEEP_SEC)
            positions, positions_ok = get_open_positions()
            if positions_ok:
                log("POS_FETCH_RETRY_OK attempt=%d" % attempt)
                break
            log("POS_FETCH_FAIL attempt=%d/%d" % (attempt, POS_RETRY_MAX))
    if positions_ok:
        ensure_monitor(any(p["amt"] != 0 for p in positions))
    else:
        ensure_monitor(True)  # ambigu: pertahankan monitor
    if not positions_ok:
        # Gagal baca posisi: JANGAN clear state, JANGAN simpulkan flat.
        log("POS_FETCH_FAIL state dipertahankan, tick dilewati")
        return False
    # Sweep orphan SLA_/TPA_ (13 Okt): algo proteksi NEW di exchange sementara
    # TIDAK ADA posisi terbuka sama sekali (bukti positionRisk, bukan DB).
    # Entry jalur bracket + simbol dgn posisi OPEN + state exit aktif = DIKECUALIKAN.
    # Signature (posisi kosong) dibaca SEBELUM sweep; bila berubah, tick ini batal.
    global _orphan_sweep_last
    if positions_ok and not positions and time.monotonic() - _orphan_sweep_last >= ORPHAN_SWEEP_INTERVAL_SEC:
        _orphan_sweep_last = time.monotonic()
        try:
            sweep_orphan_protective(st)
        except Exception as e:
            log("ORPHAN_SWEEP_FAIL %s" % e)
    if st.get("_recovery_scan"):
        recovery_scan(st, positions)
        # Setelah recovery scan (tuntas ATAU masih gagal): tunggu tick berikutnya
        # sebelum bertindak. Fail-closed: jangan kirim exit pada tick yang sama
        # dengan rekonstruksi state — biarkan state pulih menetap dulu.
        return True
    pos_by_sym = {p["symbol"]: p for p in positions if p["amt"] != 0 and (not ALLOWED or p["symbol"] in ALLOWED)}
    # P5: pastikan feed WS berlangganan semua simbol yang punya posisi.
    if WS_FEED is not None:
        try:
            missing = [s for s in pos_by_sym if s not in WS_FEED.symbols()]
            if missing:
                WS_FEED.subscribe_symbols(missing)
        except Exception:
            pass

    # 1) Rekonsiliasi simbol dengan exit aktif / degraded — termasuk yang
    #    posisinya sudah hilang dari exchange (native SL/TP menang race).
    for sym in list(st["symbols"].keys()):
        rec = st["symbols"][sym]
        try:
            if rec["phase"] in (PH_EXIT_PENDING, PH_DEGRADED):
                if rec["phase"] == PH_DEGRADED and rec.get("candidate") \
                        and not rec.get("exit"):
                    # DEGRADED HANYA karena kandidat ambigu (tanpa exit):
                    # watch pasif — pantau kandidat sampai tuntas. Proteksi
                    # native TETAP; tanpa order dari jalur ini.
                    _arbitrate_candidates(sym, pos_by_sym.get(sym), rec, None, st)
                    continue
                reconcile_exit(sym, rec, pos_by_sym.get(sym), st)
            elif rec["phase"] == PH_FLAT_CONFIRMED and sym not in pos_by_sym:
                # Flat sudah direkonsiliasi dengan exchange -> boleh dibersihkan.
                del st["symbols"][sym]
                save_state(st)
            elif rec["phase"] == PH_MONITORING and sym not in pos_by_sym \
                    and (not ALLOWED or sym in ALLOWED):
                if rec.get("candidate"):
                    # Kandidat di MONITORING tapi posisi sudah hilang dari
                    # positionRisk (exchange ok): arbitrase -> confirm flat,
                    # tanpa close. Snapshot fresh = cukup.
                    _arbitrate_candidates(sym, None, rec, None, st)
                else:
                    # Posisi ditutup di LUAR jalur exit watchdog (SL/TP native,
                    # close manual, atau server): tidak ada fase exit yang akan
                    # membersihkannya. Hitung konfirmasi flat, lalu hapus supaya
                    # state tidak basi selamanya dan orphan sweep tidak terblokir.
                    rec["flatMisses"] = next_flat_misses(rec, False)
                    rec["updatedAt"] = now_iso()
                    if should_clear_stale_monitoring(rec, False):
                        log("STALE_MONITORING_CLEAR sym=%s misses=%d posId=%s — posisi flat di exchange, state dibersihkan" % (
                            sym, rec["flatMisses"], rec.get("positionId")))
                        del st["symbols"][sym]
                    save_state(st)
        except Exception as e:
            log("RECONCILE_FAIL sym=%s %s" % (sym, e))

    # 2) Pantau posisi terbuka (level + touch + begin exit).
    lvl_db = levels_from_db()
    for sym, pos in pos_by_sym.items():
        try:
            rec = st["symbols"].get(sym)
            pid = position_identity(pos)
            if rec is not None and rec.get("positionId") != pid:
                # Posisi BARU (entry berbeda) setelah close sebelumnya: reset.
                st["symbols"][sym] = rec = {
                    "phase": PH_MONITORING, "positionId": pid,
                    "gen": int(rec.get("gen", 0)), "updatedAt": now_iso(),
                }
                save_state(st)
            if rec is None:
                st["symbols"][sym] = rec = {
                    "phase": PH_MONITORING, "positionId": pid,
                    "gen": 0, "updatedAt": now_iso(),
                }
                save_state(st)
            if rec.get("flatMisses"):
                # Posisi muncul kembali sebelum ambang cleanup -> reset hitungan.
                rec["flatMisses"] = 0
                rec["updatedAt"] = now_iso()
                save_state(st)
            if rec["phase"] in (PH_EXIT_PENDING, PH_DEGRADED):
                # Sudah ditangani jalur rekonsiliasi; jangan kirim dobel.
                continue
            # CP-2 final hardening: arbitrase kandidat ambigu SEBELUM trigger
            # diproses. False = hold tick ini (tanpa order); kandidat tuntas /
            # tidak bisa konflik -> True -> trigger berjalan normal.
            if rec.get("candidate") and not _arbitrate_candidates(sym, pos, rec, None, st):
                continue
            # P4: level dari cache bila masih valid (TTL <= 2x poll — edit SL/TP
            # manual di HP tetap terdeteksi maksimal 1 TTL kemudian). Cache miss:
            # query algo order LIVE per simbol + fallback DB. HANYA hasil algo
            # SUKSES yang di-cache; query gagal/kosong tidak pernah jadi stale.
            levels = LEVELS_CACHE.get(sym, pid)
            if levels is None:
                lvl_orders = levels_from_algo_orders([pos])
                if lvl_orders.get(sym):
                    levels = dict(lvl_db.get(sym, {}))
                    levels.update(lvl_orders[sym])  # algo order LIVE = sumber utama
                    LEVELS_CACHE.put(sym, pid, levels)
                else:
                    levels = dict(lvl_db.get(sym, {}))
            if not levels:
                continue
            px, receipt_at = _last_price_for(sym)
            if px is None:
                continue
            sl = levels.get("sl")
            # A full-close watchdog must not consume a SWING ladder's first TP.
            # Unknown DB mode also retains native TP protection rather than guessing.
            tp = levels.get("tp") if levels.get("tpPolicy") == "SINGLE_TARGET" else None
            # peringatan dini saat mendekati level
            for name, lvl in (("SL", sl), ("TP", tp)):
                if not lvl:
                    continue
                dist_pct = abs(px - lvl) / lvl * 100
                if dist_pct <= ALERT_PCT:
                    log("NEAR_%s %s last=%.8f level=%.8f dist=%.3f%%" % (name, sym, px, lvl, dist_pct))
            touched = decide_touch(px, pos["side"], sl, tp)
            if touched:
                name, lvl = touched
                log("TOUCH_%s %s %s last=%.8f level=%.8f" % (name, sym, pos["side"], px, lvl))
                begin_exit(sym, pos, name, lvl, st, receipt_at=receipt_at)
        except Exception as e:
            log("SYMBOL_FAIL sym=%s %s" % (sym, e))
    save_state(st)
    return True


def ensure_monitor(has_positions):
    """Monitor LLM: aktif SELAMA ada posisi, berhenti saat tidak ada trade
    (perintah operator). Watchdog menyalakannya kembali saat trade baru masuk."""
    if DRY_RUN or not CFG.get("enable_monitor"):
        return
    script = CFG.get("monitor_script")
    if not script or not os.path.exists(script):
        return
    pid_file = os.path.join(HERE, "monitor.pid")
    alive = False
    if os.path.exists(pid_file):
        try:
            with open(pid_file, "r", encoding="utf-8") as f:
                pid = int(f.read().strip() or "0")
            if pid > 0:
                os.kill(pid, 0)  # raise bila mati
                alive = True
        except Exception:
            alive = False
    if has_positions and not alive:
        proc = subprocess.Popen(
            [sys.executable, script],
            stdout=open(os.path.join(HERE, "monitor.out"), "a"),
            stderr=subprocess.STDOUT,
        )
        # 25 Okt 2026 (FASE 2 stabilitas): reap child setelah selesai — tanpa
        # ini monitor yang exit jadi ZOMBIE (defunct) selamanya dan menumpuk
        # tiap spawn (temuan scan operasional: PID defunct PPID watchdog).
        threading.Thread(target=proc.wait, daemon=True).start()
        with open(pid_file, "w", encoding="utf-8") as f:
            f.write(str(proc.pid))
        log("MONITOR_SPAWN pid=%d" % proc.pid)
    # Saat tidak ada posisi: monitor BERHENTI SENDIRI (exit 0) setelah menulis
    # 5-why untuk trade yang baru tutup — jangan dibunuh dari luar, biar catatan
    # learning-nya tidak terpotong.


def _listen_key_request(method):
    """POST/PUT /fapi/v1/listenKey — TIDAK butuh signature (cukup API key)."""
    if DRY_RUN or not _runtime_configured:
        raise RuntimeError("User-data mutation unavailable in dry-run/unconfigured runtime")
    req = urllib.request.Request(BASE + "/fapi/v1/listenKey", method=method)
    req.add_header("X-MBX-APIKEY", API_KEY)
    if method == "PUT":
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        req.data = b""
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())


def _init_ws_user_listener():
    """P5: listener user-data (observasi ORDER_TRADE_UPDATE/ACCOUNT_UPDATE/
    ALGO_UPDATE ke JSONL). Default NONAKTIF; tidak di jalur eksekusi."""
    if not CFG.get("ws_user_enabled"):
        return None
    try:
        import ws_market as _wsm
        lst = _wsm.WsUserDataListener(
            sink_path=CFG.get("ws_user_sink_file") or os.path.join(HERE, "ws_user_events.jsonl"),
            api_key_header_fn=lambda: {"X-MBX-APIKEY": API_KEY},
            listen_key_fn=lambda: _listen_key_request("POST")["listenKey"],
            keepalive_fn=lambda key: _listen_key_request("PUT"))
        lst.start()
        log("WS_USER_LISTENER_START sink=%s" % lst.sink)
        return lst
    except Exception as e:
        log("WS_USER_LISTENER_INIT_FAIL %s — rekonsiliasi REST tetap jalan" % e)
        return None


def main():
    configure_runtime()
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    log("WATCHDOG_START dry_run=%s poll=%.1fs price=LAST alert=%.2f%% exit_max_attempts=%d notfound_confirmations=%d pos_retry=%d heartbeat=%.0fs" % (
        DRY_RUN, POLL_SEC, ALERT_PCT, EXIT_MAX_ATTEMPTS, NOTFOUND_CONFIRMS, POS_RETRY_MAX, HEARTBEAT_SEC))
    if DRY_RUN:
        log("MODE_DRY_RUN: aksi dicatat TANPA kirim order. Set dry_run=false di watchdog_config.json untuk live.")
    state = load_state()
    init_ws_feed()          # P5: default nonaktif; fail-closed ke REST
    _init_ws_user_listener()  # P5: default nonaktif; observasi saja
    n_flat = 0
    # 13 Okt 2026 — heartbeat: bukti aliveness tiap HEARTBEAT_SEC (age tick terakhir).
    # Membedakan "diam sehat" (nggak ada posisi/event) dari proses stuck.
    last_ok_tick = time.monotonic()
    last_hb = 0.0
    while RUNNING:
        try:
            ok = tick(state)
            if ok:
                last_ok_tick = time.monotonic()
            else:
                log("LOOP_TICK_FETCH_FAILED last_ok=%.1fs lalu" % (time.monotonic() - last_ok_tick))
        except Exception as e:
            log("LOOP_FAIL %s" % e)
        n_flat = sum(1 for r in state["symbols"].values()
                     if r.get("phase") == PH_FLAT_CONFIRMED)
        now_m = time.monotonic()
        if now_m - last_hb >= HEARTBEAT_SEC:
            last_hb = now_m
            log("HEARTBEAT alive=1 ticks_ok_age=%.1fs flat_confirmed=%d" % (
                now_m - last_ok_tick, n_flat))
        time.sleep(POLL_SEC)
    log("WATCHDOG_STOP flat_confirmed=%d" % n_flat)


if __name__ == "__main__":
    main()
