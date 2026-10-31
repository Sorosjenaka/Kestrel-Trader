import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/noto-serif-jp/latin-700.css";
import "@fontsource/noto-serif-jp/japanese-700.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ErrorBoundary } from "react-error-boundary";
import App from "./App.js";
import "./index.css";
import "./styles/tokens.css";
// 23 Okt 2026 (Tahap 8): layer desain profesional — dimuat setelah index.css
// sehingga menimpanya (token pekat, tipografi, tabel, status, aksesibilitas).
import "./pro.css";
// 23 Okt 2026 (Tahap 8): komponen + gaya panel analisis aliran pasar.
import "./pro-analysis.css";
import "./ui-polish.css";

// Tahap 1 redesign Tema B: QueryClient global untuk semua fetch halaman.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30_000),
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary
        fallbackRender={({ resetErrorBoundary }) => (
          <div role="alert" className="app-error-boundary">
            <strong>Konsol gagal dimuat</strong>
            <span>Data trading tidak diubah. Muat ulang halaman untuk mencoba lagi.</span>
            <button type="button" onClick={resetErrorBoundary}>Muat ulang konsol</button>
          </div>
        )}
        onError={(error) => {
          // Chunk gagal dimuat (deploy baru): reload sekali.
          if (/Failed to fetch dynamically imported module|Loading chunk|Importing a module script failed/i.test(error.message)) {
            const key = "arta.chunk-reload-attempted";
            if (!sessionStorage.getItem(key)) {
              sessionStorage.setItem(key, "1");
              window.location.reload();
            }
          }
        }}
      >
        <App />
      </ErrorBoundary>
    </QueryClientProvider>
  </StrictMode>,
);