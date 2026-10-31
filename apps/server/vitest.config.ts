import { defineConfig } from "vitest/config";
// Test DB URL is set by the guarded globalSetup under data/test-runs/<runId>/.
// Do not put a runtime/legacy database URL in this config.
export default defineConfig({
  test: {
    pool: "forks",
    fileParallelism: false,
    testTimeout: 10000,
    env: {
      ARTA_OFFLINE_TEST: "true",
      NODE_ENV: "test",
      BINANCE_API_KEY: "", BINANCE_API_SECRET: "", XKIRO_API_KEY: "", DREX_API_KEY: "",
      API_MUTATION_TOKEN: "", TV_WEBHOOK_SECRET: "",
      // 3 Okt 2026 — hermetic: Drex dimatikan untuk seluruh suite (env loader membaca
      // .env asli yang kini memuat DREX_API_KEY). Test yang menguji Drex mengaktifkan
      // secara eksplisit + mock fetch-nya sendiri (decisionRiskLayerDrex.test.ts).
      DREX_ENABLED: "false",
      // 11 Okt 2026 — hermetic: .env asli kini LIVE (GO LIVE), tetapi suite dijalankan
      // dalam dunia PAPER (MAX_OPEN_POSITIONS 20, tanpa gate exchange). Test jalur LIVE
      // memakai opsi injeksi (guard/gate), bukan mode global.
      BINANCE_EXECUTION_MODE: "PAPER",
      // 27 Okt 2026 — ARM_LIVE_BYPASS DIHAPUS (blocker ARM-in-LIVE dihapus
      // permanen). Pin lama dihapus bersama flagnya supaya tidak ada env
      // basi yang menyamar sebagai perilaku yang sudah tidak ada. ARM kini
      // identik di PAPER dan LIVE, jadi suite tidak perlu pin apa pun.
      // 27 Okt 2026 — hermetic: gerbang arena tesis memakai LLM; suite di-pin
      // mati (test jalur gate mengaktifkan secara eksplisit dengan mock-nya
      // sendiri). .env produksi kini memuat THESIS_ARENA_GATE_ENABLED=TRUE.
      THESIS_ARENA_GATE_ENABLED: "false",
      // 15 Okt 2026 — hermetic: verifikasi sentuhan kline paper butuh jaringan
      // Binance; suite test dilarang menyentuh jaringan (verifier dimatikan).
      PAPER_TOUCH_VERIFY: "false",
      // 15 Okt 2026 — hermetic: .env asli kini memuat PAPER_START_EQUITY_USD=40
      // (operator); test expect $200 default — pin eksplisit di suite.
      PAPER_START_EQUITY_USD: "200",
      SWING_MAX_POSITIONS: "20",
    },
    globalSetup: ["./tests/setup-test-db.ts"],
    setupFiles: ["./tests/setup-offline.ts"],
  },
});






