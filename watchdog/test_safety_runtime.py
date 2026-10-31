"""Regression tests: no real credentials, sockets, processes, or runtime files."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import watchdog_sltp as wd
import monitor_agent as monitor
import runtime_config
import ws_market


class RuntimeSafety(unittest.TestCase):
    def setUp(self):
        self.enterContext(mock.patch.object(wd, "log", lambda *args: None))
        self.enterContext(mock.patch.object(wd, "save_state", lambda *args: None))

    def test_import_does_not_read_config_credentials_or_install_handlers(self):
        for name in ("watchdog_sltp", "monitor_agent"):
            spec = importlib.util.spec_from_file_location("audit_" + name, HERE / (name + ".py"))
            module = importlib.util.module_from_spec(spec)
            with mock.patch("builtins.open", side_effect=AssertionError("Unexpected data file read")), \
                 mock.patch("signal.signal") as handlers, \
                 mock.patch("urllib.request.urlopen", side_effect=AssertionError("Unexpected network")):
                spec.loader.exec_module(module)
            handlers.assert_not_called()
            self.assertFalse(module._runtime_configured)
            self.assertFalse(module.API_KEY)

    def test_monitor24_import_is_inert(self):
        spec = importlib.util.spec_from_file_location("audit_monitor24", HERE.parent / "monitor24/check24.py")
        module = importlib.util.module_from_spec(spec)
        with mock.patch("os.makedirs", side_effect=AssertionError("Unexpected write")), \
             mock.patch("subprocess.run", side_effect=AssertionError("Unexpected subprocess")), \
             mock.patch("urllib.request.urlopen", side_effect=AssertionError("Unexpected network")):
            spec.loader.exec_module(module)

    def test_legacy_config_paths_relocate_without_changing_file(self):
        with tempfile.TemporaryDirectory() as folder:
            config_path = Path(folder) / "config.json"
            config_path.write_text(json.dumps({"env_file": "/opt/kestrel/.env", "dry_run": True}))
            before = config_path.read_bytes()
            config = runtime_config.load_config(config_path)
            self.assertEqual(Path(config["env_file"]), runtime_config.ROOT / ".env")
            self.assertEqual(config_path.read_bytes(), before)

    def test_dry_run_blocks_every_exchange_mutation_entrypoint(self):
        with mock.patch.object(wd, "DRY_RUN", True), mock.patch.object(wd, "signed_request") as signed, \
             mock.patch.object(wd, "submit_close_order") as submit:
            self.assertFalse(wd._cancel_with_confirmation("BTCUSDT", "SLA_FIXTURE")["confirmed"])
            self.assertIsNone(wd.cancel_order("BTCUSDT", "WDG_FIXTURE")["canceled"])
            self.assertTrue(wd.cleanup_flat_position_protective("BTCUSDT")["dry_run"])
            self.assertEqual(wd.sweep_orphan_protective({"symbols": {}})["skipped"], "DRY_RUN")
            wd.recovery_close("BTCUSDT", {"exit": {"attempts": 1}}, {"amt": 1}, "RETRY", {})
            signed.assert_not_called()
            submit.assert_not_called()
        with mock.patch.object(wd, "DRY_RUN", True), mock.patch("urllib.request.urlopen") as network:
            for method in ("POST", "DELETE", "PUT"):
                self.assertTrue(wd.signed_request(method, "/fapi/v1/order")["_dry_run"])
            self.assertTrue(wd.submit_close_order("BTCUSDT", "SELL", "1", "WDG_FIXTURE")["_dry_run"])
            with self.assertRaises(RuntimeError):
                wd._listen_key_request("POST")
            network.assert_not_called()

    def test_zero_quantity_rows_are_flat_but_non_allowed_open_positions_block_sweep(self):
        with mock.patch.object(wd, "ALLOWED", {"BTCUSDT"}), mock.patch.object(wd, "signed_request", return_value=[
            {"symbol": "BTCUSDT", "positionAmt": "0"},
            {"symbol": "ETHUSDT", "positionAmt": "2", "entryPrice": "100"},
        ]):
            positions, ok = wd.get_open_positions()
        self.assertTrue(ok)
        self.assertEqual([p["symbol"] for p in positions], ["ETHUSDT"])

    def test_flat_snapshot_reaches_periodic_orphan_sweep(self):
        with mock.patch.object(wd, "get_open_positions", return_value=([], True)), \
             mock.patch.object(wd, "ensure_monitor"), mock.patch.object(wd, "levels_from_db", return_value={}), \
             mock.patch.object(wd, "_orphan_sweep_last", -1000), \
             mock.patch.object(wd, "sweep_orphan_protective") as sweep:
            self.assertTrue(wd.tick(wd.new_state(False)))
            sweep.assert_called_once()

    def test_ladder_and_unknown_tp_do_not_full_close_but_sl_still_works(self):
        pos = {"symbol": "BTCUSDT", "amt": 1, "entry": 1, "mark": 1, "side": "LONG"}
        for policy, price, expected in [("LADDER", 1.2, None), (None, 1.2, None),
                                         ("SINGLE_TARGET", 1.2, "TP"), ("LADDER", .8, "SL")]:
            with self.subTest(policy=policy, price=price), \
                 mock.patch.object(wd, "get_open_positions", return_value=([pos], True)), \
                 mock.patch.object(wd, "ALLOWED", set()), mock.patch.object(wd, "WS_FEED", None), \
                 mock.patch.object(wd, "LEVELS_CACHE", wd._LevelsCache(0)), \
                 mock.patch.object(wd, "ensure_monitor"), \
                 mock.patch.object(wd, "levels_from_db", return_value={"BTCUSDT": {"sl": .9, "tp": 1.1, "tpPolicy": policy}}), \
                 mock.patch.object(wd, "levels_from_algo_orders", return_value={}), \
                 mock.patch.object(wd, "_last_price_for", return_value=(price, None)), \
                 mock.patch.object(wd, "begin_exit") as begin:
                wd.tick(wd.new_state(False))
                if expected:
                    self.assertEqual(begin.call_args.args[2], expected)
                else:
                    begin.assert_not_called()


class WsSafety(unittest.TestCase):
    def test_dynamic_subscribe_uses_masked_frame_on_raw_tls_socket(self):
        raw = mock.Mock(spec=["sendall", "close"])
        feed = ws_market.WsMarketFeed(ws_market.PriceBoard(), symbols=["BTCUSDT"])
        feed._sock = raw
        feed._sock_frames = ws_market.WsFrameSocket(raw)
        feed.state = feed.STATE_OPEN
        feed.subscribe_symbols(["ETHUSDT"])
        frame = raw.sendall.call_args.args[0]
        self.assertEqual(frame[0], 0x81)
        self.assertTrue(frame[1] & 0x80)
        length = frame[1] & 0x7f
        mask = frame[2:6]
        payload = bytes(v ^ mask[i % 4] for i, v in enumerate(frame[6:6 + length]))
        self.assertEqual(json.loads(payload)["params"], ["ethusdt@aggTrade"])

    def test_feed_health_refreshes_after_real_message(self):
        with tempfile.TemporaryDirectory() as folder:
            health = Path(folder) / "health.json"
            feed = ws_market.WsMarketFeed(ws_market.PriceBoard(), symbols=["BTCUSDT"], health_file=str(health))
            feed._set_state(feed.STATE_OPEN)
            before = json.loads(health.read_text())["updatedAt"]
            message = json.dumps({"e": "aggTrade", "s": "BTCUSDT", "p": "100", "q": "1", "E": 1, "a": 1, "T": 1})
            def next_frame(**kwargs):
                feed._stop.set()
                return ws_market.OP_TEXT, message.encode()
            feed._sock_frames = mock.Mock(recv_frame=next_frame)
            feed._recv_loop(None)
            after = json.loads(health.read_text())
            self.assertEqual(after["messages"], 1)
            self.assertGreaterEqual(after["updatedAt"], before)
            self.assertLess(after["last_msg_age"], 1)


class MonitorProvenance(unittest.TestCase):
    def test_fallback_and_malformed_llm_do_not_claim_llm_generation(self):
        trade = (1, "BTCUSDT", "LONG", 100, 99, -1, -1, .01, 0, 0, "S-03", "VERIFIED", "SL")
        for response in (None, '{"reason":"incomplete"}'):
            with self.subTest(response=response), \
                 mock.patch.object(monitor, "db_query", side_effect=lambda sql, args: [trade] if "FROM Trade t" in sql else []), \
                 mock.patch.object(monitor, "llm_chat", return_value=response), \
                 mock.patch.object(monitor, "log"), mock.patch.object(monitor, "db_exec", return_value=True) as write:
                self.assertTrue(monitor.write_5why_for_trade(1))
                proposal = json.loads(write.call_args.args[1][3])
                self.assertEqual(proposal["generationSource"], "DETERMINISTIC_FALLBACK")

    def test_failed_snapshot_is_not_flat(self):
        with mock.patch.object(monitor, "signed_request", return_value={"_error": True}):
            self.assertIsNone(monitor.get_positions())


if __name__ == "__main__":
    unittest.main()
