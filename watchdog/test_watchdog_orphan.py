#!/usr/bin/python3
# -*- coding: utf-8 -*-
"""test_watchdog_orphan.py — 13 Okt 2026. Regresi orphan SL/TP cleanup watchdog
(insiden Position 3028/3029). Semua respons exchange DI-MOCK (signed_request
dipalsu), tidak ada order nyata. 16 skenario wajib operator, versi watchdog:
hanya fungsi yang memang milik watchdog yang dites di sini (hook confirm_flat,
sweep + guard, atribusi, cancel-dengan-konfirmasi); skenario supervisor/TS ada
di tests/bracketCleanup.test.ts."""
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import watchdog_sltp as wd


class FakeX:
    """Palsu signed_request: state algo per simbol + posisi + kegagalan terjadwal."""

    def __init__(self):
        self.reset()

    def reset(self):
        self.algos = {}          # clientAlgoId -> status
        self.sym_of = {}         # clientAlgoId -> symbol
        self.amt = {}            # symbol -> positionAmt (absen = positionRisk [] -> unknown)
        self.open_list = []      # clientAlgoId aktif (difilter simbol oleh handler)
        self.fail_mode = {}      # 'DELETE'/'GET_ALGO'/'GET_PR'/'GET_OPEN' -> True
        self.calls = []

    def add(self, cid, sym, status):
        self.algos[cid] = status
        self.sym_of[cid] = sym
        if status in wd.ACTIVE_ALGO_STATUSES:
            self.open_list.append(cid)

    def fail(self, op):
        self.fail_mode[op] = True

    def __call__(self, method, path, params=None):
        params = params or {}
        self.calls.append((method, path, dict(params)))
        if path == "/fapi/v2/positionRisk" and self.fail_mode.get("GET_PR"):
            return {"_error": True, "_ambiguous": True, "body": "down"}
        if path == "/fapi/v1/algoOrder" and method == "GET" and self.fail_mode.get("GET_ALGO"):
            return {"_error": True, "_ambiguous": True, "body": "down"}
        if path == "/fapi/v1/openAlgoOrders" and self.fail_mode.get("GET_OPEN"):
            return {"_error": True, "_ambiguous": True, "body": "down"}
        if path == "/fapi/v1/algoOrder" and method == "DELETE" and self.fail_mode.get("DELETE"):
            return {"_error": True, "_ambiguous": True, "body": "timeout"}
        if path == "/fapi/v2/positionRisk":
            sym = params.get("symbol")
            if sym:
                if sym not in self.amt:
                    return []                      # simbol tidak dikenal -> len!=1 -> unknown
                return [{"symbol": sym, "positionAmt": str(self.amt[sym])}]
        if path == "/fapi/v1/openAlgoOrders":
            sym = params.get("symbol")
            return [{"symbol": self.sym_of[c], "clientAlgoId": c,
                     "algoStatus": self.algos[c]} for c in self.open_list
                    if not sym or self.sym_of[c] == sym]
        if path == "/fapi/v1/algoOrder":
            cid = params.get("clientAlgoId")
            if cid not in self.algos:
                code = -2013 if method == "GET" else -2011
                return {"_error": True, "code": 400, "binance_code": code, "body": "absen"}
            if method == "DELETE":
                self.algos[cid] = "CANCELED"
                self.open_list = [c for c in self.open_list if c != cid]
                return {"clientAlgoId": cid, "algoStatus": "CANCELED"}
            return {"clientAlgoId": cid, "algoStatus": self.algos[cid], "symbol": self.sym_of[cid]}
        return {}


