// tools/private-rooms-preview.ts
// Render kanvas "12 Kamar Kerja Pribadi Agen" menjadi PNG TANPA browser/dependency:
// merekam semua panggilan CanvasRenderingContext2D dari drawRoomFrame(), merasterkannya
// (fillRect/polygon/ellipse/line + gradient), lalu meng-encode PNG lewat zlib Node.
// Teks tidak di-rasterkan (hanya kontur/posisi layout yang divalidasi visual).
// Jalankan: npx tsx tools/private-rooms-preview.ts
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  OFFICE_AGENTS,
  ROOM_DECOR,
  ROOM_GRID,
  drawRoomFrame,
  spawnEntity,
  type OfficeMode,
  type RoomEntity,
} from "../apps/web/src/components/AgentOfficeCanvas";

type RGBA = [number, number, number, number];

function parseColor(c: unknown): RGBA {
  if (typeof c !== "string") {
    if (c && typeof c === "object" && "stops" in (c as object)) return [255, 0, 255, 255];
    return [255, 0, 255, 255];
  }
  const s = c.trim();
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      return [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16), 255];
    }
    if (hex.length >= 6) {
      return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 255];
    }
  }
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const parts = m[1].split(",").map((p) => parseFloat(p.trim()));
    return [parts[0] | 0, parts[1] | 0, parts[2] | 0, parts.length > 3 ? Math.round(parts[3] * 255) : 255];
  }
  if (s === "transparent") return [0, 0, 0, 0];
  return [255, 0, 255, 255];
}

interface Gradient {
  stops: { offset: number; color: RGBA }[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  isRadial: boolean;
}

class Raster {
  w: number;
  h: number;
  buf: Uint8ClampedArray;
  /** Transformasi skala+translasi (device = user * s + o). */
  sx = 1;
  sy = 1;
  ox = 0;
  oy = 0;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.buf = new Uint8ClampedArray(w * h * 4);
  }

  blend(x: number, y: number, col: RGBA, alphaMul = 1) {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return;
    const a = (col[3] / 255) * alphaMul;
    if (a <= 0) return;
    const i = (yi * this.w + xi) * 4;
    const b = this.buf;
    b[i] = col[0] * a + b[i] * (1 - a);
    b[i + 1] = col[1] * a + b[i + 1] * (1 - a);
    b[i + 2] = col[2] * a + b[i + 2] * (1 - a);
    b[i + 3] = Math.max(b[i + 3], Math.round(255 * a));
  }

  resolve(style: unknown, x: number, y: number): RGBA {
    if (style && typeof style === "object" && "stops" in (style as object)) {
      const g = style as Gradient;
      if (!g.stops.length) return [255, 0, 255, 255];
      const sorted = [...g.stops].sort((a, b) => a.offset - b.offset);
      let t: number;
      if (g.isRadial) {
        const r = Math.hypot(g.x1 - g.x0, g.y1 - g.y0) || 1;
        t = Math.hypot(x - g.x0, y - g.y0) / r;
      } else {
        const dx = g.x1 - g.x0;
        const dy = g.y1 - g.y0;
        const len2 = dx * dx + dy * dy || 1;
        t = ((x - g.x0) * dx + (y - g.y0) * dy) / len2;
      }
      t = Math.max(0, Math.min(1, t));
      let lo = sorted[0];
      let hi = sorted[sorted.length - 1];
      for (let i = 0; i < sorted.length - 1; i++) {
        if (t >= sorted[i].offset && t <= sorted[i + 1].offset) {
          lo = sorted[i];
          hi = sorted[i + 1];
          break;
        }
      }
      const span = hi.offset - lo.offset || 1;
      const k = (t - lo.offset) / span;
      return [
        lo.color[0] + (hi.color[0] - lo.color[0]) * k,
        lo.color[1] + (hi.color[1] - lo.color[1]) * k,
        lo.color[2] + (hi.color[2] - lo.color[2]) * k,
        lo.color[3] + (hi.color[3] - lo.color[3]) * k,
      ];
    }
    return parseColor(style);
  }
}

