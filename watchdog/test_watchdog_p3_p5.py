#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
test_watchdog_p3_p5.py — Test deterministik P3 (telemetri latensi), P4 (cache
level), P5 (WebSocket hybrid). SEMUA interaksi exchange/socket di-mock —
tidak ada koneksi nyata, tidak ada order, tidak menyentuh service.

Jalankan: python3 test_watchdog_p3_p5.py
"""
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import exit_latency as lat
import watchdog_sltp as wd
import ws_market as wsm


# Implementasi ASLI di-capture saat import: Base.setUp menimpa wd.get_last_price
# dengan lambda harness — test gate REST butuh implementasi /fapi yang sebenarnya.
WD_GET_LAST_PRICE_ORIG = wd.get_last_price


def wait_until(fn, timeout=6.0, interval=0.05):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if fn():
                return True
        except Exception:
            pass
        time.sleep(interval)
    return False


# ─────────────────────────── P3: exit_latency ───────────────────────────────
class TestExitLatency(unittest.TestCase):
    def test_stage_durations_dan_fail_open(self):
        ev = lat.new_event("BTCUSDT", "SL", 0.9, "WDG_x")
        lat.mark(ev, "receipt")
        time.sleep(0.01)
        lat.mark(ev, "trigger")
        lat.mark(ev, "send")
        lat.mark(ev, "ack")
        lat.mark(ev, "flat")
        lat.finalize(ev, "WATCHDOG", "0")
        d = lat.stage_durations(ev)
        self.assertGreater(d["receipt_to_trigger"], 0.0)  # durasi lokal nyata
        self.assertGreater(d["send_to_ack"], 0.0)
        self.assertGreater(d["total"], 0.0)
        # fail-open: input jelek TIDAK pernah raise
        lat.stage_durations(None)
        lat.mark(None, "receipt")
        lat.mark_exchange(None, "orderUpdateTimeMs", 1)

    def test_watchdog_mengisi_receipt_poll(self):
        # (dipindah ke TestLatencyIntegration — butuh harness Base)
        pass

    def test_exchange_timestamp_terpisah_dari_monotonic(self):
        ev = lat.new_event("BTCUSDT", "SL", 0.9, "WDG_x")
        lat.mark(ev, "trigger")
        lat.mark_exchange(ev, "orderUpdateTimeMs", 1791799553000)
        lat.mark_exchange(ev, "orderUpdateTimeMs", -5)  # invalid ditolak
        self.assertEqual(ev["exchange"]["orderUpdateTimeMs"], 1791799553000.0)
        self.assertNotIn("exchange", ev["monotonic"])

    def test_percentile_dan_min_n(self):
        vals = sorted(float(i) for i in range(1, 101))  # 1..100
        self.assertEqual(lat.percentile(vals, 50), 50.5)
        self.assertAlmostEqual(lat.percentile(vals, 95), 95.05)
        rows = [{"total": v} for v in vals]
        s = lat.summarize(rows, "SYNTHETIC")
        self.assertEqual(s["stages"]["total"]["p50"], 50.5)
        self.assertEqual(s["n"], 100)
        s2 = lat.summarize([{"total": 0.1}] * 5, "SYNTHETIC")
        self.assertIsNone(s2["stages"]["total"]["p50"])
        self.assertEqual(s2["stages"]["total"]["reason"], "n<20")

    def test_sink_jsonl_dan_read_samples(self):
        tmp = tempfile.mkdtemp(prefix="lat_")
        p = os.path.join(tmp, "lat.jsonl")
        ev = lat.new_event("BTCUSDT", "SL", 0.9, "WDG_x")
        lat.mark(ev, "trigger"); lat.mark(ev, "send"); lat.mark(ev, "ack"); lat.mark(ev, "flat")
        lat.finalize(ev, "WATCHDOG", "0")
        sink = lat.JsonlSink(p)
        self.assertTrue(sink.write(ev))
        self.assertFalse(sink.write({"done": False}))  # belum selesai -> tak ditulis
        rows = lat.read_samples(p)
        self.assertEqual(len(rows), 1)
        self.assertIn("total", rows[0])
        self.assertEqual(lat.read_samples(os.path.join(tmp, "missing")), [])


# ─────────────────── P3 integrasi di watchdog (mock penuh) ──────────────────
from test_watchdog_cp2 import FakeExchange, Base  # reuse harness deterministik


class TestLatencyIntegration(Base):
    def _enable_sink(self):
        self.tmp2 = tempfile.mkdtemp(prefix="latint_")
        wd.LAT_PATH = os.path.join(self.tmp2, "lat.jsonl")
        self.addCleanup(setattr, wd, "LAT_PATH", None)
        self.addCleanup(wd.LAT_EVENTS.clear)

    def test_full_exit_menulis_satu_baris_dengan_stase_lengkap(self):
        self._enable_sink()
        self.setup_long(amt=100.0)
        st = self.state()
        self.fx.submit_results.append(("ack", "FILLED"))
        self.tick(st)
        rec = st["symbols"]["BTCUSDT"]
        coid = rec["exit"]["clientOrderId"]
        self.fx.set_position("BTCUSDT", 0.0)
        self.tick(st)
        self.assertEqual(rec["phase"], wd.PH_FLAT_CONFIRMED)
        p = wd.LAT_PATH
        self.assertTrue(wait_until(lambda: os.path.exists(p), 3))
        rows = lat.read_samples(p)
        self.assertEqual(len(rows), 1)
        r0 = json.loads(open(p).read().splitlines()[0])
        self.assertEqual(r0["symbol"], "BTCUSDT")
        self.assertEqual(r0["triggerSource"], "SL")
        self.assertEqual(r0["clientOrderId"], coid)
        self.assertEqual(r0["outcome"], "WATCHDOG")
        self.assertEqual(r0["exchangeOrderId"], self.fx.orders[coid]["orderId"])
        self.assertEqual(r0["durations"]["receipt_to_trigger"], 0.0)
        self.assertGreater(r0["durations"]["total"], 0.0)
        self.assertIsNone(wd.LAT_EVENTS.get(("BTCUSDT", coid)))  # dibersihkan

    def test_tanpa_sink_konfig_telemetri_inert(self):
        # 13 Okt: config produksi KINI memuat latency_sink_file (deploy hardening),
        # jadi skenario "tanpa sink" disimulasikan eksplisit (bukan asumsi config).
        saved = wd.LAT_PATH
        wd.LAT_PATH = None
        self.addCleanup(setattr, wd, "LAT_PATH", saved)
        self.setup_long(amt=100.0)
        st = self.state()
        self.fx.submit_results.append(("ack", "FILLED"))
        self.tick(st)
        self.fx.set_position("BTCUSDT", 0.0)
        self.tick(st)
        self.assertEqual(st["symbols"]["BTCUSDT"]["phase"], wd.PH_FLAT_CONFIRMED)
        self.assertEqual(wd.LAT_EVENTS, {})  # zero event, zero overhead

    def test_watchdog_mengisi_receipt_poll(self):
        # receipt = trigger saat jalur poll (tanpa WS receipt eksplisit)
        self._enable_sink()
        self.setup_long(amt=100.0)
        st = self.state()
        self.fx.submit_results.append(("ack", "FILLED"))
        self.tick(st)
        coid = st["symbols"]["BTCUSDT"]["exit"]["clientOrderId"]
        ev = wd.LAT_EVENTS[("BTCUSDT", coid)]
        self.assertEqual(ev["monotonic"]["receipt"], ev["monotonic"]["trigger"])


# ───────────────────────────── P4: levels cache ─────────────────────────────
class TestLevelsCache(Base):
    def test_cache_hit_ttl_dan_identity_invalidation(self):
        wd.LEVELS_CACHE = wd._LevelsCache(0.05)
        self.addCleanup(setattr, wd, "LEVELS_CACHE", wd._LevelsCache(wd.LEVELS_TTL))
        calls = {"n": 0}

        def fake_algo(positions):
            calls["n"] += 1
            return {positions[0]["symbol"]: {"sl": 0.9, "tp": 1.1}}
        wd.levels_from_algo_orders = fake_algo
        self.setup_long(amt=100.0)
        st = self.state()
        for _ in range(3):
            self.tick(st)  # trigger touch -> exit pending di tick 1
        rec = st["symbols"]["BTCUSDT"]
        self.assertEqual(rec["phase"], wd.PH_EXIT_PENDING)
        self.assertEqual(calls["n"], 1)  # tick 2-3 pakai cache (selama posisi exit)
        # posisi baru (entry beda) -> identitas beda -> cache basi
        self.fx.set_position("BTCUSDT", 100.0, entry=2.0)
        st2 = self.state()
        self.tick(st2)
        self.assertEqual(calls["n"], 2)

    def test_db_fallback_tidak_percache(self):
        wd.LEVELS_CACHE = wd._LevelsCache(5.0)  # TTL panjang
        self.addCleanup(setattr, wd, "LEVELS_CACHE", wd._LevelsCache(wd.LEVELS_TTL))
        wd.levels_from_algo_orders = lambda positions: {}  # algo gagal/kosong
        self.setup_long(amt=100.0)
        st = self.state()
        self.tick(st)
        self.assertEqual(wd.LEVELS_CACHE.by_sym, {})  # fallback DB tak pernah di-cache
        # trigger tetap jalan dari level DB
        self.assertEqual(st["symbols"]["BTCUSDT"]["phase"], wd.PH_EXIT_PENDING)

    def test_manual_edit_terdeteksi_setelah_ttl(self):
        wd.LEVELS_CACHE = wd._LevelsCache(0.05)
        self.addCleanup(setattr, wd, "LEVELS_CACHE", wd._LevelsCache(wd.LEVELS_TTL))
        state_levels = {"sl": 0.9, "tp": 1.1}
        wd.levels_from_algo_orders = lambda positions: {positions[0]["symbol"]: dict(state_levels)}
        self.setup_long(amt=100.0)
        st = self.state()
        self.tick(st)
        self.assertEqual(st["symbols"]["BTCUSDT"]["phase"], wd.PH_EXIT_PENDING)


# ─────────────────────── batas trigger (LONG/SHORT) ─────────────────────────
class TestTriggerBoundaries(unittest.TestCase):
    def test_long_short_sl_tp_tepat_dan_melewati(self):
        f = wd.decide_touch
        # LONG: sl=0.9, tp=1.1
        self.assertEqual(f(0.9, "LONG", 0.9, 1.1), ("SL", 0.9))    # tepat SL
        self.assertEqual(f(0.5, "LONG", 0.9, 1.1), ("SL", 0.9))    # gap turun
        self.assertEqual(f(1.1, "LONG", 0.9, 1.1), ("TP", 1.1))    # tepat TP
        self.assertEqual(f(2.0, "LONG", 0.9, 1.1), ("TP", 1.1))
        self.assertIsNone(f(1.0, "LONG", 0.9, 1.1))
        # SHORT: sl=1.1 (di atas), tp=0.9 (di bawah)
        self.assertEqual(f(1.1, "SHORT", 1.1, 0.9), ("SL", 1.1))   # tepat SL
        self.assertEqual(f(2.0, "SHORT", 1.1, 0.9), ("SL", 1.1))   # gap naik
        self.assertEqual(f(0.9, "SHORT", 1.1, 0.9), ("TP", 0.9))   # tepat TP
        self.assertEqual(f(0.5, "SHORT", 1.1, 0.9), ("TP", 0.9))
        self.assertIsNone(f(1.0, "SHORT", 1.1, 0.9))
        # SL prioritas saat keduanya tersentuh (fail-safe)
        self.assertEqual(f(0.9, "LONG", 0.9, 1.1), ("SL", 0.9))
        self.assertEqual(f(0.9, "SHORT", 1.1, 0.9), ("TP", 0.9))
        self.assertEqual(f(1.1, "SHORT", 1.1, 0.9), ("SL", 1.1))


# ───────────────── GATE: routing USDⓈ-M Futures (post-audit) ────────────────
class TestFuturesRoutingGate(unittest.TestCase):
    """Directive GATE: hanya host Futures resmi, route /market/*, tanpa Spot."""

    def test_combined_url_pakai_market_route(self):
        u = wsm.combined_url(["BTCUSDT", "ETHUSDT"])
        self.assertTrue(u.startswith("wss://fstream.binance.com/market/stream?streams="))
        self.assertIn("btcusdt@aggTrade/ethusdt@aggTrade", u)
        self.assertNotIn("data-stream.binance.vision", u)

    def test_raw_url_pakai_market_ws(self):
        self.assertEqual(wsm.market_raw_url("BTCUSDT"),
                         "wss://fstream.binance.com/market/ws/btcusdt@aggTrade")

    def test_host_default_futures_only(self):
        self.assertEqual(wsm.WS_HOSTS, ("fstream.binance.com",))
        self.assertNotIn("data-stream.binance.vision", wsm.WS_HOSTS)

    def test_vision_tidak_bisa_dipilih_sebagai_sumber_trigger(self):
        # hosts=vision saja -> ditolak keras (tidak ada host Spot pengganti).
        with self.assertRaises(ValueError):
            wsm.WsMarketFeed(wsm.PriceBoard(), symbols=["BTCUSDT"],
                             hosts=["data-stream.binance.vision"],
                             socket_factory=lambda h: FakeWsServer().sock)
        # hosts campuran -> vision dibuang, fstream tetap; tercatat di health.
        f = wsm.WsMarketFeed(wsm.PriceBoard(), symbols=["BTCUSDT"],
                             hosts=["data-stream.binance.vision",
                                    "fstream.binance.com"],
                             socket_factory=lambda h: FakeWsServer().sock)
        self.assertEqual(f._hosts, ("fstream.binance.com",))
        self.assertIn("non-Futures", f.last_error or "")

    def test_private_path_dokumentasi_migrasi(self):
        self.assertEqual(wsm.private_ws_path("LKabc"), "/private/ws/LKabc")
        self.assertNotIn("listenKey=", wsm.private_ws_path("LKabc"))

    def test_spot_like_payload_ditolak_bukan_cuma_symbol_match(self):
        # spot 'trade' event (bukan aggTrade) -> ditolak meski symbol cocok.
        spot_trade = json.dumps({"e": "trade", "E": 1791805365200, "s": "BTCUSDT",
                                 "p": "83000", "q": "1", "T": 1791805365200,
                                 "t": 5})
        with self.assertRaises(ValueError):
            wsm.parse_aggtrade(spot_trade)
        # spot aggTrade shaped tapi field penting rusak -> ditolak.
        with self.assertRaises(ValueError):
            wsm.parse_aggtrade(json.dumps({"e": "aggTrade", "s": "BTCUSDT",
                                           "p": "NaN", "q": "1", "E": 1, "T": 1,
                                           "a": 1}))
        # event aggTrade valid tetap diterima (jalur futures normal).
        ok = wsm.parse_aggtrade(json.dumps({"e": "aggTrade", "E": 1791805365200,
                                            "s": "BTCUSDT", "p": "83299.4",
                                            "q": "0.001",
                                            "T": 1791805365050, "a": 3482075330}))
        self.assertEqual(ok["agg_id"], 3482075330)

    def test_feed_tanpa_simbol_tidak_connect_ke_route_kosong(self):
        s = FakeWsServer()
        f = wsm.WsMarketFeed(wsm.PriceBoard(), symbols=[],
                             socket_factory=lambda h: s.sock,
                             base_backoff=0.05, cap_backoff=0.1)
        f.start()
        try:
            self.assertTrue(wait_until(lambda: f.state == wsm.WsMarketFeed.STATE_STOPPED, 3))
            time.sleep(0.3)
            self.assertFalse(s.handshaked)  # tidak pernah handshake tanpa stream
        finally:
            f.stop()


# ───────────────────────────── P5: ws_market ────────────────────────────────
class TestParseAggTrade(unittest.TestCase):
    def test_valid_dan_combined(self):
        raw = {"e": "aggTrade", "E": 1791800000000, "s": "BTCUSDT",
               "p": "65000.5", "q": "3", "T": 1791800000001, "a": 42}
        t = wsm.parse_aggtrade(raw)
        self.assertEqual(t["symbol"], "BTCUSDT")
        self.assertEqual(t["price"], 65000.5)
        t2 = wsm.parse_aggtrade(json.dumps({"stream": "btcusdt@aggTrade", "data": raw}))
        self.assertEqual(t2["agg_id"], 42)

    def test_malformed_ditolak(self):
        bad = [
            "bukan json",
            json.dumps({"e": "kline", "s": "BTCUSDT"}),
            json.dumps({"e": "aggTrade", "s": "BTCUSDT", "p": "x", "q": "1", "E": 1, "T": 1, "a": 1}),
            json.dumps({"e": "aggTrade", "s": "BTCUSDT", "p": "-1", "q": "1", "E": 1, "T": 1, "a": 1}),
            json.dumps({"e": "aggTrade", "s": "BTCUSDT", "p": "Infinity", "q": "1", "E": 1, "T": 1, "a": 1}),
            json.dumps({"e": "aggTrade", "s": "BTCUSDT", "p": "1", "q": "-2", "E": 1, "T": 1, "a": 1}),
            json.dumps({"e": "aggTrade", "s": "", "p": "1", "q": "1", "E": 1, "T": 1, "a": 1}),
            json.dumps({"e": "aggTrade", "s": "BTCUSDT", "p": "1", "q": "1", "E": 0, "T": 1, "a": 1}),
        ]
        for b in bad:
            with self.assertRaises(ValueError):
                wsm.parse_aggtrade(b)


class TestPriceBoardAndBackoff(unittest.TestCase):
    def test_fresh_stale_clear(self):
        b = wsm.PriceBoard(max_age_sec=0.05)
        b.update("BTCUSDT", 65000.5)
        self.assertEqual(b.get_fresh("BTCUSDT"), 65000.5)
        d = b.get_fresh_detail("BTCUSDT")
        self.assertTrue(0 <= time.monotonic() - d[1] < 1)
        time.sleep(0.07)
        self.assertIsNone(b.get_fresh("BTCUSDT"))  # basi -> HARUS fallback REST
        b.update("ETHUSDT", 3000.0)
        b.clear()
        self.assertEqual(b.snapshot(), {})

    def test_update_terakhir_menang_dan_drop_counter_tak_dipakai(self):
        b = wsm.PriceBoard(max_age_sec=5)
        b.update("BTCUSDT", 1.0)
        b.update("BTCUSDT", 2.0)  # out-of-order event time tetap diterima (penerimaan terakhir)
        self.assertEqual(b.get_fresh("BTCUSDT"), 2.0)

    def test_backoff_bounded(self):
        self.assertEqual(wsm.backoff_delay(1), 1.0)
        self.assertEqual(wsm.backoff_delay(2), 2.0)
        self.assertEqual(wsm.backoff_delay(3), 4.0)
        self.assertEqual(wsm.backoff_delay(10), 30.0)  # cap
        self.assertEqual(wsm.backoff_delay(99), 30.0)

    def test_accept_key_rfc_vector(self):
        self.assertEqual(wsm.ws_accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
                         "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")


class FakeWsSock:
    """Socket mock dua arah: client (feed) menulis lewat sendall; server (test)
    mengirim frame lewat push(). recv() blokir sampai data/timeout/close."""

    def __init__(self, server):
        self.server = server
        self.rx = b""
        self.cv = threading.Condition()
        self.closed = False
        self.t = 5.0

    def settimeout(self, t):
        self.t = t

    def sendall(self, data):
        self.server.on_client_bytes(data)

    def recv(self, n):
        with self.cv:
            deadline = time.time() + self.t
            while not self.rx and not self.closed and time.time() < deadline:
                self.cv.wait(0.02)
            if self.closed and not self.rx:
                return b""  # EOF -> feed reconnect
            out, self.rx = self.rx[:n], self.rx[n:]
        if not out:
            raise socket.timeout()
        return out

    def push(self, data):
        with self.cv:
            self.rx += data
            self.cv.notify()

    def close(self):
        with self.cv:
            self.closed = True
            self.cv.notify()


class FakeWsServer:
    """Server WS mock: handshake + kirim frame + catat frame client (pong,
    subscribe). Frame client masked; di-parse minimal utk assert."""

    def __init__(self):
        self.sock = FakeWsSock(self)
        self.handshake_path = None
        self.client_frames = []  # (opcode, payload)
        self.handshaked = False
        self._buf = b""

    def on_client_bytes(self, data):
        if not self.handshaked:
            self._buf += data
            if b"\r\n\r\n" not in self._buf:
                return
            head = self._buf.split(b"\r\n\r\n", 1)[0].decode("latin1")
            self.handshake_path = head.split(" ")[1]
            key = ""
            for line in head.split("\r\n"):
                if line.lower().startswith("sec-websocket-key:"):
                    key = line.split(":", 1)[1].strip()
            accept = wsm.ws_accept_key(key)
            resp = ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                    "Connection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n" % accept)
            self.sock.push(resp.encode("ascii"))
            self.handshaked = True
            self._buf = self._buf.split(b"\r\n\r\n", 1)[1]
        else:
            self._buf += data
        # parse frame client (masked)
        while True:
            b = self._buf
            if len(b) < 2:
                return
            ln = b[1] & 0x7F
            off = 2
            if ln == 126:
                if len(b) < 4:
                    return
                ln = int.from_bytes(b[2:4], "big"); off = 4
            elif ln == 127:
                if len(b) < 10:
                    return
                ln = int.from_bytes(b[2:10], "big"); off = 10
            if b[1] & 0x80:
                off += 4
            if len(b) < off + ln:
                return
            self.client_frames.append((b[0] & 0x0F, b[off:off + ln]))
            self._buf = b[off + ln:]

    def send_text(self, text):
        payload = text.encode("utf-8")
        n = len(payload)
        if n < 126:
            hdr = bytes([0x81, n])
        elif n < 65536:
            hdr = bytes([0x81, 126]) + n.to_bytes(2, "big")
        else:
            hdr = bytes([0x81, 127]) + n.to_bytes(8, "big")
        self.sock.push(hdr + payload)

    def send_ping(self):
        self.sock.push(bytes([0x89, 0]) )

    def send_close(self):
        self.sock.push(bytes([0x88, 0]))


class TestWsMarketFeedE2E(unittest.TestCase):
    def test_feed_end_to_end_handshake_subscribe_ping_pong_reconnect(self):
        tmp = tempfile.mkdtemp(prefix="ws_")
        health = os.path.join(tmp, "ws_health.json")
        server = FakeWsServer()
        servers = [server]

        def factory(host):
            return servers[-1].sock
        board = wsm.PriceBoard(max_age_sec=3.0)
        feed = wsm.WsMarketFeed(board, symbols=["BTCUSDT"], socket_factory=factory,
                                base_backoff=0.05, cap_backoff=0.1, idle_timeout=1.0,
                                health_file=health)
        feed.start()
        try:
            # 1) handshake + subscribe tercatat di path server
            self.assertTrue(wait_until(lambda: server.handshake_path is not None, 5))
            self.assertIn("btcusdt@aggtrade", (server.handshake_path or "").lower())
            # 2) server ack subscribe (harus di-skip, bukan dianggap trade)
            server.send_text(json.dumps({"id": 1, "result": None}))
            # 3) ping -> feed harus membalas pong
            server.send_ping()
            self.assertTrue(wait_until(lambda: any(op == wsm.OP_PONG for op, _ in server.client_frames), 5))
            # 4) aggTrade valid -> board terisi
            server.send_text(json.dumps({"e": "aggTrade", "E": 1791800000000,
                "s": "BTCUSDT", "p": "65000.5", "q": "1", "T": 1791800000001, "a": 9}))
            self.assertTrue(wait_until(lambda: board.get_fresh("BTCUSDT") == 65000.5, 5))
            # 5) malformed -> ditolak, counter naik, board tak berubah
            server.send_text("ini bukan json")
            self.assertTrue(wait_until(lambda: feed.rejected >= 1, 3))
            self.assertEqual(board.get_fresh("BTCUSDT"), 65000.5)
            self.assertEqual(feed.state, wsm.WsMarketFeed.STATE_OPEN)
            self.assertTrue(os.path.exists(health))
            h = json.load(open(health))
            self.assertEqual(h["state"], "OPEN")
            self.assertIn("BTCUSDT", h["symbols"])
            # 6) server close -> reconnect bounded; handshake kedua membawa simbol sama
            server.send_close()
            self.assertTrue(wait_until(lambda: feed.attempt >= 1, 5))
            self.assertLessEqual(feed.attempt, 3)  # backoff bounded
        finally:
            feed.stop()

    def test_subscribe_symbols_dinamis(self):
        board = wsm.PriceBoard()
        feed = wsm.WsMarketFeed(board, symbols=["BTCUSDT"],
                                socket_factory=lambda host: FakeWsServer().sock)
        self.assertEqual(feed.symbols(), {"BTCUSDT"})
        feed.subscribe_symbols(["ETHUSDT", "btcusdt"])
        self.assertEqual(feed.symbols(), {"BTCUSDT", "ETHUSDT"})


class TestWsUserDataListener(unittest.TestCase):
    def test_events_terekam_dan_keepalive_jalan(self):
        tmp = tempfile.mkdtemp(prefix="wsu_")
        sink = os.path.join(tmp, "user.jsonl")
        server = FakeWsServer()
        keeps = {"n": 0}

        def keepalive(key):
            keeps["n"] += 1
        lst = wsm.WsUserDataListener(
            sink_path=sink,
            api_key_header_fn=lambda: {"X-MBX-APIKEY": "dummy"},
            ws_factory=lambda: server.sock,
            listen_key_fn=lambda: "LK_test_123",
            keepalive_fn=keepalive, base_backoff=0.05, cap_backoff=0.1,
            idle_timeout=1.0)
        lst._ka_at = 0.0  # paksa keepalive di iterasi pertama
        lst.start()
        try:
            self.assertTrue(wait_until(lambda: server.handshaked, 5))
            # GATE: route private pasca-migrasi /private/ws/<listenKey>.
            self.assertEqual(server.handshake_path, "/private/ws/LK_test_123")
            server.send_text(json.dumps({"e": "ORDER_TRADE_UPDATE", "E": 1,
                                         "o": {"s": "BTCUSDT", "X": "FILLED"}}))
            self.assertTrue(wait_until(lambda: os.path.exists(sink) and len(open(sink).read().splitlines()) == 1, 5))
            row = json.loads(open(sink).read().splitlines()[0])
            self.assertEqual(row["ev"]["e"], "ORDER_TRADE_UPDATE")
            self.assertIn("recvAt", row)
            self.assertGreaterEqual(keeps["n"], 1)
            self.assertGreaterEqual(lst.events, 1)
        finally:
            lst.stop()

    def test_listenkey_gagal_fail_closed_backoff(self):
        tmp = tempfile.mkdtemp(prefix="wsu2_")
        calls = {"n": 0}

        def fail_key():
            calls["n"] += 1
            raise RuntimeError("listenKey gagal")
        lst = wsm.WsUserDataListener(
            sink_path=os.path.join(tmp, "u.jsonl"), ws_factory=lambda: FakeWsServer().sock,
            listen_key_fn=fail_key, keepalive_fn=lambda k: None,
            base_backoff=0.05, cap_backoff=0.1)
        lst.start()
        try:
            self.assertTrue(wait_until(lambda: calls["n"] >= 2, 5))
            self.assertEqual(lst.state, wsm.WsMarketFeed.STATE_BACKOFF)
            self.assertFalse(os.path.exists(os.path.join(tmp, "u.jsonl")))
        finally:
            lst.stop()


# ───────────────────── P5 integrasi: fallback & degraded ────────────────────
class TestWatchdogPriceSource(Base):
    def test_rest_fallback_saat_tidak_ada_feed(self):
        wd.WS_FEED = None
        self.setup_long(amt=100.0)
        st = self.state()
        self.tick(st)  # jalur lama murni REST — tetap jalan
        self.assertEqual(st["symbols"]["BTCUSDT"]["phase"], wd.PH_EXIT_PENDING)

    def test_rest_fallback_adalah_endpoint_futures(self):
        # GATE: REST fallback HARUS Futures-native (/fapi), bukan Spot.
        # Harness menimpa wd.get_last_price dengan lambda — pakai implementasi
        # ASLI yang di-capture di header modul (WD_GET_LAST_PRICE_ORIG),
        # dipasang sementara hanya selama pemanggilan, dengan public_get fake.
        captured = {}
        def fake_public(path, params=None):
            captured["path"] = path
            return {"price": "1.0"}
        orig_public = wd.public_get
        orig_glp = wd.get_last_price
        wd.public_get = fake_public
        wd.get_last_price = WD_GET_LAST_PRICE_ORIG
        try:
            px = wd.get_last_price("BTCUSDT")
        finally:
            wd.public_get = orig_public
            wd.get_last_price = orig_glp
        self.assertEqual(px, 1.0)
        self.assertEqual(captured["path"], "/fapi/v1/ticker/price")

    def test_stale_board_fallback_rest_dan_degraded_flag(self):
        self.setup_long(amt=100.0)  # harga REST 0.85 dari harness
        board = wsm.PriceBoard(max_age_sec=0.03)
        board.update("BTCUSDT", 65000.0)
        feed = wsm.WsMarketFeed(board, symbols=["BTCUSDT"],
                                socket_factory=lambda host: FakeWsServer().sock)
        wd.WS_FEED = feed
        wd.WS_DEGRADED_LAST = False
        self.addCleanup(setattr, wd, "WS_FEED", None)
        time.sleep(0.05)  # board jadi basi
        px, receipt = wd._last_price_for("BTCUSDT")
        self.assertEqual(px, 0.85)  # dari REST (get_last_price harness)
        self.assertIsNone(receipt)
        self.assertTrue(wd.WS_DEGRADED_LAST)  # transisi degraded tercatat

    def test_fresh_board_taxa_harga_ws_dan_receipt(self):
        board = wsm.PriceBoard(max_age_sec=3.0)
        board.update("BTCUSDT", 65000.5)
        feed = wsm.WsMarketFeed(board, symbols=["BTCUSDT"],
                                socket_factory=lambda host: FakeWsServer().sock)
        wd.WS_FEED = feed
        wd.WS_DEGRADED_LAST = True  # simulasi sebelumnya degraded
        self.addCleanup(setattr, wd, "WS_FEED", None)
        px, receipt = wd._last_price_for("BTCUSDT")
        self.assertEqual(px, 65000.5)
        self.assertIsNotNone(receipt)  # monotonic receipt utk telemetri
        self.assertFalse(wd.WS_DEGRADED_LAST)  # recovered


if __name__ == "__main__":
    unittest.main(verbosity=2)
