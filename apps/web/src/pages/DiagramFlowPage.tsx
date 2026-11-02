// apps/web/src/pages/DiagramFlowPage.tsx
//
// Diagram arsitektur & workflow interaktif berbasis React Flow (@xyflow/react).
// Semua gambar di dokumentasi publik berasal dari halaman ini (di-render ulang
// menjadi screenshot), jadi sumber kebenarannya SATU: layout di file ini.
//
// Catatan teknis: node kustom WAJIB merender <Handle> secara eksplisit.
// Pitfall yang pernah dianggap "bug React Flow" (30 Okt & 3 Nov 2026): edge
// tidak pernah tergambar TERNYATA karena tab browser berstatus hidden —
// ResizeObserver tidak pernah callback sehingga React Flow tidak pernah
// mengukur node/handle dan getEdgePosition mengembalikan null. Solusi saat
// menguji via otomasi: panggil Page.bringToFront sebelum verifikasi.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useUpdateNodeInternals,
  type EdgeChange,
  type NodeChange,
  type Edge,
  type Node,
  type NodeProps,
} from "reactflow";
import "reactflow/dist/style.css";

// ---------------------------------------------------------------- tipe & node

type C4Data = { title: string; tag: string; desc: string; accent: string; shape?: "box" | "db" | "person" | "ext" };

const card = (accent: string, radius = 12): React.CSSProperties => ({
  background: "#ffffff",
  border: `2px solid ${accent}`,
  borderRadius: radius,
  padding: "10px 14px",
  width: 230,
  boxShadow: "0 2px 8px rgba(15,23,42,0.08)",
  textAlign: "center",
  fontFamily: "inherit",
});

function C4Node({ data }: NodeProps) {
  const d = data as unknown as C4Data;
  const isDb = d.shape === "db";
  return (
    <div style={{ ...card(d.accent, isDb ? 40 : 12), position: "relative" }}>
      <Handle type="target" position={Position.Left} style={{ background: "#94a3b8", width: 10, height: 10 }} />
      <div style={{ fontWeight: 700, fontSize: 15, color: "#0f172a" }}>{d.title}</div>
      <div style={{ fontSize: 10.5, color: "#64748b", marginTop: 2 }}>{d.tag}</div>
      <div style={{ fontSize: 11, color: "#334155", marginTop: 4, lineHeight: 1.35 }}>{d.desc}</div>
      <Handle type="source" position={Position.Right} style={{ background: "#94a3b8", width: 10, height: 10 }} />
    </div>
  );
}

function PersonNode({ data }: NodeProps) {
  const d = data as unknown as C4Data;
  return (
    <div style={{ width: 150, textAlign: "center", fontFamily: "inherit" }}>
      <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#334155", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 30, margin: "0 auto 8px" }}>
        🧑‍💼
      </div>
      <div style={{ fontWeight: 700, fontSize: 15, color: "#0f172a" }}>{d.title}</div>
      <div style={{ fontSize: 10.5, color: "#64748b" }}>{d.tag}</div>
      <Handle type="source" position={Position.Right} style={{ background: "#94a3b8", width: 10, height: 10 }} />
    </div>
  );
}

const nodeTypes = { c4: C4Node, person: PersonNode };

const edgeBase = {
  markerEnd: { type: MarkerType.ArrowClosed, color: "#64748b", width: 18, height: 18 },
  labelStyle: { fontSize: 11, color: "#334155", fontFamily: "inherit" },
  labelBgStyle: { fill: "#ffffff", fillOpacity: 0.92 },
  labelBgPadding: [5, 3] as [number, number],
  labelBgBorderRadius: 4,
};

const ext = (accent = "#94a3b8") => ({ accent, shape: "ext" as const });
const blue = "#2563eb", indigo = "#4f46e5", green = "#15803d", purple = "#7c3aed", amber = "#b45309", slate = "#475569";

// ---------------------------------------------------------------- data per tampilan