/** Encode RGBA buffer menjadi PNG 24-bit (truecolor, filter 0). */
function encodePng(raster: Raster): Buffer {
  const { w, h, buf } = raster;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = buf[i + 3] / 255;
      // komposit di atas latar gelap
      raw[o++] = Math.round(buf[i] * a + 15 * (1 - a));
      raw[o++] = Math.round(buf[i + 1] * a + 12 * (1 - a));
      raw[o++] = Math.round(buf[i + 2] * a + 10 * (1 - a));
    }
  }
  const table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (b: Buffer) => {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

interface ClipRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const inside = (c: ClipRect | null, x: number, y: number) => !c || (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h);

function fillRectRaw(r: Raster, x: number, y: number, w: number, h: number, style: unknown, alpha: number, clip: ClipRect | null) {
  const dx0 = x * r.sx + r.ox;
  const dy0 = y * r.sy + r.oy;
  const dw = w * r.sx;
  const dh = h * r.sy;
  const x0 = Math.max(0, Math.floor(Math.min(dx0, dx0 + dw)));
  const x1 = Math.min(r.w - 1, Math.ceil(Math.max(dx0, dx0 + dw)));
  const y0 = Math.max(0, Math.floor(Math.min(dy0, dy0 + dh)));
  const y1 = Math.min(r.h - 1, Math.ceil(Math.max(dy0, dy0 + dh)));
  for (let py = y0; py <= y1; py++) {
    for (let pxi = x0; pxi <= x1; pxi++) {
      if (!inside(clip, pxi, py)) continue;
      r.blend(pxi, py, r.resolve(style, (pxi - r.ox) / r.sx, (py - r.oy) / r.sy), alpha);
    }
  }
}

function fillEllipseRaw(r: Raster, ex: number, ey: number, rx: number, ry: number, style: unknown, alpha: number, clip: ClipRect | null) {
  const dex = ex * r.sx + r.ox;
  const dey = ey * r.sy + r.oy;
  const drx = rx * r.sx;
  const dry = ry * r.sy;
  const x0 = Math.max(0, Math.floor(dex - drx));
  const x1 = Math.min(r.w - 1, Math.ceil(dex + drx));
  const y0 = Math.max(0, Math.floor(dey - dry));
  const y1 = Math.min(r.h - 1, Math.ceil(dey + dry));
  for (let py = y0; py <= y1; py++) {
    for (let pxi = x0; pxi <= x1; pxi++) {
      const nx = (pxi - dex) / (drx || 1);
      const ny = (py - dey) / (dry || 1);
      if (nx * nx + ny * ny > 1) continue;
      if (!inside(clip, pxi, py)) continue;
      r.blend(pxi, py, r.resolve(style, (pxi - r.ox) / r.sx, (py - r.oy) / r.sy), alpha);
    }
  }
}

function fillPolygonRaw(r: Raster, pts0: [number, number][], style: unknown, alpha: number, clip: ClipRect | null) {
  const pts: [number, number][] = pts0.map(([x, y]) => [x * r.sx + r.ox, y * r.sy + r.oy]);
  if (pts.length < 3) return;
  const ys = pts.map((p) => p[1]);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(r.h - 1, Math.ceil(Math.max(...ys)));
  const xs = pts.map((p) => p[0]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(r.w - 1, Math.ceil(Math.max(...xs)));
  for (let py = y0; py <= y1; py++) {
    const crossings: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if (a[1] === b[1]) continue;
      const ymin = Math.min(a[1], b[1]);
      const ymax = Math.max(a[1], b[1]);
      if (py + 0.5 < ymin || py + 0.5 >= ymax) continue;
      crossings.push(a[0] + ((py + 0.5 - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    crossings.sort((m, n) => m - n);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const sx = Math.max(x0, Math.ceil(crossings[i]));
      const ex = Math.min(x1, Math.floor(crossings[i + 1]));
      for (let pxi = sx; pxi <= ex; pxi++) {
        if (!inside(clip, pxi, py)) continue;
        r.blend(pxi, py, r.resolve(style, (pxi - r.ox) / r.sx, (py - r.oy) / r.sy), alpha);
      }
    }
  }
}

function strokePolylineRaw(
  r: Raster,
  pts0: [number, number][],
  closed: boolean,
  width: number,
  style: unknown,
  alpha: number,
  clip: ClipRect | null
) {
  if (pts0.length < 2) return;
  const pts: [number, number][] = pts0.map(([x, y]) => [x * r.sx + r.ox, y * r.sy + r.oy]);
  const segs: [number, number][][] = [];
  for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i], pts[i + 1]]);
  if (closed) segs.push([pts[pts.length - 1], pts[0]]);
  const half = Math.max(0.5, (width * r.sx) / 2);
  for (const [a, b] of segs) {
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0]) - half - 1));
    const x1 = Math.min(r.w - 1, Math.ceil(Math.max(a[0], b[0]) + half + 1));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1]) - half - 1));
    const y1 = Math.min(r.h - 1, Math.ceil(Math.max(a[1], b[1]) + half + 1));
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy || 1;
    for (let py = y0; py <= y1; py++) {
      for (let pxi = x0; pxi <= x1; pxi++) {
        let t = ((pxi - a[0]) * vx + (py - a[1]) * vy) / len2;
        t = Math.max(0, Math.min(1, t));
        const dx = pxi - (a[0] + t * vx);
        const dy = py - (a[1] + t * vy);
        if (dx * dx + dy * dy > half * half) continue;
        if (!inside(clip, pxi, py)) continue;
        r.blend(pxi, py, r.resolve(style, (pxi - r.ox) / r.sx, (py - r.oy) / r.sy), alpha);
      }
    }
  }
}

