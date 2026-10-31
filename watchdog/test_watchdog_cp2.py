#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
test_watchdog_cp2.py — Test deterministik CP-2 (F-02 & F-03) untuk
watchdog_sltp.py. SEMUA fungsi network di-patch ke FakeExchange — tidak ada
satupun request ke Binance, tidak ada live order, tidak menyentuh service.

Jalankan: python3 test_watchdog_cp2.py
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import watchdog_sltp as wd


class FakeExchange:
    """Mock exchange Binance futures (One-way Mode)."""

    def __init__(self):
        self.positions = {}          # sym -> amt (float, boleh 0)
        self.entries = {}            # sym -> entryPrice
        self.orders = {}             # clientOrderId -> order dict
        self.posts = []              # semua POST /fapi/v1/order
        self.submit_results = []     # antrean perilaku submit (FIFO)
        self.query_override = {}     # coid -> "error" | "notfound" | "ambig"
        self.allorders = {}          # sym -> list order (recovery scan)
        self.allorders_fail = False
        self.risk_fail = False       # positionRisk gagal
        self.last = {}               # sym -> last price
        self.levels = {}             # sym -> {"sl":.., "tp":..}
        self._oid = 1000

    # ── helpers ──
    def set_position(self, sym, amt, entry=1.0):
        self.positions[sym] = amt
        self.entries[sym] = entry

    def positions_list(self):
        out = []
        for sym, amt in self.positions.items():
            out.append({
                "symbol": sym, "positionAmt": str(amt),
                "entryPrice": str(self.entries.get(sym, 1.0)),
                "markPrice": str(self.entries.get(sym, 1.0)),
            })
        return out

    # ── network mock ──
    def signed_request(self, method, path, params=None):
        params = params or {}
        if path == "/fapi/v2/positionRisk":
            if self.risk_fail:
                return {"_error": True, "body": "risk fail"}
            return self.positions_list()
        if path == "/fapi/v1/order" and method == "GET":
            coid = params.get("origClientOrderId")
            mode = self.query_override.get(coid)
            if mode == "error":
                return {"_error": True, "code": 500, "body": "internal"}
            if mode == "ambig":
                return {"_error": True, "code": 429, "binance_code": -1003,
                        "body": "rate limited"}
            if coid in self.orders:
                return dict(self.orders[coid])
            return {"_error": True, "code": 400, "binance_code": -2013,
                    "body": '{"code":-2013,"msg":"Order does not exist."}'}
        if path == "/fapi/v1/order" and method == "POST":
            return self._place(params)
        if path == "/fapi/v1/allOrders":
            if self.allorders_fail:
                return {"_error": True, "body": "allorders fail"}
            return self.allorders.get(params.get("symbol"), [])
        if path == "/fapi/v1/algoOrder":
            return {"_error": True, "body": "no algo in tests"}
        return {"_error": True, "body": "unhandled " + path}

    def public_get(self, path, params=None):
        if path == "/fapi/v1/ticker/price":
            sym = (params or {}).get("symbol")
            if sym in self.last:
                return {"price": str(self.last[sym])}
        return None

    def _place(self, params):
        sym = params["symbol"]
        coid = params["newClientOrderId"]
        qty = float(params["quantity"])
        self.posts.append(dict(params))
        if not self.submit_results:
            raise AssertionError("submit_results kosong — test tidak deterministik")
        mode = self.submit_results.pop(0)
        kind = mode[0]
        if kind == "timeout":
            register = mode[1] if len(mode) > 1 else False
            status = mode[2] if len(mode) > 2 else "NEW"
            if register:
                self._register(sym, coid, qty, status)
            return {"_error": True, "_ambiguous": True, "body": "timed out"}
        if kind == "reject":
            code = mode[1]
            return {"_error": True, "code": 400, "binance_code": code,
                    "_ambiguous": False, "body": '{"code":%s}' % code}
        if kind == "error":
            return {"_error": True, "code": 500, "_ambiguous": False,
                    "body": "server error"}
        if kind == "ack":
            status = mode[1]
            fill_frac = mode[2] if len(mode) > 2 else (1.0 if status == "FILLED" else 0.0)
            o = self._register(sym, coid, qty, status)
            o["cumQty"] = ("%.8f" % (qty * fill_frac)).rstrip("0").rstrip(".")
            return dict(o)
        raise AssertionError("mode unknown: %r" % (mode,))

    def _register(self, sym, coid, qty, status):
        self._oid += 1
        o = {"clientOrderId": coid, "orderId": self._oid, "status": status,
             "origQty": ("%.8f" % qty).rstrip("0").rstrip("."),
             "cumQty": "0", "symbol": sym}
        self.orders[coid] = o
        return o