const VIEWS = {
  konteks: {
    label: "Konteks",
    nodes: [
      { id: "op", type: "person", position: { x: 40, y: 220 }, data: { title: "Operator / Trader", tag: "[Orang]", accent: "#334155" } },
      { id: "sys", type: "c4", position: { x: 380, y: 210 }, data: { title: "Kestrel Trader", tag: "[Sistem Perangkat Lunak]", desc: "Sistem perdagangan otomatis Binance USDT-M Futures", accent: indigo } },
      { id: "bin", type: "c4", position: { x: 760, y: 120 }, data: { title: "Binance Futures", tag: "[Sistem Eksternal]", desc: "Data pasar realtime + eksekusi order", ...ext() } },
      { id: "ai", type: "c4", position: { x: 760, y: 330 }, data: { title: "Penyedia AI", tag: "[Sistem Eksternal]", desc: "Penilaian kandidat berbantuan AI", ...ext() } },
    ] as Node[],
    edges: [
      { id: "e1", source: "op", target: "sys", label: "memantau & mengendalikan", ...edgeBase },
      { id: "e2", source: "sys", target: "bin", label: "data pasar, order [REST/WS]", animated: true, style: { strokeDasharray: "7 5" }, ...edgeBase },
      { id: "e3", source: "sys", target: "ai", label: "penilaian AI [HTTPS]", animated: true, style: { strokeDasharray: "7 5" }, ...edgeBase },
    ] as Edge[],
  },
  wadah: {
    label: "Wadah",
    nodes: [
      { id: "op", type: "person", position: { x: 20, y: 330 }, data: { title: "Operator / Trader", tag: "[Orang]", accent: "#334155" } },
      { id: "dash", type: "c4", position: { x: 250, y: 320 }, data: { title: "Dashboard Web", tag: "[Wadah: Aplikasi Web]", desc: "KPI, grafik, log keputusan, saklar ARM", accent: indigo } },
      { id: "api", type: "c4", position: { x: 560, y: 320 }, data: { title: "Server API", tag: "[Wadah: Layanan Backend]", desc: "Orkestrasi pipeline & kendali sistem", accent: indigo } },
      { id: "db", type: "c4", position: { x: 560, y: 520 }, data: { title: "Database", tag: "[Wadah: SQLite]", desc: "Posisi, order, log keputusan", accent: slate, shape: "db" } },
      { id: "scan", type: "c4", position: { x: 900, y: 80 }, data: { title: "Scanner Pasar", tag: "[Wadah: Modul Pemindai]", desc: "Memantau ratusan pair realtime", accent: blue } },
      { id: "sig", type: "c4", position: { x: 900, y: 230 }, data: { title: "Mesin Sinyal", tag: "[Wadah: Modul Analisis]", desc: "Analisis multi-timeframe + rencana trade", accent: blue } },
      { id: "risk", type: "c4", position: { x: 900, y: 380 }, data: { title: "Gerbang Risiko", tag: "[Wadah: Modul Risiko]", desc: "Aturan deterministik, fail-closed", accent: green } },
      { id: "judge", type: "c4", position: { x: 900, y: 530 }, data: { title: "Penilai AI", tag: "[Wadah: Orkestrator AI]", desc: "Penilai setup · petugas risiko · panel tinjau", accent: purple } },
      { id: "pos", type: "c4", position: { x: 900, y: 680 }, data: { title: "Manajer Posisi", tag: "[Wadah: Modul Pengelola]", desc: "Ladder keluar, proteksi, pengawasan", accent: green } },
      { id: "bin", type: "c4", position: { x: 1260, y: 80 }, data: { title: "Binance Futures", tag: "[Sistem Eksternal]", desc: "Data pasar + order", ...ext() } },
      { id: "ai", type: "c4", position: { x: 1260, y: 530 }, data: { title: "Penyedia AI", tag: "[Sistem Eksternal]", desc: "Penilaian AI", ...ext() } },
    ] as Node[],
    edges: [
      { id: "e1", source: "op", target: "dash", label: "memantau & mengendalikan", ...edgeBase },
      { id: "e2", source: "dash", target: "api", label: "API JSON", ...edgeBase },
      { id: "e3", source: "api", target: "db", label: "baca / tulis", ...edgeBase },
      { id: "e4", source: "api", target: "scan", ...edgeBase },
      { id: "e5", source: "api", target: "sig", ...edgeBase },
      { id: "e6", source: "api", target: "risk", ...edgeBase },
      { id: "e7", source: "api", target: "judge", ...edgeBase },
      { id: "e8", source: "api", target: "pos", ...edgeBase },
      { id: "e9", source: "scan", target: "bin", label: "data pasar [REST/WS]", animated: true, style: { strokeDasharray: "7 5" }, ...edgeBase },
      { id: "e10", source: "judge", target: "ai", label: "penilaian AI [HTTPS]", animated: true, style: { strokeDasharray: "7 5" }, ...edgeBase },
      { id: "e11", source: "pos", target: "bin", label: "order & posisi [REST/WS]", animated: true, style: { strokeDasharray: "7 5" }, ...edgeBase },
    ] as Edge[],
  },
  komponen: {
    label: "Komponen",
    nodes: [
      { id: "c1", type: "c4", position: { x: 40, y: 80 }, data: { title: "Penjadwal Pemindaian", tag: "[Komponen]", desc: "Siklus scan teratur", accent: blue } },
      { id: "c2", type: "c4", position: { x: 330, y: 80 }, data: { title: "Analisis Multi-Timeframe", tag: "[Komponen]", desc: "Tren, momentum, struktur, volume", accent: blue } },
      { id: "c3", type: "c4", position: { x: 620, y: 80 }, data: { title: "Mesin Sinyal", tag: "[Komponen]", desc: "Kandidat + rencana masuk/keluar", accent: blue } },
      { id: "c4", type: "c4", position: { x: 910, y: 80 }, data: { title: "Gerbang Risiko", tag: "[Komponen]", desc: "Aturan deterministik, fail-closed", accent: green } },
      { id: "c5", type: "c4", position: { x: 910, y: 320 }, data: { title: "Orkestrator Penilaian AI", tag: "[Komponen]", desc: "Menyusun panel penilai AI", accent: purple } },
      { id: "c6", type: "c4", position: { x: 620, y: 320 }, data: { title: "Eksekutor Order", tag: "[Komponen]", desc: "Simulasi / nyata (terkunci)", accent: amber } },
      { id: "c7", type: "c4", position: { x: 330, y: 320 }, data: { title: "Pengawas Posisi", tag: "[Komponen]", desc: "Ladder keluar + proteksi", accent: green } },
      { id: "c8", type: "c4", position: { x: 40, y: 320 }, data: { title: "Modul Pembelajaran", tag: "[Komponen]", desc: "Evaluasi hasil + backtest", accent: slate } },
      { id: "log", type: "c4", position: { x: 1220, y: 200 }, data: { title: "Log & DB", tag: "[SQLite]", desc: "Jejak audit keputusan", accent: slate, shape: "db" } },
    ] as Node[],
    edges: [
      { id: "e1", source: "c1", target: "c2", ...edgeBase },
      { id: "e2", source: "c2", target: "c3", ...edgeBase },
      { id: "e3", source: "c3", target: "c4", ...edgeBase },
      { id: "e4", source: "c4", target: "c5", label: "kandidat lolos semua gerbang", ...edgeBase },
      { id: "e5", source: "c5", target: "c6", ...edgeBase },
      { id: "e6", source: "c6", target: "c7", ...edgeBase },
      { id: "e7", source: "c7", target: "c8", ...edgeBase },
      { id: "e8", source: "c8", target: "log", label: "catat keputusan", style: { strokeDasharray: "7 5" }, ...edgeBase },
    ] as Edge[],
  },
  workflow: {
    label: "Workflow",
    nodes: [
      { id: "w1", type: "c4", position: { x: 20, y: 180 }, data: { title: "Pasar Realtime", tag: "[Data]", desc: "Harga & volume terkini", ...ext() } },
      { id: "w2", type: "c4", position: { x: 300, y: 180 }, data: { title: "Scanner", tag: "[Pemindaian]", desc: "Ratusan pair dipantau", accent: blue } },
      { id: "w3", type: "c4", position: { x: 580, y: 180 }, data: { title: "Analisis Multi-Timeframe", tag: "[Analisis]", desc: "Tren, momentum, struktur, volume", accent: blue } },
      { id: "w4", type: "c4", position: { x: 860, y: 180 }, data: { title: "Mesin Sinyal", tag: "[Sinyal]", desc: "Kandidat + rencana trade", accent: blue } },
      { id: "w5", type: "c4", position: { x: 1140, y: 180 }, data: { title: "Gerbang Risiko", tag: "[Risiko]", desc: "Aturan deterministik", accent: green } },
      { id: "w6", type: "c4", position: { x: 1140, y: 420 }, data: { title: "Penilai AI", tag: "[Penilaian]", desc: "Berlapis, fail-closed", accent: purple } },
      { id: "w7", type: "c4", position: { x: 860, y: 420 }, data: { title: "Eksekusi", tag: "[Order]", desc: "Simulasi / nyata (terkunci)", accent: amber } },
      { id: "w8", type: "c4", position: { x: 580, y: 420 }, data: { title: "Manajemen Posisi", tag: "[Posisi]", desc: "Ladder keluar + proteksi", accent: green } },
      { id: "w9", type: "c4", position: { x: 300, y: 420 }, data: { title: "Siklus Belajar", tag: "[Pembelajaran]", desc: "Evaluasi + backtest", accent: slate } },
    ] as Node[],
    edges: [
      { id: "e1", source: "w1", target: "w2", ...edgeBase },
      { id: "e2", source: "w2", target: "w3", ...edgeBase },
      { id: "e3", source: "w3", target: "w4", ...edgeBase },
      { id: "e4", source: "w4", target: "w5", ...edgeBase },
      { id: "e5", source: "w5", target: "w6", label: "lolos", ...edgeBase },
      { id: "e6", source: "w6", target: "w7", label: "disetujui", ...edgeBase },
      { id: "e7", source: "w7", target: "w8", ...edgeBase },
      { id: "e8", source: "w8", target: "w9", ...edgeBase },
      { id: "e9", source: "w9", target: "w3", label: "perbaikan berkelanjutan", animated: true, style: { strokeDasharray: "7 5" }, ...edgeBase },
    ] as Edge[],
  },
} as const;

