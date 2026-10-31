#!/usr/bin/env bash
# P5 — release server+web dengan snapshot dist dan rollback otomatis.
# Pemakaian: deploy/release.sh [--dry-run] [--expect-live]
# Tidak menyentuh ARM; setelah restart state trading (executionMode + arm)
# harus IDENTIK dengan sebelum release. Deploy saat mode LIVE harus eksplisit
# dengan --expect-live (go-live 27 Okt 2026: produksi memang LIVE).
set -euo pipefail

ROOT="${ARTA_ROOT:-/opt/kestrel}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/opt/kestrel/.release-backup-$STAMP.tgz"
DRY=0
EXPECT_LIVE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --expect-live) EXPECT_LIVE=1 ;;
    *) echo "[release] FAIL arg tak dikenal: $arg" >&2; exit 1 ;;
  esac
done

step(){ echo "[release] $*"; }
run(){ if [ "$DRY" = "1" ]; then echo "[dry-run] $*"; else eval "$@"; fi; }

cd "$ROOT"
step "preflight disk/service"
AVAIL_KB="$(df -Pk "$ROOT" | awk 'NR==2{print $4}')"
[ "$AVAIL_KB" -gt 2097152 ] || { echo "[release] FAIL disk < 2 GB" >&2; exit 1; }
curl -fsS --max-time 5 http://127.0.0.1:8787/api/health >/tmp/arta-health-pre.json || {
  echo "[release] FAIL health sebelum release" >&2; exit 1; }
PRE_MODE="$(python3 -c 'import json;print(json.load(open("/tmp/arta-health-pre.json")).get("executionMode"))')"
PRE_ARM="$(python3 -c 'import json;print(json.load(open("/tmp/arta-health-pre.json")).get("arm"))')"
step "state pra-release: mode=$PRE_MODE arm=$PRE_ARM"
if [ "$PRE_MODE" = "LIVE" ] && [ "$EXPECT_LIVE" != "1" ]; then
  echo "[release] FAIL: produksi sedang mode LIVE. Release yang mengubah dist saat LIVE" >&2
  echo "[release]         harus eksplisit: deploy/release.sh --expect-live" >&2
  exit 1
fi

step "snapshot dist -> $BACKUP"
run "tar -czf '$BACKUP' apps/server/dist apps/web/dist"

step "build server + web"
run "npm run build"

step "restart artatrade"
run "sudo systemctl restart artatrade.service"

step "health check (maks 60 dtk)"
if [ "$DRY" = "1" ]; then
  echo "[dry-run] menunggu /api/health 200"
else
  ok=0
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 http://127.0.0.1:8787/api/health >/tmp/arta-health.json 2>/dev/null; then ok=1; break; fi
    sleep 2
  done
  if [ "$ok" != "1" ]; then
    echo "[release] HEALTH GAGAL — rollback dist" >&2
    tar -xzf "$BACKUP" -C "$ROOT"
    sudo systemctl restart artatrade.service
    exit 1
  fi
  MODE="$(python3 -c 'import json;print(json.load(open("/tmp/arta-health.json")).get("executionMode"))')"
  ARMED="$(python3 -c 'import json;print(json.load(open("/tmp/arta-health.json")).get("arm"))')"
  LIVE="$(python3 -c 'import json;print(json.load(open("/tmp/arta-health.json")).get("liveReady"))')"
  echo "[release] health OK mode=$MODE arm=$ARMED liveReady=$LIVE (pra-release: mode=$PRE_MODE arm=$PRE_ARM)"
  # Safety: release TIDAK BOLEH mengubah state trading. Mode atau ARM yang
  # berbeda setelah restart = dist baru mengubah keadaan trading -> rollback.
  if [ "$MODE" != "$PRE_MODE" ] || [ "$ARMED" != "$PRE_ARM" ]; then
    echo "[release] FAIL safety state: mode/arm berubah ($PRE_MODE/$PRE_ARM -> $MODE/$ARMED) — rollback dist" >&2
    tar -xzf "$BACKUP" -C "$ROOT"
    sudo systemctl restart artatrade.service
    exit 1
  fi
fi

step "selesai; backup dist: $BACKUP"