class Base(unittest.TestCase):
    def setUp(self):
        # Restore every overridden runtime hook after each test, including hooks
        # changed by subclasses. No fixture inherits another test's exchange.
        saved = dict(wd.__dict__)
        self.addCleanup(wd.__dict__.update, saved)
        wd.CFG = dict(wd.CFG)
        wd.WS_FEED = None
        wd.LEVELS_CACHE = wd._LevelsCache(0)
        wd.LAT_EVENTS = {}
        wd.log = lambda *args: None
        self.tmp = tempfile.mkdtemp(prefix="wdtest_")
        wd.STATE_PATH = os.path.join(self.tmp, "state.json")
        wd.CFG["log_file"] = os.path.join(self.tmp, "test.log")
        # Higiene telemetri (13 Okt): config produksi kini memuat latency_sink_file.
        # Test TIDAK BOLEH menulis ke sink produksi — arahkan ke tmp per-test.
        self._lat_path_saved = wd.LAT_PATH
        wd.LAT_PATH = os.path.join(self.tmp, "latency.jsonl")
        self.addCleanup(setattr, wd, "LAT_PATH", self._lat_path_saved)
        wd.DRY_RUN = False
        wd.EXIT_MAX_ATTEMPTS = 3
        wd.NOTFOUND_CONFIRMS = 2
        wd.QUERY_FAIL_MAX = 3
        self.fx = FakeExchange()
        wd.signed_request = self.fx.signed_request
        wd.public_get = self.fx.public_get
        wd.ensure_monitor = lambda has_positions: None
        wd.levels_from_db = lambda: {s: {**v, "tpPolicy": "SINGLE_TARGET"} for s, v in self.fx.levels.items()}
        wd.levels_from_algo_orders = lambda positions: {}
        wd.get_last_price = lambda sym: self.fx.last.get(sym)
        wd.get_open_positions = self._get_open_positions

    def _get_open_positions(self):
        """Mirror parsing get_open_positions() asli: (list posisi, ok)."""
        if self.fx.risk_fail:
            return ({"_error": True}, False)
        out = []
        for p in self.fx.positions_list():
            amt = float(p["positionAmt"])
            if amt == 0:
                continue
            out.append({
                "symbol": p["symbol"],
                "amt": amt,
                "side": "LONG" if amt > 0 else "SHORT",
                "entry": float(p["entryPrice"]),
                "mark": float(p["markPrice"]),
            })
        return out, True

    def state(self):
        return wd.new_state(recovery_scan=False)

    def tick(self, st):
        wd.tick(st)

    def phase(self, st, sym):
        rec = st["symbols"].get(sym)
        return rec["phase"] if rec else None

    def setup_long(self, sym="BTCUSDT", amt=100.0, sl=0.9, tp=1.1, last=0.85):
        """Posisi LONG yang sudah menyentuh SL (last <= sl)."""
        self.fx.set_position(sym, amt, entry=1.0)
        self.fx.levels[sym] = {"sl": sl, "tp": tp}
        self.fx.last[sym] = last


class TestF02AckBukanBuktiFlat(Base):
    def test_t00_happy_path_filled_lalu_flat_terkonfirmasi(self):
        self.setup_long()
        self.fx.submit_results.append(("ack", "FILLED"))
        st = self.state()
        self.tick(st)  # touch -> begin_exit, ack FILLED
        self.assertEqual(self.phase(st, "BTCUSDT"), wd.PH_EXIT_PENDING)
        # exchange benar-benar menutup posisi
        self.fx.set_position("BTCUSDT", 0.0)
        self.tick(st)  # rekonsiliasi: pos 0 + order FILLED -> konfirmasi
        self.assertEqual(self.phase(st, "BTCUSDT"), wd.PH_FLAT_CONFIRMED)
        self.assertEqual(st["symbols"]["BTCUSDT"]["closer"], "WATCHDOG")

    def test_t01_ack_filled_tapi_posisi_masih_terbuka_tidak_selesai(self):
        # F-02 inti: ACK FILLED bukan bukti flat. Posisi tetap terbuka
        # (qty berubah saat pending) -> recovery untuk sisa aktual.
        self.setup_long(amt=100.0)
        self.fx.submit_results.append(("ack", "FILLED"))
        st = self.state()
        self.tick(st)
        self.assertEqual(self.phase(st, "BTCUSDT"), wd.PH_EXIT_PENDING)
        # posisi masih terbuka dengan sisa 40 (ack tidak dipercaya)
        self.fx.set_position("BTCUSDT", 40.0)
        self.fx.submit_results.append(("ack", "FILLED"))
        self.tick(st)
        rec = st["symbols"]["BTCUSDT"]
        self.assertEqual(rec["phase"], wd.PH_EXIT_PENDING)
        self.assertNotEqual(rec["phase"], wd.PH_FLAT_CONFIRMED)
        self.assertEqual(rec["exit"]["attempts"], 2)
        # order recovery memakai kuantitas SIS exchange (40), bukan 100
        self.assertEqual(self.fx.posts[-1]["quantity"], "40")
        self.assertEqual(self.fx.posts[-1]["reduceOnly"], "true")
        self.fx.set_position("BTCUSDT", 0.0)
        self.tick(st)
        self.assertEqual(rec["phase"], wd.PH_FLAT_CONFIRMED)

    def test_t02_rejected_tetap_dimonitor(self):
        self.setup_long()
        self.fx.submit_results.append(("reject", -2022))  # reduce-only reject
        st = self.state()
        self.tick(st)
        rec = st["symbols"]["BTCUSDT"]
        self.assertEqual(rec["phase"], wd.PH_EXIT_PENDING)  # bukan selesai
        self.assertEqual(rec["exit"]["lastOutcome"], "SUBMIT_REJECTED")
        # tick berikutnya: order tidak ada di exchange (2x konfirmasi) -> recovery
        self.fx.submit_results.append(("ack", "FILLED"))
        self.tick(st)  # notFound 1
        self.assertEqual(rec["phase"], wd.PH_EXIT_PENDING)
        self.tick(st)  # notFound 2 -> recovery attempt 2
        self.assertEqual(rec["exit"]["attempts"], 2)
        self.fx.set_position("BTCUSDT", 0.0)
        self.tick(st)
        self.assertEqual(rec["phase"], wd.PH_FLAT_CONFIRMED)

    def test_t03_partial_fill_tetap_dimonitor_untuk_sisa(self):
        self.setup_long(amt=100.0)
        self.fx.submit_results.append(("ack", "PARTIALLY_FILLED", 0.6))
        st = self.state()
        self.tick(st)
        self.fx.set_position("BTCUSDT", 40.0)  # 60 sudah terisi close
        self.tick(st)  # order masih aktif -> JANGAN kirim order kedua
        rec = st["symbols"]["BTCUSDT"]
        self.assertEqual(rec["phase"], wd.PH_EXIT_PENDING)
        self.assertEqual(rec["exit"]["remainingQty"], "40")
        self.assertEqual(len(self.fx.posts), 1)  # tidak ada order baru
        # order selesai filled -> posisi flat
        self.fx.orders[rec["exit"]["clientOrderId"]]["status"] = "FILLED"
        self.fx.set_position("BTCUSDT", 0.0)
        self.tick(st)
        self.assertEqual(rec["phase"], wd.PH_FLAT_CONFIRMED)
        self.assertEqual(len(self.fx.posts), 1)