interface PathState {
  kind: "none" | "poly" | "ellipse";
  pts: [number, number][];
  ell: { x: number; y: number; rx: number; ry: number } | null;
  closed: boolean;
}

/** Emulator CanvasRenderingContext2D yang meraster ke Raster (teks dilewati). */
function createPreviewContext(r: Raster) {
  let fillStyle: unknown = "#000000";
  let strokeStyle: unknown = "#000000";
  let lineWidth = 1;
  let globalAlpha = 1;
  let clipRect: ClipRect | null = null;
  const stack: { clipRect: ClipRect | null; fillStyle: unknown; strokeStyle: unknown; lineWidth: number; globalAlpha: number; sx: number; sy: number; ox: number; oy: number }[] = [];
  let p: PathState = { kind: "none", pts: [], ell: null, closed: false };
  let lastPt: [number, number] = [0, 0];
  let lastRect: ClipRect | null = null;

  const gradient = (x0: number, y0: number, x1: number, y1: number, isRadial: boolean) => ({
    stops: [] as { offset: number; color: RGBA }[],
    x0,
    y0,
    x1,
    y1,
    isRadial,
    addColorStop(this: { stops: { offset: number; color: RGBA }[] }, offset: number, color: string) {
      this.stops.push({ offset, color: parseColor(color) });
    },
  });

  const ctx: Record<string, unknown> = {
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    imageSmoothingEnabled: false,
    save() {
      stack.push({ clipRect, fillStyle, strokeStyle, lineWidth, globalAlpha, sx: r.sx, sy: r.sy, ox: r.ox, oy: r.oy });
    },
    restore() {
      const s = stack.pop();
      if (!s) return;
      clipRect = s.clipRect;
      fillStyle = s.fillStyle;
      strokeStyle = s.strokeStyle;
      lineWidth = s.lineWidth;
      globalAlpha = s.globalAlpha;
      r.sx = s.sx;
      r.sy = s.sy;
      r.ox = s.ox;
      r.oy = s.oy;
    },
    beginPath() {
      p = { kind: "none", pts: [], ell: null, closed: false };
      lastRect = null;
    },
    closePath() {
      p.closed = true;
    },
    moveTo(x: number, y: number) {
      p.kind = "poly";
      p.pts.push([x, y]);
      lastPt = [x, y];
    },
    lineTo(x: number, y: number) {
      if (p.kind !== "ellipse") p.kind = "poly";
      p.pts.push([x, y]);
      lastPt = [x, y];
    },
    quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
      const [x0, y0] = lastPt;
      p.kind = "poly";
      for (let i = 1; i <= 8; i++) {
        const t = i / 8;
        const mt = 1 - t;
        p.pts.push([mt * mt * x0 + 2 * mt * t * cx + t * t * x, mt * mt * y0 + 2 * mt * t * cy + t * t * y]);
      }
      lastPt = [x, y];
    },
    rect(x: number, y: number, w: number, h: number) {
      p.kind = "poly";
      p.pts.push([x, y], [x + w, y], [x + w, y + h], [x, y + h]);
      p.closed = true;
      lastRect = { x, y, w, h };
    },
    arc(x: number, y: number, radius: number) {
      p.kind = "ellipse";
      p.ell = { x, y, rx: radius, ry: radius };
      p.closed = true;
    },
    ellipse(x: number, y: number, rx: number, ry: number) {
      p.kind = "ellipse";
      p.ell = { x, y, rx, ry };
      p.closed = true;
    },
    clip() {
      if (lastRect) {
        clipRect = {
          x: lastRect.x * r.sx + r.ox,
          y: lastRect.y * r.sy + r.oy,
          w: lastRect.w * r.sx,
          h: lastRect.h * r.sy,
        };
      }
    },
    fill() {
      if (p.kind === "ellipse" && p.ell) fillEllipseRaw(r, p.ell.x, p.ell.y, p.ell.rx, p.ell.ry, fillStyle, globalAlpha, clipRect);
      else fillPolygonRaw(r, p.pts, fillStyle, globalAlpha, clipRect);
    },
    stroke() {
      strokePolylineRaw(r, p.pts, p.closed, lineWidth, strokeStyle, globalAlpha, clipRect);
    },
    fillRect(x: number, y: number, w: number, h: number) {
      fillRectRaw(r, x, y, w, h, fillStyle, globalAlpha, clipRect);
    },
    strokeRect(x: number, y: number, w: number, h: number) {
      strokePolylineRaw(r, [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true, lineWidth, strokeStyle, globalAlpha, clipRect);
    },
    clearRect() {},
    fillText() {},
    strokeText() {},
    measureText: (t: string) => ({ width: String(t).length * 5.4 }),
    createLinearGradient: (x0: number, y0: number, x1: number, y1: number) => gradient(x0, y0, x1, y1, false),
    createRadialGradient: (x0: number, y0: number, x1: number, y1: number) => gradient(x0, y0, x1, y1, true),
    translate(x: number, y: number) {
      r.ox += x * r.sx;
      r.oy += y * r.sy;
    },
    rotate() {},
    scale(x: number, y: number) {
      r.sx *= x;
      r.sy *= y;
    },
    setLineDash() {},
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
  Object.defineProperty(ctx, "fillStyle", { get: () => fillStyle, set: (v) => (fillStyle = v), enumerable: true });
  Object.defineProperty(ctx, "strokeStyle", { get: () => strokeStyle, set: (v) => (strokeStyle = v), enumerable: true });
  Object.defineProperty(ctx, "lineWidth", { get: () => lineWidth, set: (v) => (lineWidth = v), enumerable: true });
  Object.defineProperty(ctx, "globalAlpha", { get: () => globalAlpha, set: (v) => (globalAlpha = v), enumerable: true });
  return ctx as unknown as CanvasRenderingContext2D;
}

/** Emulator no-op (mempercepat simulasi banyak frame tanpa rasterisasi). */
function createNoopContext(): CanvasRenderingContext2D {
  const noop = () => {};
  const ctx: Record<string, unknown> = {
    measureText: (t: string) => ({ width: String(t).length * 5.4 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    save: noop, restore: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    quadraticCurveTo: noop, rect: noop, arc: noop, ellipse: noop, clip: noop, fill: noop, stroke: noop,
    fillRect: noop, strokeRect: noop, clearRect: noop, fillText: noop, strokeText: noop,
    translate: noop, rotate: noop, scale: noop, setLineDash: noop,
    fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, globalAlpha: 1,
    font: "", textAlign: "left", textBaseline: "alphabetic", imageSmoothingEnabled: false,
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

/** Render zoom satu kamar (skala 2x) agar detail furnitur bisa diperiksa visual. */
function renderZoomedRoom(outDir: string, index: number, mode: OfficeMode, restMode: boolean, frames: number) {
  const entities = OFFICE_AGENTS.map((p, i) => spawnEntity(p, i));
  const liveTexts = new Map<string, string>();
  const frameOpts = {
    restMode,
    mode,
    speed: "FAST" as const,
    openSlots: 9,
    totalSlots: 20,
    selectedAgentId: undefined,
    hoveredAgentId: null,
    liveTexts,
  };
  const noop = createNoopContext();
  let time = 0;
  for (let i = 0; i < frames; i++) {
    time += 16.6;
    drawRoomFrame(noop, time, 1, entities, frameOpts);
  }

  const scale = 2;
  const raster = new Raster(ROOM_GRID.ROOM_W * scale, ROOM_GRID.ROOM_H * scale);
  const room = entities[index].decor;
  raster.sx = scale;
  raster.sy = scale;
  raster.ox = -room.rx * scale;
  raster.oy = -room.ry * scale;
  drawRoomFrame(createPreviewContext(raster), time + 16.6, 1, entities, frameOpts);

  const label = `${String(index + 1).padStart(2, "0")}-${entities[index].profile.id}`;
  const file = path.join(outDir, `kamar-${label}.png`);
  fs.writeFileSync(file, encodePng(raster));
  return { file, status: entities[index].status };
}

/** Baca warna piksel hasil raster (device space). */
function pixelAt(r: Raster, x: number, y: number): RGBA {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= r.w || yi >= r.h) return [0, 0, 0, 0];
  const i = (yi * r.w + xi) * 4;
  return [r.buf[i], r.buf[i + 1], r.buf[i + 2], r.buf[i + 3]];
}

type Family = "kayu" | "abu" | "kuning" | "maroon" | "layar-gelap" | "hijau" | "krem" | "warna-rug";

function matchesFamily(c: RGBA, fam: Family): boolean {
  const [r, g, b] = c;
  switch (fam) {
    case "kayu":
      return r > 95 && r > g + 12 && g >= b;
    case "abu":
      return Math.abs(r - g) < 26 && Math.abs(g - b) < 26 && r > 70 && r < 205;
    case "kuning":
      return r > 190 && g > 140 && b < 130;
    case "maroon":
      return r > 80 && r < 175 && g < 95 && b < 105;
    case "layar-gelap":
      return r < 45 && g < 55 && b < 75;
    case "hijau":
      return g > r + 15 && g > b + 15;
    case "krem":
      return r > 200 && g > 195 && b > 175;
    case "warna-rug":
      return Math.max(r, g, b) - Math.min(r, g, b) > 40 || (r > 190 && g > 180);
  }
}

/** Probe piksel penting di kamar index (koordinat lokal) untuk memastikan furnitur tidak tertutup. */
function probeRoom(r: Raster, index: number, probes: { lx: number; ly: number; fam: Family; label: string }[]) {
  const d = ROOM_DECOR[index];
  const out: string[] = [];
  let ok = true;
  for (const p of probes) {
    const c = pixelAt(r, d.rx + p.lx, d.ry + p.ly);
    const pass = matchesFamily(c, p.fam);
    if (!pass) ok = false;
    out.push(`${pass ? "ok" : "X"} ${p.label} rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`);
  }
  return { ok, detail: out.join(" | ") };
}

interface SceneOptions {
  mode: OfficeMode;
  restMode: boolean;
  openSlots: number;
  frames: number;
  bubbleAgentIndex?: number;
  freezeAgents?: boolean;
}

function renderScene(name: string, outDir: string, opts: SceneOptions) {
  const entities = OFFICE_AGENTS.map((p, i) => spawnEntity(p, i));
  const liveTexts = new Map<string, string>([["setup-judge", "Skor 86 confluences lolos; verifikasi FVG tuntas."]]);
  const frameOpts = {
    restMode: opts.restMode,
    mode: opts.mode,
    speed: "FAST" as const,
    openSlots: opts.openSlots,
    totalSlots: 20,
    selectedAgentId: "setup-judge",
    hoveredAgentId: "risk-officer",
    liveTexts,
    freeze: opts.freezeAgents ?? false,
  };

  // Simulasi pergerakan agen dengan konteks no-op (cepat), lalu raster frame terakhir.
  const noop = createNoopContext();
  let time = 0;
  for (let i = 0; i < opts.frames; i++) {
    time += 16.6;
    drawRoomFrame(noop, time, 1, entities, frameOpts);
  }
  if (opts.bubbleAgentIndex !== undefined) {
    entities[opts.bubbleAgentIndex].bubbleText = "Uji balon ucapan live dari LLM";
    entities[opts.bubbleAgentIndex].bubbleTimer = 400;
  }

  const raster = new Raster(ROOM_GRID.CANVAS_W, ROOM_GRID.CANVAS_H);
  drawRoomFrame(createPreviewContext(raster), time + 16.6, 1, entities, frameOpts);

  const file = path.join(outDir, `${name}.png`);
  fs.writeFileSync(file, encodePng(raster));
  return { file, entities, raster };
}

function main() {
  const outDir = path.resolve("data/agent-rooms-preview");
  fs.mkdirSync(outDir, { recursive: true });

  const scenes: { name: string; opts: SceneOptions }[] = [
    { name: "01-kamar-kerja-7dari20-slot", opts: { mode: "WORK", restMode: false, openSlots: 7, frames: 220, bubbleAgentIndex: 4 } },
    { name: "02-kamar-istirahat-slot-penuh", opts: { mode: "WORK", restMode: true, openSlots: 20, frames: 420 } },
    { name: "03-kamar-rapat-virtual", opts: { mode: "MEETING", restMode: false, openSlots: 12, frames: 260 } },
  ];

  console.log(`Meraster ${scenes.length} skenario kamar (${ROOM_GRID.CANVAS_W}x${ROOM_GRID.CANVAS_H})...`);
  for (const s of scenes) {
    const started = Date.now();
    const { file, entities } = renderScene(s.name, outDir, s.opts);
    const pos = entities.map((e) => `${e.profile.name}:${e.status}@${e.lx.toFixed(0)},${e.ly.toFixed(0)}`).join("  ");
    console.log(`\n${path.relative(process.cwd(), file)}  (${(fs.statSync(file).size / 1024).toFixed(0)} KB, ${Date.now() - started} ms)`);
    console.log(pos);
  }
  console.log(`\nZoom 12 kamar (${ROOM_GRID.ROOM_W * 2}x${ROOM_GRID.ROOM_H * 2}, skala 2x)...`);
  for (let i = 0; i < OFFICE_AGENTS.length; i++) {
    const restMode = i % 2 === 1;
    const { file, status } = renderZoomedRoom(outDir, i, restMode ? "WORK" : "WORK", restMode, restMode ? 420 : 220);
    console.log(`  ${path.basename(file)}  -> ${status}`);
  }

  // Probe piksel: pastikan perabot utama benar-benar terlihat (tidak tertutup lapisan lain).
  const probeScene = scenes[0];
  const probeResult = renderScene("04-probe", outDir, { ...probeScene.opts, frames: 2, bubbleAgentIndex: undefined, freezeAgents: true });
  const probes: { lx: number; ly: number; fam: Family; label: string }[] = [
    { lx: 96, ly: 120, fam: "kayu", label: "rangka rak buku" },
    { lx: 48, ly: 60, fam: "krem", label: "kusen jendela" },
    { lx: 180, ly: 205, fam: "kayu", label: "meja kerja" },
    { lx: 228, ly: 160, fam: "layar-gelap", label: "bezel monitor" },
    { lx: 150, ly: 275, fam: "warna-rug", label: "karpet patchwork" },
    { lx: 160, ly: 250, fam: "kayu", label: "meja kopi" },
  ];
  const couchProbes: { lx: number; ly: number; fam: Family; label: string }[] = [
    { lx: 30, ly: 240, fam: "abu", label: "dudukan sofa" },
    { lx: 40, ly: 222, fam: "kuning", label: "bantal sofa" },
  ];
  const beanbagProbes: { lx: number; ly: number; fam: Family; label: string }[] = [
    { lx: 274, ly: 268, fam: "maroon", label: "beanbag" },
  ];
  fs.rmSync(path.join(outDir, "04-probe.png"), { force: true });
  console.log("\nProbe piksel perabot (kamar 1..12):");
  let probeFail = 0;
  for (let i = 0; i < OFFICE_AGENTS.length; i++) {
    const seat = ROOM_DECOR[i].seat;
    const list = [...probes];
    if (seat !== "BEANBAG") list.push(...couchProbes);
    if (seat !== "COUCH") list.push(...beanbagProbes);
    const p = probeRoom(probeResult.raster, i, list);
    if (!p.ok) probeFail++;
    console.log(`  ${p.ok ? "PASS" : "FAIL"} kamar ${i + 1} ${OFFICE_AGENTS[i].name} [${seat}]: ${p.detail}`);
  }
  console.log(probeFail === 0 ? "\nSemua perabot terlihat di 12 kamar." : `\n${probeFail} kamar punya perabot tertutup lapisan lain.`);

  console.log("\nSelesai. Buka PNG di folder data/agent-rooms-preview/, atau lewat web UI: npm run dev:web -> http://localhost:4000/#/agents");
}

main();



