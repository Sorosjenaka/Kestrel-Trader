#!/usr/bin/env bash
# P6 — simpan snapshot /metrics (Prometheus text) untuk review harian.
set -euo pipefail
ROOT="${ARTA_ROOT:-/opt/kestrel}"
DEST="$ROOT/data/metrics"
mkdir -p "$DEST"
DAY="$(date +%Y%m%d)"
OUT="$DEST/artatrade-$DAY.prom"
{
  echo "# scrape $(date -Iseconds)"
  curl -fsS --max-time 5 http://127.0.0.1:8787/metrics
} >> "$OUT"
find "$DEST" -type f -name 'artatrade-*.prom' -mtime +7 -delete
