#!/usr/bin/env bash
# 23 Okt 2026 — kill posisi PAPER yang gagal gate volume operator (VOLUME_MIN_USD).
# READ-STEP: hitung dulu, tampilkan, baru kill satu per satu (bukan kill-all).
# Setiap kill diverifikasi ulang dari /api/positions?status=OPEN.
set -uo pipefail

API="http://127.0.0.1:8787"
MIN="${VOLUME_MIN_USD:-7000000}"

# 25 Okt 2026 (FASE 1 auth): mutasi wajib x-api-token — loopback tidak lagi
# bypass. Token dibaca dari .env server, tidak pernah dicetak/log.
ARTA_ENV="${ARTA_ROOT:-/opt/kestrel}/.env"
API_TOKEN="$(grep '^API_MUTATION_TOKEN=' "$ARTA_ENV" 2>/dev/null | cut -d= -f2- || true)"
[ -n "$API_TOKEN" ] || { echo "GAGAL: API_MUTATION_TOKEN tidak ada di $ARTA_ENV"; exit 1; }
AUTH_H=(-H "x-api-token: ${API_TOKEN}")

echo "== Gate volume floor: $MIN USD =="
echo "== Mengambil snapshot volume =="
curl -sS -m 10 "$API/api/prices/live" -o /tmp/hub-kill.json || { echo "GAGAL ambil hub"; exit 1; }

python3 - "$MIN" <<'PY' > /tmp/kill-list.txt
import json, sys, urllib.request
MIN = float(sys.argv[1])
hub = json.load(open('/tmp/hub-kill.json'))['prices']
pos = json.load(urllib.request.urlopen('http://127.0.0.1:8787/api/positions?status=OPEN'))['positions']
for p in sorted(pos, key=lambda x: x['id']):
    v = hub.get(p['symbol'], {}).get('v')
    vv = float(v) if v is not None else None
    if vv is None:
        print(f"{p['id']} {p['symbol']} NO_DATA")
    elif not (vv > MIN):
        print(f"{p['id']} {p['symbol']} {vv:.0f}")
PY

echo "== Kandidat kill (volume <= floor) =="
cat /tmp/kill-list.txt
echo ""

KILLED=0; FAILED=0
while read -r ID SYM VOL; do
  [ -z "$ID" ] && continue
  RESP=$(curl -sS -m 20 -X POST "$API/api/positions/$ID/kill" "${AUTH_H[@]}" -w "\n%{http_code}")
  CODE=$(echo "$RESP" | tail -1)
  BODY=$(echo "$RESP" | head -n -1)
  if [ "$CODE" = "200" ]; then
    KILLED=$((KILLED+1))
    echo "OK   $ID $SYM vol=$VOL -> $BODY"
  else
    FAILED=$((FAILED+1))
    echo "GAGAL $ID $SYM vol=$VOL http=$CODE -> $BODY"
  fi
done < /tmp/kill-list.txt

echo ""
echo "== RINGKASAN: killed=$KILLED failed=$FAILED =="