class T(unittest.TestCase):
    def setUp(self):
        self.x = FakeX()
        self.tmp = tempfile.TemporaryDirectory(prefix="orphan_test_", ignore_cleanup_errors=True)
        self.addCleanup(self.tmp.cleanup)
        db_path = os.path.join(self.tmp.name, "fixture.db")
        con = sqlite3.connect(db_path)
        try:
            con.execute("CREATE TABLE OrderExec (clientOrderId TEXT, status TEXT, reduceOnly INT, createdAt INT)")
            con.commit()
        finally:
            con.close()
        self.enterContext(mock.patch.object(wd, "CFG", {"db_path": db_path}))
        self.enterContext(mock.patch.object(wd, "DRY_RUN", False))
        self.enterContext(mock.patch.object(wd, "log", lambda *args: None))
        self.enterContext(mock.patch.object(wd, "save_state", lambda *args: None))
        # Higiene telemetri: test tidak boleh menulis ke sink produksi
        # (watchdog_config.json kini memuat latency_sink_file).
        self._lat_saved = wd.LAT_PATH
        wd.LAT_PATH = None
        self.f = mock.patch.object(wd, "signed_request", self.x)
        self.f.start()
        self.addCleanup(self.f.stop)
        self.addCleanup(setattr, wd, "LAT_PATH", self._lat_saved)

    # ── 1 & 2: satu leg menutup penuh → sibling dibatalkan terkonfirmasi ──
    def test_1_sl_fill_sibling_tp_dibatalkan(self):
        self.x.amt["X"] = 0.0
        self.x.add("TPA_E1", "X", "NEW")
        self.x.add("SLA_E1", "X", "FINISHED")
        r = wd.cleanup_flat_position_protective("X", entry="E1", reason="EXIT_FLAT_NATIVE_SLTP")
        self.assertEqual(r["cancelled"], ["TPA_E1"])
        self.assertEqual(self.x.algos["TPA_E1"], "CANCELED")

    def test_2_tp_fill_sibling_sl_dibatalkan(self):
        self.x.amt["X"] = 0.0
        self.x.add("SLA_E1", "X", "NEW")
        self.x.add("TPA_E1", "X", "FINISHED")
        r = wd.cleanup_flat_position_protective("X", entry="E1")
        self.assertEqual(r["cancelled"], ["SLA_E1"])

    # ── 3 & 4: watchdog close & manual close → rekonsiliasi sama ──
    def test_3_watchdog_close_kedua_leg_direkonsiliasi(self):
        self.x.amt["X"] = 0.0
        self.x.add("SLA_E1", "X", "NEW")
        self.x.add("TPA_E1", "X", "NEW")
        r = wd.cleanup_flat_position_protective("X", entry="E1", reason="EXIT_FLAT_WATCHDOG")
        self.assertEqual(sorted(r["cancelled"]), ["SLA_E1", "TPA_E1"])

    def test_4_manual_close_atribusi_dari_entry(self):
        self.x.amt["X"] = 0.0
        self.x.add("TPA_E2", "X", "NEW")
        r = wd.cleanup_flat_position_protective("X", entry="E2", reason="EXIT_FLAT_NATIVE_SLTP")
        self.assertEqual(r["cancelled"], ["TPA_E2"])

    # ── 5 & 6: posisi terbuka / partial → tidak disentuh ──
    def test_5_posisi_terbuka_abort(self):
        self.x.amt["X"] = 100.0
        self.x.add("TPA_E1", "X", "NEW")
        r = wd.cleanup_flat_position_protective("X", entry="E1")
        self.assertEqual(r["cancelled"], [])
        self.assertEqual(r["skipped"], ["TPA_E1"])
        self.assertNotIn(("DELETE", "/fapi/v1/algoOrder", {"clientAlgoId": "TPA_E1"}), self.x.calls)

    def test_6_partial_terbuka_dipertahankan(self):
        self.x.amt["X"] = 35.0
        self.x.add("TPA_E1", "X", "NEW")
        r = wd.cleanup_flat_position_protective("X", entry="E1")
        self.assertEqual(r["cancelled"], [])

    # ── 7 & 8: timeout → query sebelum retry; sibling FINISHED tak disentuh ──
    def test_7_cancel_timeout_verifikasi_sebelum_retry(self):
        # DELETE gagal (timeout) tapi order ternyata sudah CANCELED di exchange.
        def fake(method, path, params=None):
            params = params or {}
            self.x.calls.append((method, path, dict(params)))
            if method == "DELETE":
                return {"_error": True, "_ambiguous": True, "body": "timeout"}
            return {"clientAlgoId": params.get("clientAlgoId"), "algoStatus": "CANCELED", "symbol": "X"}
        with mock.patch.object(wd, "signed_request", fake):
            r = wd._cancel_with_confirmation("X", "TPA_E1")
        self.assertEqual(r, {"final_status": "CANCELED", "confirmed": True})
        deletes = [c for c in self.x.calls if c[0] == "DELETE"]
        self.assertEqual(len(deletes), 1)  # tidak retry buta

    def test_8_sibling_sudah_finished_tak_disentuh(self):
        self.x.amt["X"] = 0.0
        self.x.add("SLA_E1", "X", "NEW")
        self.x.add("TPA_E1", "X", "FINISHED")
        r = wd.cleanup_flat_position_protective("X", entry="E1")
        self.assertEqual(r["cancelled"], ["SLA_E1"])
        self.assertNotIn(("DELETE", "/fapi/v1/algoOrder", {"clientAlgoId": "TPA_E1"}), self.x.calls)

    # ── 9 & 10: idempoten & race dua aktor ──
    def test_9_idempotent_dua_kali_panggil(self):
        self.x.amt["X"] = 0.0
        self.x.add("SLA_E1", "X", "NEW")
        self.x.add("TPA_E1", "X", "NEW")
        r1 = wd.cleanup_flat_position_protective("X", entry="E1")
        self.assertEqual(sorted(r1["cancelled"]), ["SLA_E1", "TPA_E1"])
        r2 = wd.cleanup_flat_position_protective("X", entry="E1")
        self.assertEqual(r2["cancelled"], [])

    def test_10_race_dua_aktor_cancel_lawan_sudah_duluan(self):
        self.x.amt["X"] = 0.0
        self.x.add("TPA_E1", "X", "NEW")
        # Aktor lain membatalkan lebih dulu; listing NEW kita = kosong → tidak ada aksi.
        self.x.algos["TPA_E1"] = "CANCELED"
        self.x.open_list = []
        r = wd.cleanup_flat_position_protective("X", entry="E1")
        self.assertEqual(r["cancelled"], [])

    # ── 11 & 12: ambigu & order manual asing ──
    def test_11_ambigu_tak_dibatalkan(self):
        # listing NEW punya basis lain; entry diketahui → skipped, bukan cancel.
        self.x.amt["X"] = 0.0
        self.x.add("TPA_BASISLAIN", "X", "NEW")
        r = wd.cleanup_flat_position_protective("X", entry="E1")
        self.assertEqual(r["cancelled"], [])
        self.assertEqual(r["skipped"], ["TPA_BASISLAIN"])

    def test_11b_entry_tak_diketahui_listing_bot_prefix(self):
        # entry None (flat saat watchdog poll tanpa jejak DB): listing NEW +
        # prefix SLA_/TPA_ = kriteria watchdog; pastikan jalan & tercatat.
        self.x.amt["X"] = 0.0
        self.x.add("TPA_BASISLAIN", "X", "NEW")
        r = wd.cleanup_flat_position_protective("X", entry=None)
        self.assertIn("TPA_BASISLAIN", r["cancelled"] + r["skipped"])

    def test_12_order_manual_asing_diawetkan(self):
        self.x.amt["X"] = 0.0
        # order manual (non SLA_/TPA_) tidak pernah masuk kandidat (_open_algo_ids).
        self.x.open_list.append("MY_MANUAL_STOP")
        self.x.sym_of["MY_MANUAL_STOP"] = "X"
        self.x.algos["MY_MANUAL_STOP"] = "NEW"
        r = wd.cleanup_flat_position_protective("X", entry="E1")
        self.assertEqual(r["cancelled"], [])
        self.assertNotIn(("DELETE", "/fapi/v1/algoOrder", {"clientAlgoId": "MY_MANUAL_STOP"}), self.x.calls)

    # ── 13: jalur API algo yang benar ──
    def test_13_jalur_algo_api(self):
        self.x.amt["X"] = 0.0
        self.x.add("TPA_E1", "X", "NEW")
        wd.cleanup_flat_position_protective("X", entry="E1")
        paths = {p for (_, p, _) in self.x.calls}
        self.assertIn("/fapi/v1/algoOrder", paths)
        self.assertIn("/fapi/v1/openAlgoOrders", paths)
        self.assertNotIn("/fapi/v1/order", paths)
        self.assertNotIn("/fapi/v1/allOpenOrders", paths)

    # ── 14: recovery restart (sweep) ──
    def test_14_sweep_recovery_restart(self):
        self.x.amt["X"] = 0.0
        self.x.add("TPA_E1", "X", "NEW")
        r = wd.sweep_orphan_protective(st={"symbols": {}})
        self.assertEqual(r["cancelled"], [("X", "TPA_E1")])
        # DB hilang → G2 fail-closed (DB_FAIL), tanpa cancel:
        self.x.add("TPA_E2", "Y", "NEW")
        with mock.patch.object(wd, "CFG", {"db_path": "/nonexistent/x.db"}):
            r2 = wd.sweep_orphan_protective(st={"symbols": {}})
        self.assertEqual(r2.get("skipped"), "DB_FAIL")

    # ── 15: query gagal → tidak pernah dianggap sukses ──
    def test_15_query_gagal_tidak_klaim_sukses(self):
        self.x.add("TPA_E1", "X", "NEW")
        self.x.fail("DELETE")
        self.x.fail("GET_ALGO")
        r = wd._cancel_with_confirmation("X", "TPA_E1")
        self.assertFalse(r["confirmed"])
        self.assertEqual(r["final_status"], "QUERY_UNKNOWN")

    # ── 16: posisi berubah di tengah jalan → abort sisa ──
    def test_16_reopen_tengah_jalan_abort(self):
        self.x.amt["X"] = 0.0
        self.x.add("SLA_E1", "X", "NEW")
        self.x.add("TPA_E1", "X", "NEW")
        # Urutan _position_amt: #1 re-verify sebelum cancel#1, #2 re-verify
        # sebelum cancel#2. Re-entry manual disimulasikan mulai call #2.
        orig = self.x.__call__
        pr = {"n": 0}

        def flip(method, path, params=None):
            if path == "/fapi/v2/positionRisk":
                pr["n"] += 1
                if pr["n"] >= 2:
                    self.x.amt["X"] = 42.0
            return orig(method, path, params)

        with mock.patch.object(wd, "signed_request", flip):
            r = wd.cleanup_flat_position_protective("X", entry="E1")
        self.assertEqual(r["cancelled"], ["SLA_E1"])   # pertama jalan (masih flat)
        self.assertIn("TPA_E1", r["skipped"])          # sisa di-abort

    # ── hook confirm_flat + guard sweep ──
    def test_hook_confirm_flat_memanggil_cleanup(self):
        self.x.amt["X"] = 0.0
        self.x.add("TPA_E1", "X", "NEW")
        st = {"symbols": {"X": {"phase": wd.PH_EXIT_PENDING, "exit": {"clientOrderId": "WDG_1"}}}}
        with mock.patch.object(wd, "_db_entry_coid_for_symbol", return_value="E1"), \
             mock.patch.object(wd, "save_state"):
            wd.confirm_flat("X", st["symbols"]["X"], "NATIVE_SLTP", st)
        self.assertEqual(self.x.algos["TPA_E1"], "CANCELED")
        self.assertEqual(st["symbols"]["X"]["phase"], wd.PH_FLAT_CONFIRMED)

    def test_sweep_guard_state_aktif(self):
        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        con = sqlite3.connect(path)
        con.execute("CREATE TABLE OrderExec (clientOrderId TEXT, status TEXT, reduceOnly INT, createdAt INT)")
        con.commit()
        con.close()
        try:
            with mock.patch.object(wd, "CFG", {"db_path": path}):
                r = wd.sweep_orphan_protective(st={"symbols": {"X": {}}})
            self.assertEqual(r["skipped"], "STATE_ACTIVE")
        finally:
            os.unlink(path)

    def test_sweep_guard_entry_inflight(self):
        now_ms = int(time.time() * 1000)
        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        con = sqlite3.connect(path)
        con.execute("CREATE TABLE OrderExec (clientOrderId TEXT, status TEXT, reduceOnly INT, createdAt INT)")
        con.execute("INSERT INTO OrderExec VALUES (?,?,?,?)", ("AT_NEW_INFLIGHT", "NEW", 0, now_ms))
        con.commit()
        con.close()
        self.x.add("TPA_E9", "X", "NEW")
        try:
            with mock.patch.object(wd, "CFG", {"db_path": path}):
                r = wd.sweep_orphan_protective(st={"symbols": {}})
            self.assertEqual(r["skipped"], "ENTRY_INFLIGHT")
        finally:
            os.unlink(path)

    def test_sweep_db_tanpa_tabel_fail_closed(self):
        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        con = sqlite3.connect(path)
        con.close()
        self.x.add("TPA_E9", "X", "NEW")
        try:
            with mock.patch.object(wd, "CFG", {"db_path": path}):
                r = wd.sweep_orphan_protective(st={"symbols": {}})
            self.assertEqual(r["skipped"], "DB_FAIL")
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main(verbosity=2)