class TestF03TimeoutTanpaBlindRetry(Base):
    def test_t04_timeout_order_diterima_query_dulu_sebelum_apa_pun(self):
        self.setup_long(amt=100.0)
        # timeout, tapi order SEBENARNYA diterima exchange (status NEW)
        self.fx.submit_results.append(("timeout", True, "NEW"))
        st = self.state()
        self.tick(st)
        self.assertEqual(len(self.fx.posts), 1)
        # tick-tick berikutnya: query menemukan order aktif -> tunggu, tanpa POST baru
        for _ in range(5):
            self.tick(st)
        self.assertEqual(len(self.fx.posts), 1)  # tidak ada blind retry
        rec = st["symbols"]["BTCUSDT"]
        self.assertEqual(rec["phase"], wd.PH_EXIT_PENDING)
        self.assertEqual(rec["exit"]["orderStatus"], "NEW")
        # order akhirnya filled + posisi flat -> konfirmasi
        rec_coid = rec["exit"]["clientOrderId"]
        self.fx.orders[rec_coid]["status"] = "FILLED"
        self.fx.set_position("BTCUSDT", 0.0)
        self.tick(st)
        self.assertEqual(rec["phase"], wd.PH_FLAT_CONFIRMED)

    def test_t05_timeout_order_tidak_diterima_recovery_terkontrol(self):
        self.setup_long(amt=100.0)
        self.fx.submit_results.append(("timeout", False))  # order tak sampai
        st = self.state()
        self.tick(st)
        self.assertEqual(len(self.fx.posts), 1)
        # tick berikut TIDAK langsung resend: not-found harus konfirmasi 2x
        self.tick(st)
        self.assertEqual(len(self.fx.posts), 1)  # masih 1 — bukan blind retry
        self.assertEqual(st["symbols"]["BTCUSDT"]["exit"]["notFoundCount"], 1)
        self.fx.submit_results.append(("ack", "FILLED"))
        self.tick(st)  # notFound ke-2 -> recovery attempt 2
        self.assertEqual(len(self.fx.posts), 2)
        self.assertEqual(st["symbols"]["BTCUSDT"]["exit"]["attempts"], 2)
        self.fx.set_position("BTCUSDT", 0.0)
        self.tick(st)
        self.assertEqual(self.phase(st, "BTCUSDT"), wd.PH_FLAT_CONFIRMED)

    def test_t06_posisi_flat_sebelum_retry_tidak_ada_order_kedua(self):
        self.setup_long(amt=100.0)
        self.fx.submit_results.append(("timeout", False))
        st = self.state()
        self.tick(st)
        # native menutup posisi sebelum watchdog sempat retry
        self.fx.set_position("BTCUSDT", 0.0)
        self.tick(st)
        rec = st["symbols"]["BTCUSDT"]
        self.assertEqual(rec["phase"], wd.PH_FLAT_CONFIRMED)
        self.assertEqual(rec["closer"], "NATIVE_SLTP")
        self.assertEqual(len(self.fx.posts), 1)  # tidak ada close kedua
        self.tick(st)
        self.assertEqual(len(self.fx.posts), 1)

    def test_t07_native_sltp_menang_race_reject_lalu_flat(self):
        self.setup_long(amt=100.0)
        # submit ditolak karena posisi sudah ditutup native SL/TP
        self.fx.submit_results.append(("reject", -2022))
        st = self.state()
        self.tick(st)
        self.fx.set_position("BTCUSDT", 0.0)
        self.tick(st)
        rec = st["symbols"]["BTCUSDT"]
        self.assertEqual(rec["phase"], wd.PH_FLAT_CONFIRMED)
        self.assertEqual(rec["closer"], "NATIVE_SLTP")
        self.assertEqual(len(self.fx.posts), 1)

    def test_t13_duplicate_trigger_satu_logical_exit(self):
        self.setup_long(amt=100.0)
        # timeout tapi order diterima exchange (status NEW di book)
        self.fx.submit_results.append(("timeout", True, "NEW"))
        st = self.state()
        self.tick(st)  # touch pertama -> begin_exit
        # harga masih menyentuh level: trigger berulang di tick berikutnya.
        # Fase sudah EXIT_PENDING + order ditemukan ACTIVE -> TIDAK ada order baru.
        self.tick(st)
        self.tick(st)
        self.assertEqual(len(self.fx.posts), 1)  # tetap satu logical exit
        self.assertEqual(st["symbols"]["BTCUSDT"]["phase"], wd.PH_EXIT_PENDING)


