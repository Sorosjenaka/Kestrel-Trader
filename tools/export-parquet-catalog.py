#!/usr/bin/env python3
"""T-17 (CP-5) — katalog Parquet untuk data riset + tabel DB utama.

READ-ONLY terhadap DB. Output default: data/catalog/
  klines_1h/<SYMBOL>.parquet
  klines_15m/<SYMBOL>.parquet
  db/<table>.parquet            (Trade, Position, OrderExec, ResearchFinding)
  manifest.json                 (jumlah baris + sha256 file)

Pemakaian (venv riset punya pandas+pyarrow):
  research/.venv-vbt/bin/python tools/export-parquet-catalog.py
  research/.venv-vbt/bin/python tools/export-parquet-catalog.py --only klines
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "data" / "catalog"
DB = ROOT / "data" / "artatrade.db"
KLINE_COLS = ["open_time", "open", "high", "low", "close", "volume",
              "close_time", "quote_volume", "trades", "taker_base", "taker_quote", "ignore"]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def export_klines(src: Path, out_dir: Path, suffix: str) -> list[dict]:
    rows = []
    out_dir.mkdir(parents=True, exist_ok=True)
    for csv_path in sorted(src.glob(f"*{suffix}.csv")):
        symbol = csv_path.name[: -len(suffix)]
        df = pd.read_csv(csv_path, header=None, names=KLINE_COLS)
        df["open_time"] = pd.to_datetime(df["open_time"], unit="ms", utc=True)
        df["close_time"] = pd.to_datetime(df["close_time"], unit="ms", utc=True)
        target = out_dir / f"{symbol}.parquet"
        df.to_parquet(target, index=False, compression="zstd")
        rows.append({"symbol": symbol, "rows": int(len(df)), "file": str(target.relative_to(ROOT)),
                     "sha256": sha256(target)})
    return rows


def export_db(tables: list[str], out_dir: Path) -> list[dict]:
    rows = []
    out_dir.mkdir(parents=True, exist_ok=True)
    if not DB.exists():
        return rows
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        for table in tables:
            try:
                df = pd.read_sql_query(f'SELECT * FROM "{table}"', conn)
            except Exception as exc:  # table may not exist in an older DB
                rows.append({"table": table, "rows": 0, "error": str(exc)[:200]})
                continue
            target = out_dir / f"{table}.parquet"
            df.to_parquet(target, index=False, compression="zstd")
            rows.append({"table": table, "rows": int(len(df)), "file": str(target.relative_to(ROOT)),
                         "sha256": sha256(target)})
    finally:
        conn.close()
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["klines", "db"], default=None)
    args = ap.parse_args()
    manifest = {"generatedAt": pd.Timestamp.now("UTC").isoformat(), "sources": {}}
    if args.only in (None, "klines"):
        manifest["sources"]["klines_1h"] = export_klines(ROOT / "research" / "data", CATALOG / "klines_1h", "-1h")
        manifest["sources"]["klines_15m"] = export_klines(
            ROOT / "data" / "swing-v16" / "bars-long-history", CATALOG / "klines_15m", "-15m")
    if args.only in (None, "db"):
        manifest["sources"]["db"] = export_db(
            ["Trade", "Position", "OrderExec", "ResearchFinding"], CATALOG / "db")
    CATALOG.mkdir(parents=True, exist_ok=True)
    (CATALOG / "manifest.json").write_text(json.dumps(manifest, indent=1))
    total = sum(len(v) for v in manifest["sources"].values())
    print(json.dumps({"catalog": str(CATALOG), "entries": total,
                      "sources": {k: len(v) for k, v in manifest["sources"].items()}}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