type ViewKey = keyof typeof VIEWS;

// ---------------------------------------------------------------- halaman

export function DiagramFlowPage() {
  const [view, setView] = useState<ViewKey>("konteks");
  const nodes = VIEWS[view].nodes as unknown as Node[];
  const edges = VIEWS[view].edges as unknown as Edge[];
  // updateNodeInternals dipanggil dari dalam FlowInner (ReactFlowProvider).
  const proOptions = useMemo(() => ({ hideAttribution: true }), []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 64px)", background: "#f8fafc" }}>
      <div style={{ display: "flex", gap: 8, padding: "14px 18px 6px", alignItems: "center", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 18, color: "#0f172a" }}>Diagram Sistem — React Flow</h2>
        <span style={{ fontSize: 12, color: "#64748b" }}>geser node · zoom · drag kanvas — sumber gambar dokumentasi</span>
        <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
          {(Object.keys(VIEWS) as ViewKey[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                padding: "7px 16px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600,
                border: view === v ? "1.5px solid #4f46e5" : "1.5px solid #cbd5e1",
                background: view === v ? "#e0e7ff" : "#ffffff", color: view === v ? "#3730a3" : "#475569",
              }}
            >
              {VIEWS[v].label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, margin: "8px 14px 14px", borderRadius: 14, overflow: "hidden", border: "1px solid #e2e8f0" }}>
        <DiagramCanvas key={view} initialNodes={nodes} initialEdges={edges} proOptions={proOptions} />
      </div>
    </div>
  );
}

