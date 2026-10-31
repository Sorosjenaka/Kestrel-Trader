#!/usr/bin/env bash
# tools/vault-sync.sh — Sinkronisasi vault: commit perubahan lokal, pull memory dari laptop, export DB→MD, push ke GitHub.
# Dipanggil systemd timer per jam (artatrade-vault-sync.timer) atau manual: ./tools/vault-sync.sh
set -uo pipefail

REPO="${VAULT_REPO:-/opt/kestrel}"
REMOTE="${VAULT_REMOTE:-origin}"
BRANCH="${VAULT_BRANCH:-main}"
cd "$REPO" || exit 1

# Cegah run tumpuk-tindih
exec 9>/tmp/artatrade-vault-sync.lock
flock -n 9 || { echo "[vault-sync] masih berjalan, skip"; exit 0; }

echo "[vault-sync] mulai $(date -u +%F_%H:%M:%S)Z"

# 1) Export DB → markdown (read-only terhadap DB)
node tools/export-vault.mjs || echo "[vault-sync] export gagal (DB sibuk?), lanjut"

# 2) Commit perubahan lokal (vault/ + tooling terkait)
git add vault/ 2>/dev/null
if ! git diff --cached --quiet; then
  git commit -q -m "vault: auto-sync $(date -u +%F_%H:%M:%S)Z"
  echo "[vault-sync] commit lokal dibuat"
fi

# 3) Pull perubahan memory dari laptop (rebase + autostash agar aman)
if git fetch -q "$REMOTE" "$BRANCH" 2>/dev/null; then
  if ! git merge --ff-only "FETCH_HEAD" 2>/dev/null; then
    if ! git -c rebase.autoStash=true rebase -q "FETCH_HEAD" 2>/dev/null; then
      echo "[vault-sync] konflik saat pull — abort, biarkan manual"
      git rebase --abort 2>/dev/null
    fi
  fi
else
  echo "[vault-sync] fetch gagal (offline/remote belum diset) — lanjut tanpa pull"
fi

# 4) Push jika ada remote & ada yang bisa didorong
if git remote get-url "$REMOTE" >/dev/null 2>&1; then
  if ! git push -q "$REMOTE" "$BRANCH" 2>&1; then
    echo "[vault-sync] push gagal (akses?), akan dicoba lagi pada siklus berikutnya"
  else
    echo "[vault-sync] push OK"
  fi
else
  echo "[vault-sync] remote '$REMOTE' belum dikonfigurasi — commit lokal tersimpan, push ditunda"
fi

echo "[vault-sync] selesai $(date -u +%F_%H:%M:%S)Z"
