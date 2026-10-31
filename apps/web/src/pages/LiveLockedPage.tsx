import React from "react";

/** Deliberately makes no network request. The shell must never poll a private
 * account/mirror endpoint just because a stale LIVE deep link was opened. */
export function LiveLockedPage() {
  return (
    <div className="page live-locked-page">
      <div className="page-head">
        <div>
          <div className="eyebrow">SYSTEM / LIVE</div>
          <h1>LIVE: akses dinonaktifkan pada workspace ini</h1>
          <p className="page-sub">Route ini tidak membuka akun, saldo, posisi, atau endpoint privat. PAPER tetap menjadi mode eksekusi workspace.</p>
        </div>
      </div>
      <div className="panel" style={{ padding: 16, maxWidth: 680 }}>
        <div className="mono tiny" style={{ color: "var(--accent-lime, #3AA8F2)", letterSpacing: ".08em" }}>SAFETY INTERLOCK</div>
        <p style={{ fontSize: 13, lineHeight: 1.6, color: "var(--text-muted, #b0b7c5)", marginTop: 8 }}>
          Tidak ada tombol ARM LIVE, enable LIVE, close/bulk close, reset saldo, atau akses exchange di halaman ini.
          Status LIVE tidak dapat disimpulkan dari kegagalan request: bila sumber status tidak tersedia, hasilnya <b>UNKNOWN</b>.
        </p>
        <a className="btn" href="#/terminal">Kembali ke Terminal PAPER</a>
      </div>
    </div>
  );
}