// Node/edge dikelola sebagai state terkontrol + updateNodeInternals sekali
// setelah mount. Lihat catatan di atas file ini: "edge tidak tergambar" pada
// pengujian otomatis TERNYATA karena tab browser hidden (ResizeObserver tidak
// pernah callback), bukan kerusakan React Flow.
function DiagramCanvas({ initialNodes, initialEdges, proOptions }: { initialNodes: Node[]; initialEdges: Edge[]; proOptions: { hideAttribution: boolean } }) {
  return (
    <ReactFlowProvider>
      <FlowInner initialNodes={initialNodes} initialEdges={initialEdges} proOptions={proOptions} />
    </ReactFlowProvider>
  );
}

// Semua hook React Flow berada DI DALAM ReactFlowProvider (error #001 jika di
// luar). updateNodeInternals dipanggil sekali 60 ms setelah mount untuk
// memaksa pengukuran ulang handle (edge bergantung pada handleBounds).
function FlowInner({ initialNodes, initialEdges, proOptions }: { initialNodes: Node[]; initialEdges: Edge[]; proOptions: { hideAttribution: boolean } }) {
  const [nodes, setNodes] = useState<Node[]>(initialNodes);
  const [edges, setEdges] = useState<Edge[]>(initialEdges);
  const onNodesChange = useCallback((chs: NodeChange[]) => setNodes((ns) => applyNodeChanges(chs, ns)), []);
  const onEdgesChange = useCallback((chs: EdgeChange[]) => setEdges((es) => applyEdgeChanges(chs, es)), []);
  const updateNodeInternals = useUpdateNodeInternals();
  const ids = initialNodes.map((n) => n.id).join(",");
  useEffect(() => {
    // Pengukuran ulang handle setelah mount (800 & 1800 ms) — edge bergantung
    // pada handleBounds. Dipanggil terlambat agar tidak bersaing dengan proses
    // pengukuran awal React Flow.
    const t1 = setTimeout(() => updateNodeInternals(ids.split(",")), 800);
    const t2 = setTimeout(() => updateNodeInternals(ids.split(",")), 1800);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [ids, updateNodeInternals]);
  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
      minZoom={0.25}
      proOptions={proOptions}
    >
      <Background color="#cbd5e1" gap={22} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeColor={(n) => ((n.data as unknown as C4Data)?.accent ?? "#94a3b8")} />
      </ReactFlow>
    </>
  );
}



