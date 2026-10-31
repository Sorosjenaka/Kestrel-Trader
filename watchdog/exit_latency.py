#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
exit_latency.py — Telemetri latensi eksekusi exit watchdog (CP: P3).

ATURAN (directive P3):
  - Durasi LOKAL memakai time.monotonic() (tidak terpengaruh NTP/step).
  - Timestamp EXCHANGE disimpan TERPISAH (order updateTime, trade time) untuk
    korelasi — tidak pernah dicampur ke durasi lokal.
  - Sink JSONL append-only; satu baris per logical exit. Fail telemetri TIDAK
    BOLEH mempengaruhi jalur eksekusi (semua helper fail-open, tanpa raise).
  - Persentil hanya dihitung bila jumlah sampel riil mendukung (min_n);
    setiap angka DILABELI sumbernya: SYNTHETIC / TESTNET / PRODUCTION.
  - Privasi: simbol + clientOrderId + orderId + durasi — tidak ada key/saldo.

Stase yang diukur (durasi lokal, detik):
  receipt_to_trigger   : harga LAST diterima/poll -> keputusan trigger
  trigger_to_send      : keputusan -> submit close
  send_to_ack          : submit -> respons HTTP/API
  send_to_first_fill   : submit -> bukti fill pertama (exchange updateTime; label exchange)
  trigger_to_flat      : keputusan -> positionRisk amt=0 (confirmed flat)
  total                : receipt -> confirmed flat
"""
import json
import os
import time

MIN_N = 20  # persentil hanya bila n >= ini
SCHEMA = 1

_EVENT_KEYS = (
    "receipt",            # monotonic: harga trigger teramati
    "trigger",            # monotonic: keputusan exit
    "send",               # monotonic: request close dikirim
    "ack",                # monotonic: respons API diterima
    "first_fill",         # monotonic: bukti fill pertama lokal (bila ada)
    "final_fill",         # monotonic: bukti fill terakhir lokal (bila ada)
    "flat",               # monotonic: positionRisk amt=0
)

# Durasi lokal (stase awal, stase akhir) — detik.
_STAGES = (
    ("receipt_to_trigger", "receipt", "trigger"),
    ("trigger_to_send", "trigger", "send"),
    ("send_to_ack", "send", "ack"),
    ("trigger_to_flat", "trigger", "flat"),
    ("total", "receipt", "flat"),
)


def now_monotonic():
    return time.monotonic()


def new_event(symbol, trigger_source, trigger_level, client_order_id):
    """Timeline per logical exit. Semua stase None sampai tercatat."""
    return {
        "schema": SCHEMA,
        "symbol": str(symbol).upper(),
        "triggerSource": str(trigger_source),
        "triggerLevel": trigger_level,
        "clientOrderId": str(client_order_id),
        "exchangeOrderId": None,
        "monotonic": {k: None for k in _EVENT_KEYS},
        # Timestamp exchange (ms epoch) — korelasi, BUKAN durasi lokal.
        "exchange": {
            "orderUpdateTimeMs": None,
            "tradeFirstTimeMs": None,
            "tradeLastTimeMs": None,
            "positionRiskCheckMs": None,
        },
        "remainingQty": None,
        "outcome": None,          # WATCHDOG / NATIVE_SLTP / dst (dari confirm_flat)
        "startedAtRealtime": time.time(),
        "done": False,
    }


def mark(event, stage):
    """Catat stase lokal. Fail-open: exception telemetri tak pernah naik."""
    try:
        if event is not None and stage in _EVENT_KEYS:
            event["monotonic"][stage] = now_monotonic()
    except Exception:
        pass


def mark_exchange(event, field, value_ms):
    try:
        if event is not None and field in event["exchange"] and value_ms is not None:
            v = float(value_ms)
            if v > 0:
                event["exchange"][field] = v
    except Exception:
        pass


def finalize(event, outcome, remaining_qty=None):
    try:
        if event is None:
            return None
        event["outcome"] = str(outcome)
        event["remainingQty"] = remaining_qty
        event["done"] = True
        return event
    except Exception:
        return event


def stage_durations(event):
    """Hitung durasi stase (detik). Stase belum lengkap -> None utk itu."""
    out = {}
    try:
        mono = (event or {}).get("monotonic") or {}
        for name, a, b in _STAGES:
            ta, tb = mono.get(a), mono.get(b)
            out[name] = (tb - ta) if (ta is not None and tb is not None) else None
    except Exception:
        for name, _, _ in _STAGES:
            out.setdefault(name, None)
    return out


class JsonlSink:
    """Append-only sink JSONL. Satu baris per exit selesai."""

    def __init__(self, path):
        self.path = path

    def write(self, event):
        try:
            if not event or not event.get("done"):
                return False
            row = dict(event)
            row["durations"] = stage_durations(event)
            row.pop("_buf", None)
            d = os.path.dirname(self.path)
            if d and not os.path.isdir(d):
                os.makedirs(d, exist_ok=True)
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(json.dumps(row, separators=(",", ":")) + "\n")
            return True
        except Exception:
            return False


def read_samples(path, max_rows=20000):
    """Baca durasi dari JSONL. Return list of dict durations (bila baris valid)."""
    out = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                    d = row.get("durations")
                    if isinstance(d, dict):
                        out.append(d)
                except Exception:
                    continue
                if len(out) >= max_rows:
                    break
    except Exception:
        pass
    return out


def percentile(sorted_vals, p):
    """Linear interpolation (metode R-7). sorted_vals harus terurut."""
    n = len(sorted_vals)
    if n == 0:
        return None
    if n == 1:
        return sorted_vals[0]
    k = (n - 1) * (p / 100.0)
    lo = int(k)
    hi = min(lo + 1, n - 1)
    frac = k - lo
    return sorted_vals[lo] * (1.0 - frac) + sorted_vals[hi] * frac


def summarize(durations_list, source_label, min_n=MIN_N):
    """Rekap p50/p95/p99 + n per stase. Persentil TIDAK dihitung bila n < min_n
    (kembalikan null + reason) — directive P3: hanya bila sampel mendukung."""
    stages = [name for name, _, _ in _STAGES]
    out = {"source": source_label, "n": len(durations_list), "stages": {}}
    for st in stages:
        vals = []
        for d in durations_list:
            v = (d or {}).get(st)
            if isinstance(v, (int, float)) and v >= 0:
                vals.append(float(v))
        vals.sort()
        st_out = {"n": len(vals)}
        if len(vals) >= min_n:
            st_out["p50"] = round(percentile(vals, 50), 6)
            st_out["p95"] = round(percentile(vals, 95), 6)
            st_out["p99"] = round(percentile(vals, 99), 6)
        else:
            st_out["p50"] = st_out["p95"] = st_out["p99"] = None
            st_out["reason"] = "n<%d" % min_n
            if vals:
                st_out["min"] = round(vals[0], 6)
                st_out["max"] = round(vals[-1], 6)
        out["stages"][st] = st_out
    return out


if __name__ == "__main__":
    # CLI kecil: rekap dari file JSONL — sumber WAJIB dilabeli manual di sini.
    import sys
    if len(sys.argv) < 2:
        print("usage: exit_latency.py <latency.jsonl> [label]")
        raise SystemExit(2)
    rows = read_samples(sys.argv[1])
    label = sys.argv[2] if len(sys.argv) > 2 else "UNLABELED"
    print(json.dumps(summarize(rows, label), indent=1))
