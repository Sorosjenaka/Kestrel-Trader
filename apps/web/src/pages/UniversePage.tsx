// apps/web/src/pages/UniversePage.tsx - Dashboard Universe & Leverage (FR-33, US-14).
// Tahap 3 redesign Tema B: tabel jadi DataTable (sortable), chip filter, KPI tetap.
import React, { useEffect, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { colors, fonts, card, cardHead } from "../theme.js";
import { PageHead, StatCell, Badge, Input, EmptyState } from "../components/ui.js";
import { DataTable } from "../components/DataTable.js";

interface SymbolRow {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  contractType: string;
  maxLeverage?: number;
  eligible?: boolean;
  eligibleReason?: string | null;
  isBlacklisted: boolean;
  blacklistReason?: string | null;
}

interface UniverseAudit {
  totalSymbols: number;
  cryptoPerpsCount: number;
  eligibleCount: number;
  nonCryptoFiltered: number;
  manualBlacklistCount: number;
  symbols: SymbolRow[];
  refreshedAt: string;
}

type FilterMode = "ALL" | "ELIGIBLE" | "BLACKLIST";

export function UniversePage() {
  const [data, setData] = useState<UniverseAudit | null>(null);
  const [search, setSearch] = useState("");
  const [filterEligible, setFilterEligible] = useState<FilterMode>("ALL");
  const [loading, setLoading] = useState(true);

  const fetchAudit = async (q = search) => {
    try {
      const url = q ? `/api/universe/audit?search=${encodeURIComponent(q)}` : "/api/universe/audit";
      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } catch (e) {
      console.error("Gagal mengambil audit universe", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAudit(search);
  }, [search]);

  if (loading && !data) {
    return <div style={{ padding: 40, textAlign: "center", color: colors.textMuted, fontSize: 12.5 }}>Memuat Universe &amp; Leverage...</div>;
  }

  const { totalSymbols, eligibleCount, nonCryptoFiltered, manualBlacklistCount, symbols, refreshedAt } = data!;

  const filteredSymbols = symbols.filter((s) => {
    if (filterEligible === "ELIGIBLE") return s.eligible;
    if (filterEligible === "BLACKLIST") return s.isBlacklisted;
    return true;
  });

  const FILTERS: { key: FilterMode; label: string; color: string; bg: string }[] = [
    { key: "ALL", label: "Semua Simbol", color: colors.textStrong, bg: colors.accentSoft },
    { key: "ELIGIBLE", label: "Hanya Lolos", color: colors.up, bg: colors.upBg },
    { key: "BLACKLIST", label: "Blacklisted", color: colors.down, bg: colors.downBg },
  ];

  const columns: ColumnDef<SymbolRow, any>[] = [
    {
      header: "Simbol",
      accessorKey: "symbol",
      cell: ({ row }) => (
        <span style={{ fontWeight: 700, color: colors.textStrong, fontFamily: fonts.mono }}>{row.original.symbol}</span>
      ),
    },
    {
      header: "Base/Quote",
      accessorFn: (r) => `${r.baseAsset}/${r.quoteAsset}`,
      cell: ({ row }) => <span style={{ color: colors.textMuted }}>{row.original.baseAsset}/{row.original.quoteAsset}</span>,
    },
    {
      header: "Kontrak",
      accessorKey: "contractType",
      cell: ({ row }) => <span style={{ color: colors.textMuted }}>{row.original.contractType}</span>,
    },
    {
      header: "Max Lev",
      accessorFn: (r) => r.maxLeverage ?? 20,
      meta: { align: "right" },
      cell: ({ row }) => (
        <span style={{ fontFamily: fonts.mono, color: colors.warn, fontWeight: 600 }}>
          {row.original.maxLeverage ?? 20}x
        </span>
      ),
    },
    {
      header: "Kelayakan",
      accessorFn: (r) => (r.isBlacklisted ? 0 : r.eligible ? 2 : 1),
      cell: ({ row }) => {
        const s = row.original;
        return s.isBlacklisted ? (
          <Badge bg={colors.downBg} fg={colors.down}>BLACKLIST</Badge>
        ) : s.eligible ? (
          <Badge bg={colors.upBg} fg={colors.up}>LOLOS</Badge>
        ) : (
          <Badge bg={colors.warnBg} fg={colors.warn}>TIDAK LOLOS</Badge>
        );
      },
    },
    {
      header: "Alasan / Status",
      accessorFn: (r) => (r.isBlacklisted ? r.blacklistReason || "Manual" : r.eligibleReason || "Normal"),
      cell: ({ row }) => {
        const s = row.original;
        return (
          <span style={{ color: colors.textMuted, fontSize: 11.5 }}>
            {s.isBlacklisted ? s.blacklistReason || "Manual" : s.eligibleReason || "Normal"}
          </span>
        );
      },
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <PageHead
        title="Universe Simbol & Plafon Leverage (FR-33, US-14)"
        desc="Pantau universe crypto-only, kelayakan likuiditas, blacklist manual, dan batas leverage efektif."
        right={
          <span style={{ fontSize: 11, fontFamily: fonts.mono, color: colors.textMuted }}>
            Pembaruan: {new Date(refreshedAt).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" })} WIB
          </span>
        }
      />

      {/* KPI Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <div style={{ ...card, padding: 12 }}>
          <StatCell label="TOTAL SIMBOL UNIVERSE" value={`${totalSymbols} Pair`} />
        </div>
        <div style={{ ...card, padding: 12 }}>
          <StatCell label="LOLOS SYARAT LIKUIDITAS" value={`${eligibleCount} Pair`} valueColor={colors.up} />
        </div>
        <div style={{ ...card, padding: 12 }}>
          <StatCell label="NON-CRYPTO TERSARING" value={`${nonCryptoFiltered} Pair`} valueColor={colors.accent} />
        </div>
        <div style={{ ...card, padding: 12 }}>
          <StatCell
            label="BLACKLIST MANUAL"
            value={`${manualBlacklistCount} Pair`}
            valueColor={manualBlacklistCount > 0 ? colors.down : colors.textMuted}
          />
        </div>
      </div>

      {/* Filter and Search */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Input
          type="text"
          placeholder="Cari simbol (mis. BTC, SOL, ETH)..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 260 }}
        />
        <div style={{ display: "flex", gap: 2, background: colors.bgInput, padding: 3, borderRadius: 2, border: `1px solid ${colors.borderLight}` }}>
          {FILTERS.map((f) => {
            const active = filterEligible === f.key;
            return (
              <button
                key={f.key}
                onClick={() => setFilterEligible(f.key)}
                style={{
                  padding: "4px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer",
                  background: active ? f.bg : "transparent",
                  color: active ? f.color : colors.textMuted,
                  border: "none", borderRadius: 2, fontFamily: fonts.main,
                }}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Symbols Table */}
      <div style={card}>
        <div style={cardHead}>
          <span>DAFTAR SIMBOL ({filteredSymbols.length})</span>
          <span style={{ fontSize: 10, color: colors.textMuted, fontWeight: 600 }}>
            MAX LEVERAGE PER SIMBOL · KLIK JUDUL KOLOM UNTUK URUTKAN
          </span>
        </div>
        {filteredSymbols.length === 0 ? (
          <EmptyState>Tidak ada simbol yang cocok dengan filter/pencarian saat ini.</EmptyState>
        ) : (
          <DataTable columns={columns} data={filteredSymbols} maxHeight={560} virtual={filteredSymbols.length > 100} />
        )}
      </div>
    </div>
  );
}