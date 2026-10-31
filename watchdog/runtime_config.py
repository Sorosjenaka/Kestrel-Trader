"""Side-effect-free defaults and explicit runtime configuration loading.

Importing a watchdog module never reads .env, config, state, or log files.
Only the CLI main path calls these loaders. Paths from the historical checkout
prefix are relocated in memory; the operator's configuration is never rewritten.
"""
import json
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
LEGACY_ROOT = "/opt/kestrel"
PATH_KEYS = {"env_file", "db_path", "state_file", "log_file", "monitor_script",
             "ws_health_file", "latency_sink_file", "ws_user_sink_file"}


def default_config():
    return {
        "env_file": str(ROOT / ".env"), "db_path": str(ROOT / "data/artatrade.db"),
        "state_file": str(ROOT / "watchdog/watchdog_state.json"),
        "log_file": str(ROOT / "watchdog/watchdog.log"),
        "monitor_script": str(ROOT / "watchdog/monitor_agent.py"),
        "binance_base": "https://fapi.binance.com", "dry_run": True,
        "poll_interval_sec": 1.0, "alert_pct": 0.3,
        "recv_window_ms": 5000, "allowed_symbols": [],
        "enable_monitor": False, "ws_enabled": False, "ws_user_enabled": False,
    }


def load_config(config_path=None):
    config = default_config()
    path = Path(config_path or os.environ.get("ARTATRADE_WATCHDOG_CONFIG") or
                ROOT / "watchdog/watchdog_config.json")
    with path.open("r", encoding="utf-8") as stream:
        supplied = json.load(stream)
    if not isinstance(supplied, dict):
        raise ValueError("Watchdog configuration must be a JSON object")
    config.update(supplied)
    for name in PATH_KEYS:
        value = config.get(name)
        if not value:
            continue
        value = str(value).replace("\\", "/")
        if value == LEGACY_ROOT or value.startswith(LEGACY_ROOT + "/"):
            value = str(ROOT / value[len(LEGACY_ROOT):].lstrip("/"))
        elif not Path(value).is_absolute():
            value = str(ROOT / value)
        config[name] = value
    return config


def load_environment(path):
    values = {}
    with open(path, "r", encoding="utf-8") as stream:
        for line in stream:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip().strip('"').strip("'")
    return values
