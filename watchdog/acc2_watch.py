#!/usr/bin/python3
"""Watcher sesi LIVE ACC2 (read-only). Round bounded 30 menit.
Keluar + print saat: ARM mati (tripwire/guard), posisi LIVE baru terbuka,
atau trade LIVE ditutup. Timeout = status one-line."""
import json, time, urllib.request, sqlite3, glob, os, sys

CUTOFF_MS = int(sys.argv[1]) if len(sys.argv) > 1 else int(time.time() * 1000)
DB = '/opt/kestrel/data/artatrade.db'
HEALTH = 'http://127.0.0.1:8787/api/health'
REPORTS = '/opt/kestrel/data/reports'

def health():
    try:
        with urllib.request.urlopen(HEALTH, timeout=5) as r:
            return json.loads(r.read().decode())
    except Exception:
        return {}

def db_rows():
    try:
        con = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
        pos = list(con.execute(
            "SELECT id, symbol, side, datetime(openedAt/1000,'unixepoch','+8 hours'), source "
            "FROM Position WHERE status='OPEN' ORDER BY openedAt DESC"))
        trades = list(con.execute(
            "SELECT id, symbol, side, source, pnlUsd, rMultiple, win, datetime(createdAt/1000,'unixepoch','+8 hours') "
            "FROM Trade WHERE createdAt >= %d ORDER BY createdAt DESC" % CUTOFF_MS))
        con.close()
        return pos, trades
    except Exception as e:
        return [], []

seen_pos = set()
seen_trade = set()
# Seed awal: posisi/trade yang SUDAH ada saat round mulai bukan event baru.
_pos0, _tr0 = db_rows()
seen_pos.update(p[0] for p in _pos0)
seen_trade.update(t[0] for t in _tr0)
for i in range(30):
    h = health()
    arm = bool(h.get('arm'))
    pos, trades = db_rows()
    new_pos = [p for p in pos if p[0] not in seen_pos and str(p[4]).startswith('LIVE')]
    new_tr = [t for t in trades if t[0] not in seen_trade]
    reports = sorted(glob.glob(os.path.join(REPORTS, 'loss-stop-*.md')))
    new_report = [r for r in reports if os.path.getmtime(r) * 1000 >= CUTOFF_MS]

    if not arm:
        last = trades[0] if trades else None
        print('STOP-DETECTED arm=false | trade terakhir: %s' % (last,))
        if new_report:
            print('TRIPWIRE_REPORT: %s' % new_report[0])
            try:
                print(open(new_report[0]).read()[:1200])
            except Exception:
                pass
        sys.exit(0)
    if new_pos:
        print('ENTRY-BARU: %s' % new_pos)
        sys.exit(0)
    if new_tr:
        print('TRADE-CLOSE: %s | arm masih %s' % (new_tr, arm))
        sys.exit(0)

    seen_pos.update(p[0] for p in pos)
    seen_trade.update(t[0] for t in trades)
    time.sleep(60)

pos, trades = db_rows()
print('ROUND-TIMEOUT: arm=%s posisi_open=%d trades_sejak_arm=%d %s' % (
    health().get('arm'), len(pos), len(trades), trades[:3]))
