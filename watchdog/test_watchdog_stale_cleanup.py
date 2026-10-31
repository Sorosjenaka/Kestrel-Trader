#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""test_watchdog_stale_cleanup.py — kontrak pembersihan state MONITORING basi.

Latar: posisi yang ditutup SL/TP native (atau close manual/server) tidak pernah
masuk fase EXIT_PENDING/FLAT_CONFIRMED, sehingga record MONITORING-nya kekal,
membuat status Live STALE dan memblokir ORPHAN_SWEEP. Test ini mengunci:
  - hitungan konfirmasi flat berturut-turut,
  - syarat hapus (fase MONITORING, tanpa kandidat, hilang >= N tick),
  - larangan hapus untuk fase exit lain / saat posisi masih ada / saat kandidat
    ambigu masih dipantau.

Jalankan: python3 test_watchdog_stale_cleanup.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import watchdog_sltp as wd


def rec(phase=None, **extra):
    base = {"phase": phase or wd.PH_MONITORING, "positionId": "BTCUSDT|LONG|100.0", "gen": 0}
    base.update(extra)
    return base


class TestNextFlatMisses(unittest.TestCase):
    def test_present_selalu_reset(self):
        self.assertEqual(wd.next_flat_misses(rec(flatMisses=5), True), 0)
        self.assertEqual(wd.next_flat_misses(rec(), True), 0)

    def test_missing_menambah_konfirmasi(self):
        self.assertEqual(wd.next_flat_misses(rec(), False), 1)
        self.assertEqual(wd.next_flat_misses(rec(flatMisses=2), False), 3)


class TestShouldClearStaleMonitoring(unittest.TestCase):
    def test_hapus_setelah_ambang_terpenuhi(self):
        self.assertFalse(wd.should_clear_stale_monitoring(rec(flatMisses=2), False, confirms=3))
        self.assertTrue(wd.should_clear_stale_monitoring(rec(flatMisses=3), False, confirms=3))

    def test_posisi_masih_ada_tidak_pernah_dihapus(self):
        self.assertFalse(wd.should_clear_stale_monitoring(rec(flatMisses=99), True, confirms=3))

    def test_kandidat_ambigu_tidak_dihapus(self):
        r = rec(flatMisses=99, candidate={"reason": "SL", "checks": 1})
        self.assertFalse(wd.should_clear_stale_monitoring(r, False, confirms=3))

    def test_fase_exit_lain_punya_jalur_sendiri(self):
        for phase in (wd.PH_EXIT_PENDING, wd.PH_DEGRADED, wd.PH_FLAT_CONFIRMED):
            self.assertFalse(
                wd.should_clear_stale_monitoring(rec(phase=phase, flatMisses=99), False, confirms=3),
                phase,
            )

    def test_ambang_default_dari_config(self):
        # Default produksi 3 tick; jangan pernah 0/negatif (hapus terlalu cepat).
        self.assertGreaterEqual(wd.FLAT_CLEANUP_CONFIRMS, 1)
        r = rec(flatMisses=wd.FLAT_CLEANUP_CONFIRMS)
        self.assertTrue(wd.should_clear_stale_monitoring(r, False))


class TestSequenceSimulation(unittest.TestCase):
    """Simulasi reconcile 5 tick: 3x hilang -> record dihapus, tidak kembali."""

    def test_tiga_tick_hilang_lalu_bersih(self):
        state = {"symbols": {"BTCUSDT": rec()}}
        cleared_at = None
        for tick_no in range(1, 6):
            r = state["symbols"].get("BTCUSDT")
            if r is None:
                continue
            r["flatMisses"] = wd.next_flat_misses(r, False)
            if wd.should_clear_stale_monitoring(r, False):
                del state["symbols"]["BTCUSDT"]
                cleared_at = tick_no
        self.assertEqual(cleared_at, 3)
        self.assertEqual(state["symbols"], {})

    def test_hilang_dua_tick_lalu_posisi_kembali_tidak_dihapus(self):
        state = {"symbols": {"BTCUSDT": rec()}}
        for _ in range(2):
            r = state["symbols"]["BTCUSDT"]
            r["flatMisses"] = wd.next_flat_misses(r, False)
        # tick ke-3: posisi terlihat lagi -> reset, state dipertahankan
        r = state["symbols"]["BTCUSDT"]
        r["flatMisses"] = wd.next_flat_misses(r, True)
        self.assertFalse(wd.should_clear_stale_monitoring(r, True))
        self.assertEqual(r["flatMisses"], 0)
        self.assertIn("BTCUSDT", state["symbols"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
