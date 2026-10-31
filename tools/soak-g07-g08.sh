#!/usr/bin/env bash
# Soak 30 menit + profiling render G07/G08.
# Read-only. Tidak mengubah mode trading/ARM/posisi.
set -u
OUT=/opt/kestrel/docs/vike-dashboard-repair-2026-10-25/SOAK
mkdir -p "$OUT"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SVC_PID=$(systemctl show artatrade -p MainPID --value 2>/dev/null)
JOURNAL_MARK=$(date -u '+%Y-%m-%d %H:%M:%S')
echo "SOAK_START_UTC=$STAMP svc_pid=$SVC_PID journal_since=$JOURNAL_MARK" | tee "$OUT/soak-meta.txt"
echo "host=$(hostname) kernel=$(uname -r) cpu_cores=$(nproc) mem_total_kb=$(awk '/MemTotal/{print $2}' /proc/meminfo)" >> "$OUT/soak-meta.txt"
echo "browser_env=hermes browser_exec (Chrome headless via browser-use CLI)" >> "$OUT/soak-meta.txt"
echo "dpr=1 viewport_default=1280x720 (browser_exec default); viewport lain diuji terpisah" >> "$OUT/soak-meta.txt"

# --- Loop 30 menit, sample tiap 30 detik = 60 sampel ---
SAMPLES=0
MAXSAMPLES=60
echo "ts_utc,cpu_pct,mem_rss_kb,mem_vmswap_kb,node_rss_kb,node_swap_kb,ws_conn_total,ws_reconnects_total,log_err_count,http_req_per_min,fd_count,thread_count" \
  > "$OUT/soak-series.csv"

prev_journal_err=0
while [ "$SAMPLES" -lt "$MAXSAMPLES" ]; do
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # CPU: agregat load vs cores
  CPU=$(awk '{print 100.0*$1/$2}' /proc/stat >/dev/null 2>&1; top -bn1 | awk '/Cpu\(s\)/{print 100-$8}' 2>/dev/null | head -1)
  MEM_RSS=$(awk '/^VmRSS:/{print $2}' /proc/$SVC_PID/status 2>/dev/null)
  MEM_SWP=$(awk '/^VmSwap:/{print $2}' /proc/$SVC_PID/status 2>/dev/null)
  NODESWP=$(awk '/^VmSwap:/{print $2}' /proc/$SVC_PID/status 2>/dev/null)
  FD=$(ls /proc/$SVC_PID/fd 2>/dev/null | wc -l)
  THR=$(awk '/^Threads:/{print $2}' /proc/$SVC_PID/status 2>/dev/null)
  # WS health dari file state produksi
  WSJ=""
  for f in /opt/kestrel/data/ws_health.json /opt/kestrel/data/*/ws_health.json; do
    [ -f "$f" ] && WSJ="$WSJ$(cat "$f" 2>/dev/null)"
  done
  WSCONN=$(echo "$WSJ" | grep -oE '"connected"[[:space:]]*:[[:space:]]*(true|false)' | grep -c true)
  WSRECON=$(echo "$WSJ" | grep -oE '"reconnects"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+' | paste -sd+ | bc 2>/dev/null)
  [ -z "${WSRECON:-}" ] && WSRECON=0
  # error log count sejak mark
  ERRS=$(journalctl -u artatrade --since "$JOURNAL_MARK" --no-pager 2>/dev/null | grep -ciE '"level":"error"|ERROR|unhandled|ECONNRESET|unhandledRejection')
  REQPM=$(journalctl -u artatrade --since "-1 min" --no-pager 2>/dev/null | grep -ciE 'GET |POST |request|req ')
  echo "$TS,${CPU:-0},${MEM_RSS:-0},${MEM_SWP:-0},${MEM_RSS:-0},${NODESWP:-0},${WSCONN:-0},${WSRECON:-0},$ERRS,$REQPM,$FD,$THR" \
    >> "$OUT/soak-series.csv"
  SAMPLES=$((SAMPLES+1))
  [ "$SAMPLES" -lt "$MAXSAMPLES" ] && sleep 30
done

echo "SOAK_END_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ) samples=$SAMPLES" | tee -a "$OUT/soak-meta.txt"

# --- Ringkasan ---
awk -F, 'NR>1{
  cpu+=$2; if($2>maxcpu)maxcpu=$2;
  rss+=$3; if($3>maxrss)maxrss=$3;
  swp+=$4; if($4>maxswp)maxswp=$4;
  fd+=$11; if($11>maxfd)maxfd=$11;
  th+=$12; if($12>maxth)maxth=$12;
  wc+=$8; if($8>maxrecon)maxrecon=$8;
  if($7>0) connok++;
  n++;
  first=(NR==2)?$3:first; last=$3;
  firstfd=(NR==2)?$11:firstfd; lastfd=$11;
  firstth=(NR==2)?$12:firstth; lastth=$12;
  firstsw=(NR==2)?$4:firstsw; lastsw=$4;
} END{
  printf "samples=%d\n", n;
  printf "cpu_avg=%.1f cpu_max=%.1f\n", cpu/n, maxcpu;
  printf "rss_avg_kb=%.0f rss_max_kb=%.0f rss_first_kb=%.0f rss_last_kb=%.0f rss_growth_kb=%.0f\n", rss/n, maxrss, first, last, last-first;
  printf "swap_avg_kb=%.0f swap_max_kb=%.0f swap_first_kb=%.0f swap_last_kb=%.0f swap_growth_kb=%.0f\n", swp/n, maxswp, firstsw, lastsw, lastsw-firstsw;
  printf "fd_first=%s fd_last=%s fd_max=%d\n", firstfd, lastfd, maxfd;
  printf "threads_first=%s threads_last=%s threads_max=%d\n", firstth, lastth, maxth;
  printf "ws_reconnects_total_max=%d samples_with_conn=%d\n", maxrecon, connok;
}' "$OUT/soak-series.csv" > "$OUT/soak-summary.txt"

# --- Snapshot journal selama soak ---
journalctl -u artatrade --since "$JOURNAL_MARK" --no-pager > "$OUT/soak-journal.txt" 2>&1
echo "--- error signature breakdown ---" >> "$OUT/soak-summary.txt"
grep -oiE 'ECONNRESET|ETIMEDOUT|429|418|WS_CONNECTED|WS_DISCONNECTED|WS_ERROR|heartbeat.*timeout|unhandledRejection|Out of memory|heap out of memory' "$OUT/soak-journal.txt" 2>/dev/null | sort | uniq -c | sort -rn >> "$OUT/soak-summary.txt"
echo "--- system reboot/crash during soak ---" >> "$OUT/soak-summary.txt"
systemctl show artatrade -p NRestarts -p MainPID -p ActiveEnterTimestamp --no-pager >> "$OUT/soak-summary.txt" 2>&1
cat "$OUT/soak-summary.txt"
