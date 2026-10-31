#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
monitor_agent.py — AI agent LLM pemantau posisi (12 Okt 2026).

PERINTAH OPERATOR:
  "agent monitor harus SELALU AKTIF selama ada posisi — tidak ada jeda-menit.
   Hanya boleh berhenti apabila tidak ada trade."

CARA KERJA:
  - Posisi ADA  -> monitoring berjalan TERUS (cek state tiap beberapa detik,
    bukan menit). Evaluasi LLM dipicu EVENT (dekat SL/TP, pergerakan besar,
    posisi ditutup), bukan timer.
  - Posisi KOSONG -> proses BERHENTI (exit bersih). Watchdog (selalu jalan)
    menyalakannya kembali otomatis saat trade baru masuk.
  - Saat trade ditutup (SL/TP): tulis 5-why + reason + evaluasi + feedback ke
    LearningEntry -> dibaca getRecentLessons() -> masuk konteks judge untuk
    ENTRY BARU. Ini loop learning yang hidup, bukan data pajangan.

LLM hanya untuk ANALISIS dan TULISAN. Eksekusi SL/TP = watchdog_sltp.py
(deterministik). Kunci API dibaca dari .env, TIDAK PERNAH dicetak.
"""
import hashlib
import hmac
import json
import os
import signal
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from runtime_config import default_config, load_config, load_environment

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "watchdog_config.json")
MONITOR_STATE = os.path.join(HERE, "monitor_state.json")
MONITOR_LOG = os.path.join(HERE, "monitor.log")

RUNNING = True


def _stop(signum, frame):
    global RUNNING
    RUNNING = False


def log(msg):
    line = "%s %s" % (datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z", msg)
    print(line, flush=True)
    if not _runtime_configured:
        return
    try:
        with open(MONITOR_LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def load_env(path):
    return load_environment(path)


CFG = default_config()
ENV = {}
API_KEY = API_SECRET = LLM_KEY = ""
LLM_BASE = "https://api.xkiro.com/v1"
LLM_MODEL = "xiaomi/mimo-v2.6-pro"
_runtime_configured = False
BASE = CFG["binance_base"].rstrip("/")
DB_PATH = CFG["db_path"]
POLL_SEC = 3.0          # monitoring state: detik, BUKAN menit
ANALYZE_MIN_GAP = 90.0  # jarak minimum antar evaluasi LLM biasa (hemat token)
NEAR_PCT = 0.5          # pemicu evaluasi saat mendekati SL/TP


def configure_runtime(config_path=None):
    global CFG, ENV, API_KEY, API_SECRET, LLM_KEY, LLM_BASE, LLM_MODEL, BASE, DB_PATH, _runtime_configured
    CFG = load_config(config_path)
    ENV = load_env(CFG["env_file"])
    API_KEY, API_SECRET = ENV.get("BINANCE_API_KEY", ""), ENV.get("BINANCE_API_SECRET", "")
    if not API_KEY or not API_SECRET:
        raise ValueError("Monitor credentials are unavailable")
    LLM_KEY = ENV.get("XKIRO_API_KEY", "")
    LLM_BASE = (ENV.get("XKIRO_BASE_URL") or "https://api.xkiro.com/v1").rstrip("/")
    LLM_MODEL = ENV.get("XKIRO_MODEL_REASON") or "xiaomi/mimo-v2.6-pro"
    BASE, DB_PATH = CFG["binance_base"].rstrip("/"), CFG["db_path"]
    _runtime_configured = True


def signed_request(method, path, params=None):
    if not _runtime_configured or not API_KEY or not API_SECRET or method.upper() != "GET":
        return {"_error": True, "body": "MONITOR_REQUEST_UNAVAILABLE"}
    params = dict(params or {})
    params["timestamp"] = str(int(time.time() * 1000))
    params["recvWindow"] = "5000"
    qs = urllib.parse.urlencode(params)
    sig = hmac.new(API_SECRET.encode(), qs.encode(), hashlib.sha256).hexdigest()
    url = "%s%s?%s&signature=%s" % (BASE, path, qs, sig)
    req = urllib.request.Request(url, method=method)
    req.add_header("X-MBX-APIKEY", API_KEY)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        log("REQ_FAIL %s %s" % (path, e))
        return {"_error": True, "body": str(e)}


def get_positions():
    res = signed_request("GET", "/fapi/v2/positionRisk", {})
    if not isinstance(res, list):
        return None  # a failed snapshot is never evidence that the account is flat
    out = []
    for p in res:
        try:
            amt = float(p.get("positionAmt", 0))
        except Exception:
            continue
        if amt == 0:
            continue
        out.append({
            "symbol": str(p.get("symbol", "")).upper(),
            "amt": amt,
            "side": "LONG" if amt > 0 else "SHORT",
            "entry": float(p.get("entryPrice", 0) or 0),
            "mark": float(p.get("markPrice", 0) or 0),
            "upnl": float(p.get("unRealizedProfit", 0) or 0),
        })
    return out


def db_query(sql, args=()):
    from pathlib import Path
    con = sqlite3.connect(Path(DB_PATH).resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
    try:
        cur = con.execute(sql, args)
        rows = cur.fetchall()
        return rows
    finally:
        con.close()


def db_exec(sql, args=()):
    con = sqlite3.connect(DB_PATH, timeout=5)
    try:
        con.execute(sql, args)
        con.commit()
        return True
    finally:
        con.close()


def llm_chat(system, user, max_tokens=1600):
    if not _runtime_configured or CFG.get("dry_run", True) or not LLM_KEY:
        return None
    body = json.dumps({
        "model": LLM_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.3,
    }).encode()
    req = urllib.request.Request(LLM_BASE + "/chat/completions", data=body, method="POST")
    req.add_header("Authorization", "Bearer " + LLM_KEY)
    req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read().decode())
        return data["choices"][0]["message"]["content"]
    except Exception as e:
        log("LLM_FAIL %s" % e)
        return None


def load_state():
    try:
        with open(MONITOR_STATE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"known_open": {}, "last_analyze": {}}


def save_state(st):
    try:
        tmp = MONITOR_STATE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(st, f)
        os.replace(tmp, MONITOR_STATE)
    except Exception:
        pass


# ── loop learning: tulis 5-why + reason + evaluasi + feedback per trade tutup ─
def write_5why_for_trade(trade_id):
    rows = db_query(
        "SELECT t.id, t.symbol, t.side, t.entryAvg, t.exitAvg, t.pnlUsd, t.rMultiple,"
        " t.feeUsd, t.fundingUsd, t.win, t.strategyId, t.accountingQuality,"
        " p.closeReason FROM Trade t LEFT JOIN Position p ON p.id=t.positionId"
        " WHERE t.id=?", (trade_id,))
    if not rows:
        return False
    (tid, sym, side, entry, exit_, pnl, rmul, fee, funding, win, strat, acct, close_reason) = rows[0]
    exists = db_query("SELECT id FROM LearningEntry WHERE tradeId=?", (trade_id,))
    if exists:
        log("SKIP_5WHY trade=%d sudah punya %d LearningEntry" % (trade_id, len(exists)))
        return False
    net = (pnl or 0) - (fee or 0) - (funding or 0)
    outcome = "WIN_" + str(close_reason or "TP1") if win else "LOSS_" + str(close_reason or "SL")
    prompt = (
        "Kamu adalah analis trading crypto futures. Trade berikut BARU ditutup.\n"
        "Symbol: %s | Side: %s | Strategi: %s | Exit: %s\n"
        "Entry: %s | Exit fill: %s | Gross PnL: %.5f | Fee: %.5f | Funding: %.5f | NET: %.5f | R: %s\n\n"
        "TULIS dalam Bahasa Indonesia, JSON murni tanpa markdown, skema:\n"
        '{"reason":"kenapa entry ini masuk akal/tidak dari sisi strategi",'
        '"evaluasi":"apa yang terjadi vs rencana (SL/TP, slippage, timing)",'
        '"feedback":"1-2 kalimat aturan konkret untuk trade BERIKUTNYA",'
        '"whys":["why-1","why-2","why-3","why-4","why-5"]}\n'
        "5 why = rantai sebab dari gejala ke akar (fokus: eksekusi, timing, level, "
        "sizing, kondisi market). Semua = HIPOTESIS, bukan klaim pasti. "
        "Tanpa angka uang baru selain yang diberikan."
    ) % (sym, side, strat or "-", close_reason or "-", entry, exit_, pnl or 0,
         fee or 0, funding or 0, net, rmul)
    raw = llm_chat(
        "Kamu menulis diagnosis post-mortem trading yang jujur, ringkas, dan dapat ditindaklanjuti.",
        prompt)
    analysis = None
    if raw:
        try:
            start = raw.find("{")
            end = raw.rfind("}")
            if start >= 0 and end > start:
                analysis = json.loads(raw[start:end + 1])
        except Exception:
            analysis = None
    valid_analysis = (isinstance(analysis, dict) and
                      all(isinstance(analysis.get(k), str) and analysis[k].strip()
                          for k in ("reason", "evaluasi", "feedback")) and
                      isinstance(analysis.get("whys"), list) and
                      len(analysis["whys"]) == 5 and
                      all(isinstance(w, str) and w.strip() for w in analysis["whys"]))
    source = "LLM" if valid_analysis else "DETERMINISTIC_FALLBACK"
    if not valid_analysis:
        analysis = {
            "reason": "Fallback tanpa LLM: entry mengikuti sinyal strategi %s." % (strat or "-"),
            "evaluasi": "Exit via %s; gross %.5f, fee %.5f, NET %.5f (fill asli)."
                        % (close_reason or "-", pnl or 0, fee or 0, net),
            "feedback": "Belum ada diagnosis LLM valid; evaluasi strategi dan eksekusi memerlukan bukti tambahan.",
            "whys": ["Gejala: hasil trade %s." % ("profit" if win else "loss"),
                     "Penyebab entry belum diverifikasi.",
                     "Kondisi likuiditas saat exit belum diverifikasi.",
                     "Dampak spread dan slippage belum diverifikasi.",
                     "Akar sebab belum dapat ditentukan dari ringkasan trade saja."],
        }
    whys = analysis.get("whys") or []
    why_txt = ""
    for i, w in enumerate(whys[:5]):
        why_txt += "\nWHY-%d (HIPOTESIS): %s" % (i + 1, w)
    lesson = "REASON: %s EVALUASI: %s FEEDBACK: %s%s" % (
        analysis.get("reason", "-"), analysis.get("evaluasi", "-"),
        analysis.get("feedback", "-"), why_txt)
    narrative = "Post-trade %s %s %s -> NET %.5f (%s). Sumber: %s." % (
        sym, side, close_reason or "-", net, outcome, source)
    proposal = json.dumps({
        "action": "LEARNING_LOOP",
        "reason": analysis.get("feedback", "-"),
        "hypothesisOnly": True,
        "evidenceVersion": 2,
        "generationSource": source,
        "tradeId": tid,
        "accountingQuality": acct or "VERIFIED",
        "observedOutcome": outcome,
        "source": "monitor-agent",
        "analysis": analysis,
    })
    try:
        db_exec(
            "INSERT INTO LearningEntry (tradeId, causeCode, narrative, proposal,"
            " outcome, lesson, agentId, executionMistake, isExecutionMistake)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (tid, "POST_TRADE_" + str(close_reason or "EXIT"), narrative, proposal,
             outcome, lesson, "monitor-llm", "MISTAKE_NONE", 0))
        log("5WHY_WRITTEN trade=%d %s outcome=%s" % (tid, sym, outcome))
        return True
    except Exception as e:
        log("5WHY_WRITE_FAIL trade=%d %s" % (tid, e))
        return False


def watch_position(pos, state):
    """Satu siklus pemantauan posisi hidup."""
    sym = pos["symbol"]
    rows = db_query(
        "SELECT id, slPrice, tp1Price FROM Position WHERE symbol=? AND status='OPEN'"
        " ORDER BY id DESC LIMIT 1", (sym,))
    sl = tp = None
    pos_id = None
    if rows:
        pos_id, sl, tp = rows[0]
    px = pos["mark"]
    if px and sl:
        d_sl = abs(px - sl) / sl * 100
        if d_sl <= NEAR_PCT:
            log("NEAR_SL %s mark=%.8f sl=%.8f dist=%.3f%% upnl=%.4f" % (sym, px, sl, d_sl, pos["upnl"]))
            trigger_analyze(pos, state, "NEAR_SL")
    if px and tp:
        d_tp = abs(px - tp) / tp * 100
        if d_tp <= NEAR_PCT:
            log("NEAR_TP %s mark=%.8f tp=%.8f dist=%.3f%% upnl=%.4f" % (sym, px, tp, d_tp, pos["upnl"]))
            trigger_analyze(pos, state, "NEAR_TP")
    last = state.get("last_analyze", {}).get(sym, 0)
    if time.time() - last >= ANALYZE_MIN_GAP:
        trigger_analyze(pos, state, "PERIODIC")
    return pos_id


def trigger_analyze(pos, state, why):
    sym = pos["symbol"]
    state.setdefault("last_analyze", {})[sym] = time.time()
    save_state(state)
    rows = db_query(
        "SELECT id, slPrice, tp1Price, strategyId FROM Position WHERE symbol=? AND status='OPEN'"
        " ORDER BY id DESC LIMIT 1", (sym,))
    sl = tp = strat = None
    if rows:
        _, sl, tp, strat = rows[0]
    user = (
        "Posisi TERBUKA sedang dipantau (pemicu: %s).\n"
        "Symbol: %s | Side: %s | Entry: %.8f | Mark: %.8f | uPnL: %.5f\n"
        "SL: %s | TP: %s | Strategi: %s\n"
        "Beri evaluasi SINGKAT (maks 3 kalimat, Bahasa Indonesia): kondisi saat ini, "
        "risiko terbesar, satu saran konkret. Kalau tidak ada yang aneh, katakan netral."
    ) % (why, sym, pos["side"], pos["entry"], pos["mark"], pos["upnl"],
         sl or "-", tp or "-", strat or "-")
    out = llm_chat("Kamu pemantau posisi trading yang berhati-hati dan ringkas.", user, max_tokens=300)
    if out:
        log("ANALYSIS %s [%s] %s" % (sym, why, out.replace("\n", " ")[:300]))


def main():
    configure_runtime()
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    log("MONITOR_START model=%s poll=%.0fs (aktif selama ada posisi)" % (LLM_MODEL, POLL_SEC))
    state = load_state()
    known_open = state.setdefault("known_open", {})
    idle_ticks = 0
    while RUNNING:
        try:
            positions = get_positions()
            if positions is None:
                log("POSITION_FETCH_FAILED: state dipertahankan, bukan flat")
                time.sleep(POLL_SEC)
                continue
            if not positions:
                idle_ticks += 1
                # Tidak ada trade -> agent BOLEH berhenti (perintah operator).
                log("NO_POSITION: tidak ada trade aktif -> monitor berhenti.")
                # lapor trade yang baru tutup sejak terakhir dipantau
                for pid_ in list(known_open.values()):
                    tid_rows = db_query(
                        "SELECT id FROM Trade WHERE positionId=? ORDER BY id DESC LIMIT 1",
                        (pid_,))
                    if tid_rows:
                        write_5why_for_trade(int(tid_rows[0][0]))
                save_state(state)
                return 0
            seen = {}
            for pos in positions:
                sym = pos["symbol"]
                seen[sym] = True
                pos_id = watch_position(pos, state)
                if pos_id:
                    known_open[sym] = pos_id
            # deteksi posisi yang HILANG (ditutup SL/TP/watchdog) -> tulis 5-why
            for sym in list(known_open.keys()):
                if sym not in seen:
                    tid_rows = db_query(
                        "SELECT id FROM Trade WHERE positionId=? ORDER BY id DESC LIMIT 1",
                        (known_open[sym],))
                    if tid_rows:
                        write_5why_for_trade(int(tid_rows[0][0]))
                    else:
                        log("CLOSED_NO_TRADE_ROW %s positionId=%s" % (sym, known_open[sym]))
                    del known_open[sym]
            save_state(state)
        except Exception as e:
            log("LOOP_FAIL %s" % e)
        time.sleep(POLL_SEC)
    log("MONITOR_STOP")
    return 0


if __name__ == "__main__":
    sys.exit(main())
