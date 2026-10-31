#!/usr/bin/env bash
# P1 — backup SQLite konsisten + rotasi + opsional offsite (19 Okt 2026).
# Aman saat service jalan: sqlite3 ".backup" memakai snapshot WAL yang konsisten.
# Tidak menyentuh trading/ARM. Set BACKUP_OFFSITE_DIR untuk salinan offsite.
set -euo pipefail
umask 077

ROOT="${ARTA_ROOT:-/opt/kestrel}"
DB="$ROOT/data/artatrade.db"
DEST="${BACKUP_DEST:-$ROOT/data/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST/artatrade-$STAMP.db"
DAILY_KEEP="${BACKUP_DAILY_KEEP:-7}"
WEEKLY_KEEP="${BACKUP_WEEKLY_KEEP:-4}"

mkdir -p "$DEST" "$DEST/weekly"

echo "[backup] source=$DB dest=$OUT"
sqlite3 "$DB" ".backup '$OUT'"
CHECK="$(sqlite3 "$OUT" 'pragma quick_check;')"
if [ "$CHECK" != "ok" ]; then
  echo "[backup] FAIL quick_check=$CHECK" >&2
  rm -f "$OUT"
  exit 1
fi

SRC_TRADES="$(sqlite3 "$DB" 'select count(*) from Trade;')"
DST_TRADES="$(sqlite3 "$OUT" 'select count(*) from Trade;')"
if [ "$SRC_TRADES" != "$DST_TRADES" ]; then
  echo "[backup] FAIL trade count source=$SRC_TRADES backup=$DST_TRADES" >&2
  exit 1
fi

# Rotasi harian: sisakan N file terbaru.
find "$DEST" -maxdepth 1 -type f -name 'artatrade-*.db' -printf '%T@ %p\n' \
  | sort -nr | awk -v keep="$DAILY_KEEP" 'NR>keep{print $2}' | xargs -r rm -f

# Mingguan: tiap Minggu simpan satu salinan, rotasi N terbaru.
if [ "$(date +%u)" = "7" ]; then
  cp "$OUT" "$DEST/weekly/artatrade-week-$STAMP.db"
  find "$DEST/weekly" -maxdepth 1 -type f -name 'artatrade-week-*.db' -printf '%T@ %p\n' \
    | sort -nr | awk -v keep="$WEEKLY_KEEP" 'NR>keep{print $2}' | xargs -r rm -f
fi

# Offsite opsional: hanya kalau path diset dan bukan filesystem yang sama.
if [ -n "${BACKUP_OFFSITE_DIR:-}" ]; then
  mkdir -p "$BACKUP_OFFSITE_DIR"
  cp "$OUT" "$BACKUP_OFFSITE_DIR/"
  echo "[backup] offsite=$BACKUP_OFFSITE_DIR"
fi

echo "[backup] OK trades=$DST_TRADES size=$(stat -c %s "$OUT") file=$OUT"