class TestStateDanRecovery(Base):
    def test_t08_exit_pending_bertahan_setelah_restart(self):
        self.setup_long(amt=100.0)
        self.fx.submit_results.append(("timeout", True, "NEW"))
        st = self.state()
        self.tick(st)
        coid = st["symbols"]["BTCUSDT"]["exit"]["clientOrderId"]
        # ── simulasi restart: state dibaca ulang dari disk ──
        st2 = wd.load_state()
        self.assertEqual(st2["symbols"]["BTCUSDT"]["phase"], wd.PH_EXIT_PENDING)
        self.assertEqual(st2["symbols"]["BTCUSDT"]["exit"]["clientOrderId"], coid)
        # lanjut rekonsiliasi dengan state hasil reload: query order dulu
        self.fx.orders[coid]["status"] = "FILLED"
        self.fx.set_position("BTCUSDT", 0.0)
        self.tick(st2)
        self.assertEqual(st2["symbols"]["BTCUSDT"]["phase"], wd.PH_FLAT_CONFIRMED)
        self.assertEqual(len(self.fx.posts), 1)  # tidak kirim order baru

    def test_t09a_state_file_rusak_tidak_false_flat(self):
        self.setup_long(amt=100.0)
        with open(wd.STATE_PATH, "w", encoding="utf-8") as f:
            f.write("{{{ bukan json")
        st = wd.load_state()
        self.assertTrue(st["_recovery_scan"])
        self.assertEqual(st["symbols"], {})
        # recovery scan: tidak ada order WDG_ -> MONITORING, bukan flat
        self.tick(st)
        self.assertFalse(st["_recovery_scan"])
        self.assertEqual(st["symbols"]["BTCUSDT"]["phase"], wd.PH_MONITORING)
        # touch -> exit baru tetap bisa berjalan normal setelah scan
        self.fx.submit_results.append(("ack", "FILLED"))
        self.tick(st)
        self.assertEqual(st["symbols"]["BTCUSDT"]["phase"], wd.PH_EXIT_PENDING)

    def test_t09b_state_hilang_dan_allorders_gagal_fail_closed(self):
        self.setup_long(amt=100.0)
        st = wd.load_state()  # file tidak ada -> recovery scan
        self.assertTrue(st["_recovery_scan"])
        self.fx.allorders_fail = True
        self.tick(st)  # scan gagal -> fail-closed: JANGAN kirim exit
        self.assertTrue(st["_recovery_scan"])
        self.assertEqual(len(self.fx.posts), 0)
        self.fx.allorders_fail = False
        # adopsi order WDG_ yang ditemukan di allOrders
        self.fx.allorders["BTCUSDT"] = [{
            "clientOrderId": "WDG_abc123", "orderId": 77, "status": "NEW",
            "origQty": "100", "cumQty": "0", "side": "SELL"}]
        self.tick(st)
        self.assertFalse(st["_recovery_scan"])
        rec = st["symbols"]["BTCUSDT"]
        self.assertEqual(rec["phase"], wd.PH_EXIT_PENDING)  # adopsi, bukan resend
        self.assertEqual(rec["exit"]["clientOrderId"], "WDG_abc123")
        self.assertEqual(len(self.fx.posts), 0)

    def test_t10_dua_simbol_independen(self):
        self.setup_long(sym="AAAUSDT", amt=10.0)
        self.setup_long(sym="BBBUSDT", amt=20.0)
        st = self.state()
        # A: submit timeout; query order A selalu gagal -> ambiguous/degraded
        self.fx.submit_results.append(("timeout", False))
        self.fx.submit_results.append(("ack", "FILLED"))  # untuk B
        self.tick(st)
        self.fx.set_position("BBBUSDT", 0.0)  # B flat; A masih terbuka
        coid_a = st["symbols"]["AAAUSDT"]["exit"]["clientOrderId"]
        self.fx.query_override[coid_a] = "error"
        self.tick(st)  # B FLAT_CONFIRMED; A queryFail 1
        # B tetap selesai meski A bermasalah (lock per-simbol tidak saling blokir)
        self.assertEqual(st["symbols"]["BBBUSDT"]["phase"], wd.PH_FLAT_CONFIRMED)
        self.assertEqual(st["symbols"]["BBBUSDT"]["closer"], "WATCHDOG")
        self.tick(st)  # B dibersihkan SETELAH rekonsiliasi exchange; A queryFail 2
        self.assertNotIn("BBBUSDT", st["symbols"])
        self.tick(st)  # A queryFail 3 -> DEGRADED
        self.assertEqual(st["symbols"]["AAAUSDT"]["phase"], wd.PH_DEGRADED)

    def test_t11_query_order_gagal_ambiguous_bukan_selesai(self):
        self.setup_long(amt=100.0)
        self.fx.submit_results.append(("timeout", True, "NEW"))
        st = self.state()
        self.tick(st)
        coid = st["symbols"]["BTCUSDT"]["exit"]["clientOrderId"]
        self.fx.query_override[coid] = "error"
        for _ in range(2):
            self.tick(st)
        rec = st["symbols"]["BTCUSDT"]
        self.assertEqual(rec["phase"], wd.PH_EXIT_PENDING)  # bukan selesai
        self.assertNotEqual(rec["phase"], wd.PH_FLAT_CONFIRMED)
        self.assertEqual(rec["exit"]["queryFailCount"], 2)
        self.tick(st)  # fail ke-3 -> DEGRADED
        self.assertEqual(rec["phase"], wd.PH_DEGRADED)
        self.assertEqual(len(self.fx.posts), 1)  # tidak ada order baru

    def test_t12_batas_retry_tidak_terbatas(self):
        self.setup_long(amt=100.0)
        # attempt 1: timeout tanpa order; recovery 2x juga timeout tanpa order
        self.fx.submit_results.append(("timeout", False))
        st = self.state()
        self.tick(st)                                   # attempt 1
        self.fx.submit_results.append(("timeout", False))
        self.tick(st)  # notFound 1
        self.tick(st)  # notFound 2 -> attempt 2
        self.fx.submit_results.append(("timeout", False))
        self.tick(st)  # notFound 1
        self.tick(st)  # notFound 2 -> attempt 3 (maks)
        rec = st["symbols"]["BTCUSDT"]
        self.assertEqual(rec["exit"]["attempts"], 3)
        # berikutnya: sudah di batas -> DEGRADED, tanpa POST tambahan
        n_posts = len(self.fx.posts)
        self.tick(st)
        self.tick(st)
        self.assertEqual(rec["phase"], wd.PH_DEGRADED)
        self.assertEqual(len(self.fx.posts), n_posts)
        # degraded tetap pasif: tidak ada order baru meski posisi masih terbuka
        self.tick(st)
        self.assertEqual(len(self.fx.posts), n_posts)

    def test_t14_order_terminal_posisi_nonzero_recovery_aktif(self):
        self.setup_long(amt=100.0)
        self.fx.submit_results.append(("ack", "CANCELED"))
        st = self.state()
        self.tick(st)
        # posisi masih terbuka + order terminal CANCELED -> recovery
        self.fx.submit_results.append(("ack", "FILLED"))
        self.tick(st)
        rec = st["symbols"]["BTCUSDT"]
        self.assertEqual(rec["phase"], wd.PH_EXIT_PENDING)
        self.assertEqual(rec["exit"]["attempts"], 2)
        self.assertEqual(len(self.fx.posts), 2)
        self.fx.set_position("BTCUSDT", 0.0)
        self.tick(st)
        self.assertEqual(rec["phase"], wd.PH_FLAT_CONFIRMED)

    def test_t15_positionrisk_gagal_state_dipertahankan(self):
        self.setup_long(amt=100.0)
        self.fx.submit_results.append(("ack", "FILLED"))
        st = self.state()
        self.tick(st)
        self.assertEqual(len(self.fx.posts), 1)
        self.fx.risk_fail = True
        self.tick(st)  # tidak boleh clear state / simpulkan flat
        self.assertEqual(st["symbols"]["BTCUSDT"]["phase"], wd.PH_EXIT_PENDING)
        self.assertEqual(len(self.fx.posts), 1)
        self.fx.risk_fail = False
        self.fx.set_position("BTCUSDT", 0.0)
        self.tick(st)
        self.assertEqual(st["symbols"]["BTCUSDT"]["phase"], wd.PH_FLAT_CONFIRMED)

    def test_t16_identitas_exit_stabil_per_generasi(self):
        self.setup_long(amt=100.0)
        self.fx.submit_results.append(("timeout", False))
        st = self.state()
        self.tick(st)
        coid1 = st["symbols"]["BTCUSDT"]["exit"]["clientOrderId"]
        self.assertTrue(coid1.startswith("WDG_"))
        # generasi berbeda -> clientOrderId berbeda; deterministik utk input sama
        id_a = wd.make_exit_id("BTCUSDT", "LONG", "100", 1.0, 1)
        id_b = wd.make_exit_id("BTCUSDT", "LONG", "100", 1.0, 1)
        id_c = wd.make_exit_id("BTCUSDT", "LONG", "100", 1.0, 2)
        self.assertEqual(id_a, id_b)
        self.assertNotEqual(id_a, id_c)
        self.assertEqual(coid1, id_a)


