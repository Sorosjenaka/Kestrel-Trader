// apps/web/src/components/DataTable.tsx
// Wrapper TanStack Table + Virtual untuk tabel sortable/virtual Tema B.
// Dipakai di tahap 3 redesign untuk menggantikan tabel manual.
import React, { useMemo, useRef, useState } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type RowData,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { colors, fonts } from "../theme.js";

declare module "@tanstack/react-table" {
  interface ColumnMeta<TData extends RowData, TValue> {
    align?: "left" | "right" | "center";
    width?: number;
  }
}

type Props<T> = {
  columns: ColumnDef<T, any>[];
  data: T[];
  /** Aktifkan virtualisasi jika baris bisa > 100. */
  virtual?: boolean;
  maxHeight?: number;
  emptyText?: string;
  onRowClick?: (row: T) => void;
  /** Estimasi tinggi baris untuk virtualizer. */
  estimateRowHeight?: number;
};

export function DataTable<T>({
  columns,
  data,
  virtual = false,
  maxHeight = 460,
  emptyText = "Tidak ada data.",
  onRowClick,
  estimateRowHeight = 31,
}: Props<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const parentRef = useRef<HTMLDivElement>(null);
  const rows = table.getRowModel().rows;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateRowHeight,
    overscan: 8,
    enabled: virtual,
  });

  const headerGroups = table.getHeaderGroups();
  const virtualItems = virtual ? virtualizer.getVirtualItems() : [];
  const padTop = virtualItems.length > 0 ? virtualItems[0]!.start : 0;
  const padBottom = virtualItems.length > 0 ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1]!.end : 0;
  const colCount = columns.length;

  return (
    <div
      ref={virtual ? parentRef : undefined}
      style={{ overflow: "auto", maxHeight, width: "100%" }}
    >
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: fonts.mono }}>
        <thead>
          {headerGroups.map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => {
                const meta = h.column.columnDef.meta;
                const sortDir = h.column.getIsSorted();
                const canSort = h.column.getCanSort();
                return (
                  <th
                    key={h.id}
                    onClick={canSort ? h.column.getToggleSortingHandler() : undefined}
                    style={{
                      padding: "7px 10px",
                      textAlign: meta?.align ?? "left",
                      color: colors.textDim,
                      fontWeight: 500,
                      fontSize: 9.5,
                      letterSpacing: "0.12em",
                      borderBottom: `1px solid ${colors.border}`,
                      whiteSpace: "nowrap",
                      textTransform: "uppercase",
                      cursor: canSort ? "pointer" : undefined,
                      userSelect: "none",
                    }}
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {sortDir === "asc" && " ▲"}
                    {sortDir === "desc" && " ▼"}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {padTop > 0 && (
            <tr><td colSpan={colCount} style={{ height: padTop, padding: 0, border: 0 }} /></tr>
          )}
          {(virtual ? virtualItems : rows.map((_, i) => ({ index: i }))).map((item) => {
            const row = rows[(item as any).index ?? (item as any)];
            if (!row) return null;
            return (
              <tr
                key={row.id}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                style={{ cursor: onRowClick ? "pointer" : undefined }}
              >
                {row.getVisibleCells().map((cell) => {
                  const meta = cell.column.columnDef.meta;
                  return (
                    <td
                      key={cell.id}
                      style={{
                        padding: "7px 10px",
                        borderBottom: `1px solid ${colors.border}`,
                        whiteSpace: "nowrap",
                        color: colors.text,
                        textAlign: meta?.align ?? "left",
                        fontSize: 11,
                      }}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {padBottom > 0 && (
            <tr><td colSpan={colCount} style={{ height: padBottom, padding: 0, border: 0 }} /></tr>
          )}
          {rows.length === 0 && (
            <tr>
              <td colSpan={colCount} style={{ padding: 20, textAlign: "center", color: colors.textMuted }}>
                {emptyText}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}