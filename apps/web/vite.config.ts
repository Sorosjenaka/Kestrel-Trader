import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 4000, proxy: {
    "/api/research/swing-paper": "http://127.0.0.1:8791",
    "/api": "http://localhost:8787",
  } },
  build: {
    // 24 Okt 2026 — pemuatan cepat: pecah bundle agar browser bisa cache
    // inti (react/react-dom) terpisah dari kode aplikasi. Perubahan pada
    // satu halaman tidak memaksa operator mengunduh ulang inti.
    target: "es2020",
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        // Vite 8 (rolldown) hanya menerima bentuk fungsi untuk manualChunks.
        manualChunks(id: string) {
          if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/") || id.includes("node_modules/scheduler/")) {
            return "react";
          }
          // Tahap 1 redesign Tema B: ECharts + React Flow di chunk terpisah
          // supaya halaman yang tidak memakainya tidak ikut mengunduh.
          if (id.includes("node_modules/echarts/") || id.includes("node_modules/zrender/")) {
            return "echarts";
          }
          if (id.includes("node_modules/@xyflow/")) {
            return "xyflow";
          }
          return undefined;
        },
      },
    },
  },
});