class TestRecoveryScanGate4(Base):
    """Fix Gate 4: recovery scan tidak boleh mengadopsi order WDG_ terminal
    historis atau kandidat ambigu sebagai exit pending posisi sekarang."""

    def _legacy_scan_state(self):
        st = wd.load_state()  # file hilang -> recovery scan
        self.assertTrue(st["_recovery_scan"])
        return st

    def test_g1_filled_historis_tidak_memicu_close(self):
        # Skenario audit: FILLED dari generasi posisi sebelumnya + posisi
        # sekarang masih terbuka. Recovery TIDAK boleh mengirim MARKET close.
        self.setup_long(amt=100.0)
        self.fx.allorders["BTCUSDT"] = [{
            "clientOrderId": "WDG_old1", "orderId": 5, "status": "FILLED",
            "origQty": "100", "cumQty": "100", "side": "SELL",
            "type": "MARKET"}]
        st = self._legacy_scan_state()
        self.tick(st)  # scan tick: SKIP_TERMINAL -> MONITORING
        self.assertFalse(st["_recovery_scan"])
        rec = st["symbols"]["BTCUSDT"]
        self.assertEqual(rec["phase"], wd.PH_MONITORING)
        self.assertNotIn("exit", rec)
        self.assertEqual(len(self.fx.posts), 0)  # tidak ada close dari recovery
        # Jalur normal lanjut: exit baru HANYA dari trigger yang tidak berubah
        self.fx.submit_results.append(("ack", "FILLED"))
        self.tick(st)
        rec = st["symbols"]["BTCUSDT"]
        self.assertEqual(rec["phase"], wd.PH_EXIT_PENDING)
        self.assertEqual(rec["exit"]["reason"], "SL")
        self.assertEqual(rec["exit"]["attempts"], 1)
        self.assertEqual(len(self.fx.posts), 1)
        self.assertNotEqual(self.fx.posts[0]["newClientOrderId"], "WDG_old1")
        self.assertEqual(self.fx.posts[0]["reduceOnly"], "true")
        # FILLED historis tidak boleh memicu recovery FILLED_BUT_OPEN
        self.fx.set_position("BTCUSDT", 0.0)
        self.tick(st)
        self.assertEqual(rec["phase"], wd.PH_FLAT_CONFIRMED)
        self.assertEqual(len(self.fx.posts), 1)

    def test_g2_terminal_lainnya_tidak_diadopsi(self):
        for status in ("CANCELED", "EXPIRED", "REJECTED"):
            with self.subTest(status=status):
                self.setUp()
                self.setup_long(amt=100.0)
                self.fx.allorders["BTCUSDT"] = [{
                    "clientOrderId": "WDG_old2", "orderId": 6,
                    "status": status, "origQty": "100", "cumQty": "0",
                    "side": "SELL", "type": "MARKET"}]
                st = self._legacy_scan_state()
                self.tick(st)
                rec = st["symbols"]["BTCUSDT"]
                self.assertEqual(rec["phase"], wd.PH_MONITORING)
                self.assertNotIn("exit", rec)
                self.assertEqual(len(self.fx.posts), 0)

    def test_g3_order_aktif_konsisten_diadopsi_aman(self):
        self.setup_long(amt=100.0)
        o = {"clientOrderId": "WDG_live1", "orderId": 9, "status": "NEW",
             "origQty": "100", "cumQty": "0", "side": "SELL",
             "type": "MARKET"}
        self.fx.allorders["BTCUSDT"] = [o]
        self.fx.orders["WDG_live1"] = o
        st = self._legacy_scan_state()
        self.tick(st)
        rec = st["symbols"]["BTCUSDT"]
        self.assertEqual(rec["phase"], wd.PH_EXIT_PENDING)
        self.assertEqual(rec["exit"]["clientOrderId"], "WDG_live1")
        self.assertEqual(rec["exit"]["reason"], "RECOVERED")
        self.assertEqual(len(self.fx.posts), 0)
        self.tick(st)  # order masih aktif -> tunggu, tanpa order baru
        self.assertEqual(rec["phase"], wd.PH_EXIT_PENDING)
        self.assertEqual(len(self.fx.posts), 0)
        o["status"] = "FILLED"
        self.fx.set_position("BTCUSDT", 0.0)
        self.tick(st)
        self.assertEqual(rec["phase"], wd.PH_FLAT_CONFIRMED)
        self.assertEqual(len(self.fx.posts), 0)

    def test_g3b_partial_aktif_sisa_konsisten_diadopsi(self):
        self.setup_long(amt=40.0)
        o = {"clientOrderId": "WDG_live2", "orderId": 10,
             "status": "PARTIALLY_FILLED", "origQty": "100",
             "cumQty": "60", "side": "SELL", "type": "MARKET"}
        self.fx.allorders["BTCUSDT"] = [o]
        self.fx.orders["WDG_live2"] = o
        st = self._legacy_scan_state()
        self.tick(st)
        rec = st["symbols"]["BTCUSDT"]
        self.assertEqual(rec["phase"], wd.PH_EXIT_PENDING)
        self.assertEqual(rec["exit"]["clientOrderId"], "WDG_live2")
        self.assertEqual(rec["exit"]["remainingQty"], "40")
        self.assertEqual(len(self.fx.posts), 0)
        o["status"] = "FILLED"
        self.fx.set_position("BTCUSDT", 0.0)
        self.tick(st)
        self.assertEqual(rec["phase"], wd.PH_FLAT_CONFIRMED)
        self.assertEqual(len(self.fx.posts), 0)

    def test_g4_side_salah_ditolak_tanpa_order(self):
        # LONG butuh close SELL; order aktif BUY = kandidat asing/ambigu
        self.setup_long(amt=100.0, last=0.95)  # tidak menyentuh level
        self.fx.allorders["BTCUSDT"] = [{
            "clientOrderId": "WDG_bad1", "orderId": 11, "status": "NEW",
            "origQty": "100", "cumQty": "0", "side": "BUY",
            "type": "MARKET"}]
        st = self._legacy_scan_state()
        self.tick(st)
        rec = st["symbols"]["BTCUSDT"]
        self.assertEqual(rec["phase"], wd.PH_MONITORING)
        self.assertNotIn("exit", rec)
        for _ in range(3):
            self.tick(st)
        self.assertEqual(len(self.fx.posts), 0)

    def test_g5_qty_tidak_konsisten_tidak_diadopsi(self):
        cases = [("50", "0"), ("100", "25")]  # sisa 50 / 75 vs posisi 100
        for orig, cum in cases:
            with self.subTest(orig=orig, cum=cum):
                self.setUp()
                self.setup_long(amt=100.0, last=0.95)
                self.fx.allorders["BTCUSDT"] = [{
                    "clientOrderId": "WDG_bad2", "orderId": 12,
                    "status": "NEW", "origQty": orig, "cumQty": cum,
                    "side": "SELL", "type": "MARKET"}]
                st = self._legacy_scan_state()
                self.tick(st)
                rec = st["symbols"]["BTCUSDT"]
                self.assertEqual(rec["phase"], wd.PH_MONITORING)
                self.assertNotIn("exit", rec)
                self.tick(st)
                self.assertEqual(len(self.fx.posts), 0)

    def test_g6_tipe_ambigu_tanpa_order_otomatis(self):
        self.setup_long(amt=100.0, last=0.95)
        self.fx.allorders["BTCUSDT"] = [{
            "clientOrderId": "WDG_bad3", "orderId": 13, "status": "NEW",
            "origQty": "100", "cumQty": "0", "side": "SELL",
            "type": "LIMIT"}]
        st = self._legacy_scan_state()
        self.tick(st)
        rec = st["symbols"]["BTCUSDT"]
        self.assertEqual(rec["phase"], wd.PH_MONITORING)
        self.assertNotIn("exit", rec)
        self.tick(st)
        self.tick(st)
        self.assertEqual(len(self.fx.posts), 0)

    def test_g7_legacy_state_migrasi_lifecycle_normal(self):
        # State lama {"handled": ...} -> recovery scan -> MONITORING ->
        # trigger normal -> exit -> flat terkonfirmasi.
        self.setup_long(amt=100.0)
        with open(wd.STATE_PATH, "w", encoding="utf-8") as f:
            json.dump({"handled": {"BTCUSDT|LONG": {"at": "x"}}}, f)
        st = wd.load_state()
        self.assertTrue(st["_recovery_scan"])  # STATE_OLD_FORMAT
        self.tick(st)  # scan: tanpa WDG -> CLEAN -> MONITORING
        self.assertFalse(st["_recovery_scan"])
        self.assertEqual(st["symbols"]["BTCUSDT"]["phase"], wd.PH_MONITORING)
        self.fx.submit_results.append(("ack", "FILLED"))
        self.tick(st)  # touch -> begin_exit normal
        rec = st["symbols"]["BTCUSDT"]
        self.assertEqual(rec["phase"], wd.PH_EXIT_PENDING)
        self.assertEqual(rec["exit"]["reason"], "SL")
        self.fx.set_position("BTCUSDT", 0.0)
        self.tick(st)
        self.assertEqual(rec["phase"], wd.PH_FLAT_CONFIRMED)


class TestCandidateArbitrationCP2Final(Base):
    """CP-2 FINAL HARDENING — arbitrase kandidat ambigu (bounded, tanpa
    order bersaing, tanpa false-flat). SEMUA mock — tidak ada request live."""

    def _seed_candidate(self, st, sym="BTCUSDT", phase=None, checks=0):
        pos = {"symbol": sym, "amt": self.fx.positions[sym],
               "side": "LONG" if self.fx.positions[sym] > 0 else "SHORT",
               "entry": self.fx.entries.get(sym, 1.0),
               "mark": self.fx.entries.get(sym, 1.0)}
        st["symbols"][sym] = {
            "phase": phase if phase is not None else wd.PH_MONITORING,
            "positionId": wd.position_identity(pos),
            "gen": 0, "updatedAt": wd.now_iso(),
            "candidate": {
                "clientOrderId": self.cand_coid, "reason": "AMBIGUOUS_QTY",
                "detail": "test-seed", "checks": checks,
                "recordedAt": wd.now_iso(),
            },
        }
        return st["symbols"][sym]

    def _cand_order(self, coid, status="NEW", orig="100", cum="0", side="SELL",
                    otype="MARKET"):
        self.cand_coid = coid
        o = {"clientOrderId": coid, "orderId": 777, "status": status,
             "origQty": orig, "cumQty": cum, "side": side, "type": otype}
        self.fx.orders[coid] = o
        return o

    def setUp(self):
        super().setUp()
        self.cand_coid = "WDG_amb0"

    def test_c1_sl_tersentuh_kandidat_aktif_cancel_sukses_tanpa_bersaing(self):
        # Req: SL touched + kandidat aktif -> cancel bounded -> TANPA close
        # bersaing tick itu; close baru tick berikutnya dgn coid generasi baru.
        self.setup_long(amt=100.0)
        self._cand_order("WDG_amb1")
        wd.cancel_order = lambda sym, coid: {"canceled": True, "order": None}
        st = self.state()
        rec = self._seed_candidate(st)
        self.tick(st)  # arbitration: cancel sukses, re-fetch sisa -> hold tick ini
        self.assertEqual(len(self.fx.posts), 0)  # tidak ada order bersaing
        self.assertNotIn("candidate", rec)
        self.assertEqual(rec["phase"], wd.PH_MONITORING)
        self.fx.submit_results.append(("ack", "FILLED"))
        self.tick(st)  # trigger re-fire -> TEPAT satu close, coid baru
        self.assertEqual(len(self.fx.posts), 1)
        self.assertEqual(self.fx.posts[0]["quantity"], "100")
        self.assertNotEqual(self.fx.posts[0]["newClientOrderId"], "WDG_amb1")
        self.assertEqual(self.fx.posts[0]["reduceOnly"], "true")
        self.assertEqual(rec["phase"], wd.PH_EXIT_PENDING)
        self.assertEqual(rec["exit"]["attempts"], 1)
        self.fx.set_position("BTCUSDT", 0.0)
        self.tick(st)
        self.assertEqual(rec["phase"], wd.PH_FLAT_CONFIRMED)

    def test_c2_kandidat_jadi_terminal_saat_resolusi_trigger_jalan(self):
        self.setup_long(amt=100.0)
        self._cand_order("WDG_amb2", status="CANCELED")
        st = self.state()
        rec = self._seed_candidate(st)
        self.fx.submit_results.append(("ack", "FILLED"))
        self.tick(st)  # query -> terminal -> kandidat dibuang -> trigger jalan
        self.assertNotIn("candidate", rec)
        self.assertEqual(len(self.fx.posts), 1)
        self.assertEqual(rec["exit"]["attempts"], 1)

    def test_c3_cancel_sukses_kandidat_partial_fill_dulu_qty_ikut_sisa(self):
        # Kandidat partial fill 30 sebelum cancel -> posisi 70 -> close baru
        # MEMAKAI sisa fresh dari exchange, bukan qty lama.
        self.setup_long(amt=70.0)
        self._cand_order("WDG_amb3", status="PARTIALLY_FILLED", orig="100",
                         cum="30")
        wd.cancel_order = lambda sym, coid: {"canceled": True, "order": None}
        st = self.state()
        rec = self._seed_candidate(st)
        self.tick(st)  # cancel sukses; re-fetch posisi 70 -> hold
        self.assertEqual(len(self.fx.posts), 0)
        self.assertNotIn("candidate", rec)
        self.fx.submit_results.append(("ack", "FILLED"))
        self.tick(st)
        self.assertEqual(len(self.fx.posts), 1)
        self.assertEqual(self.fx.posts[0]["quantity"], "70")  # sisa FRESH

    def test_c4_cancel_timeout_hasil_tidak_diketahui_tanpa_order_kedua(self):
        self.setup_long(amt=100.0)
        self._cand_order("WDG_amb4")
        wd.cancel_order = lambda sym, coid: {"canceled": None, "order": None}
        st = self.state()
        rec = self._seed_candidate(st)
        self.tick(st)
        self.tick(st)  # dua tick: TIDAK ada order, TIDAK false-flat
        self.assertEqual(len(self.fx.posts), 0)
        self.assertIn("candidate", rec)
        self.assertEqual(rec["phase"], wd.PH_MONITORING)
        # Kandidat ternyata terminal -> resolusi -> close baru terkendali.
        self.fx.orders["WDG_amb4"]["status"] = "CANCELED"
        self.fx.submit_results.append(("ack", "FILLED"))
        self.tick(st)
        self.assertEqual(len(self.fx.posts), 1)
        self.assertEqual(rec["exit"]["attempts"], 1)
        self.assertEqual(rec["phase"], wd.PH_EXIT_PENDING)

    def test_c5_posisi_flat_saing_resolusi_tanpa_close_baru(self):
        # Posisi sudah flat saat kandidat dipantau pasif (DEGRADED tanpa exit)
        # -> confirm flat, TANPA close, TANPA false-flat sebaliknya.
        self.setup_long(amt=100.0)
        self._cand_order("WDG_amb5")
        st = self.state()
        rec = self._seed_candidate(st, phase=wd.PH_DEGRADED, checks=5)
        self.fx.set_position("BTCUSDT", 0.0)
        self.tick(st)  # watch pasif: snapshot fresh flat -> FLAT_CONFIRMED
        self.assertEqual(rec["phase"], wd.PH_FLAT_CONFIRMED)
        self.assertEqual(rec["closer"], "CANDIDATE_FLAT")
        self.assertEqual(len(self.fx.posts), 0)

    def test_c6_posisi_sisa_lebih_kecil_close_pakai_qty_fresh(self):
        self.setup_long(amt=60.0)
        self.fx.orders.pop("WDG_amb6", None)  # kandidat definitif absen
        self.cand_coid = "WDG_amb6"
        st = self.state()
        self._seed_candidate(st)
        self.fx.submit_results.append(("ack", "FILLED"))
        self.tick(st)  # absent -> dibuang -> trigger dgn posisi 60
        self.assertEqual(len(self.fx.posts), 1)
        self.assertEqual(self.fx.posts[0]["quantity"], "60")

    def test_c7_kandidat_side_salah_tidak_menekan_trigger(self):
        # Kandidat side/tipe salah TIDAK boleh menekan trigger monitoring.
        self.setup_long(amt=100.0)
        self._cand_order("WDG_amb7", side="BUY")  # salah utk LONG
        st = self.state()
        rec = self._seed_candidate(st)
        self.fx.submit_results.append(("ack", "FILLED"))
        self.tick(st)
        self.assertNotIn("candidate", rec)
        self.assertEqual(len(self.fx.posts), 1)
        self.assertEqual(rec["exit"]["attempts"], 1)

    def test_c8_trigger_berulang_tanpa_kandidat_tuntas_maks_satu_close(self):
        self.setup_long(amt=100.0)
        self._cand_order("WDG_amb8")
        wd.cancel_order = lambda sym, coid: {"canceled": None, "order": None}
        st = self.state()
        rec = self._seed_candidate(st)
        for _ in range(4):  # trigger berulang selama kandidat belum jelas
            self.tick(st)
            self.assertEqual(len(self.fx.posts), 0)
        # Kandidat tuntas (terminal) -> re-arm -> TEPAT satu close total.
        self.fx.orders["WDG_amb8"]["status"] = "CANCELED"
        self.fx.submit_results.append(("ack", "FILLED"))
        self.tick(st)
        self.assertEqual(len(self.fx.posts), 1)
        self.assertEqual(rec["exit"]["attempts"], 1)
        self.fx.set_position("BTCUSDT", 0.0)
        self.tick(st)
        self.assertEqual(rec["phase"], wd.PH_FLAT_CONFIRMED)
        self.assertEqual(len(self.fx.posts), 1)  # tidak ada close tambahan

    def test_c9_batas_resolusi_degraded_terlihat_tanpa_false_flat(self):
        self.setup_long(amt=100.0)
        self._cand_order("WDG_amb9")
        self.fx.query_override["WDG_amb9"] = "ambig"  # query tak terpecahkan
        st = self.state()
        rec = self._seed_candidate(st)
        for i in range(wd.CANDIDATE_MAX_CHECKS):
            self.tick(st)
        self.assertEqual(len(self.fx.posts), 0)
        self.assertEqual(rec["phase"], wd.PH_DEGRADED)
        self.assertEqual(rec.get("degradedWhy"), "CANDIDATE_UNRESOLVED")
        # Posisi TIDAK pernah dinyatakan flat.
        self.assertNotEqual(rec["phase"], wd.PH_FLAT_CONFIRMED)
        # Watch pasif jalan terus; setelah kandidat tuntas: re-arm MONITORING
        # lalu trigger (masih valid) -> TEPAT satu close dgn coid generasi baru.
        self.fx.query_override.pop("WDG_amb9")
        self.fx.orders["WDG_amb9"]["status"] = "CANCELED"
        self.fx.submit_results.append(("ack", "FILLED"))
        self.tick(st)
        self.assertEqual(len(self.fx.posts), 1)
        self.assertNotEqual(self.fx.posts[0]["newClientOrderId"], "WDG_amb9")
        # posts==1 + EXIT_PENDING membuktikan re-arm terjadi (kalau tidak,
        # guard DEGRADED di jalur trigger akan menahan close).
        self.assertEqual(rec["phase"], wd.PH_EXIT_PENDING)
        self.assertEqual(rec["exit"]["attempts"], 1)

    def test_c10_posisi_flat_dari_monitoring_tanpa_cancel_dipanggil(self):
        # Posisi sudah flat saat kandidat tercatat (fase MONITORING): snapshot
        # fresh cukup — confirm flat TANPA close dan TANPA cancel.
        self.setup_long(amt=100.0)
        self._cand_order("WDG_amb10")
        def _no_cancel(sym, coid):
            raise AssertionError("cancel tidak boleh dipanggil saat sudah flat")
        wd.cancel_order = _no_cancel
        st = self.state()
        rec = self._seed_candidate(st)
        self.fx.set_position("BTCUSDT", 0.0)
        self.tick(st)
        self.assertEqual(rec["phase"], wd.PH_FLAT_CONFIRMED)
        self.assertEqual(rec["closer"], "CANDIDATE_FLAT")
        self.assertEqual(len(self.fx.posts), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
