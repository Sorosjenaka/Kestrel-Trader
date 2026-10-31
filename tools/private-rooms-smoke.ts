// tools/private-rooms-smoke.ts
// Smoke test kanvas "12 Kamar Kerja Pribadi Agen" TANPA browser: menstub CanvasRenderingContext2D,
// menjalankan drawRoomFrame() untuk semua mode, lalu memverifikasi:
//  1. tidak ada exception & tidak ada koordinat NaN/Infinity,
//  2. 12 kamar unik benar-benar digambar (origin per kamar terdeteksi),
//  3. AI agen selalu berada di DALAM kamarnya sendiri (private rooms),
//  4. status berubah sesuai mode: KERJA / ISTIRAHAT / RAPAT,
//  5. balon ucapan (LLM) ter-render sebagai teks.
// Jalankan: npx tsx tools/private-rooms-smoke.ts
import {
  OFFICE_AGENTS,
  ROOM_DECOR,
  ROOM_GRID,
  drawRoomFrame,
  spawnEntity,
  type OfficeMode,
  type RoomEntity,
  type SpeedMode,
} from "../apps/web/src/components/AgentOfficeCanvas";

interface FakeCall {
  op: string;
  args: number[];
}

interface FakeCanvas {
  ctx: CanvasRenderingContext2D;
  calls: FakeCall[];
  texts: string[];
  nonFinite: string[];
}

function createFakeCanvas(): FakeCanvas {
  const calls: FakeCall[] = [];
  const texts: string[] = [];
  const nonFinite: string[] = [];

  const record = (op: string, args: number[]) => {
    for (const a of args) {
      if (typeof a !== "number" || !Number.isFinite(a)) nonFinite.push(`${op}(${args.join(",")})`);
    }
    calls.push({ op, args });
  };

  class FakeGradient {
    addColorStop(_offset: number, _color: string) {}
  }

  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    imageSmoothingEnabled: false,
    fillRect: (...a: number[]) => record("fillRect", a),
    strokeRect: (...a: number[]) => record("strokeRect", a),
    clearRect: (...a: number[]) => record("clearRect", a),
    fillText: (text: string, x: number, y: number) => {
      record("fillText", [x, y]);
      texts.push(String(text));
    },
    strokeText: (text: string, x: number, y: number) => record("strokeText", [x, y]),
    measureText: (text: string) => ({ width: String(text).length * 5.4 }),
    beginPath: () => record("beginPath", []),
    closePath: () => record("closePath", []),
    moveTo: (...a: number[]) => record("moveTo", a),
    lineTo: (...a: number[]) => record("lineTo", a),
    quadraticCurveTo: (...a: number[]) => record("quadraticCurveTo", a),
    arc: (...a: number[]) => record("arc", a),
    ellipse: (...a: number[]) => record("ellipse", a),
    rect: (...a: number[]) => record("rect", a),
    clip: () => record("clip", []),
    fill: () => record("fill", []),
    stroke: () => record("stroke", []),
    save: () => record("save", []),
    restore: () => record("restore", []),
    translate: (...a: number[]) => record("translate", a),
    rotate: (...a: number[]) => record("rotate", a),
    scale: (...a: number[]) => record("scale", a),
    setLineDash: () => record("setLineDash", []),
    createLinearGradient: (...a: number[]) => {
      record("createLinearGradient", a);
      return new FakeGradient();
    },
    createRadialGradient: (...a: number[]) => {
      record("createRadialGradient", a);
      return new FakeGradient();
    },
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  } as unknown as CanvasRenderingContext2D;

  return { ctx, calls, texts, nonFinite };
}

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
}

function freshEntities(): RoomEntity[] {
  return OFFICE_AGENTS.map((p, i) => spawnEntity(p, i));
}

function runFrames(
  fake: FakeCanvas,
  entities: RoomEntity[],
  frames: number,
  mode: OfficeMode,
  speed: SpeedMode,
  restMode: boolean,
  liveTexts = new Map<string, string>()
) {
  let time = 0;
  for (let f = 0; f < frames; f++) {
    time += 16.6;
    fake.calls.length = 0;
    fake.texts.length = 0;
    drawRoomFrame(fake.ctx, time, 1, entities, {
      restMode,
      mode,
      speed,
      openSlots: 7,
      totalSlots: 20,
      selectedAgentId: "setup-judge",
      hoveredAgentId: "risk-officer",
      liveTexts,
    });
  }
}

// ── 1. Header/HUD + 12 kamar unik tergambar, tanpa NaN ─────────────────────────────
{
  const fake = createFakeCanvas();
  const entities = freshEntities();
  runFrames(fake, entities, 1, "WORK", "FAST", false);

  const originX = new Set(ROOM_DECOR.map((d) => Math.round(d.rx)));
  const originPairs = new Set(ROOM_DECOR.map((d) => `${Math.round(d.rx)}:${Math.round(d.ry)}`));
  check("Layout: 12 kamar unik (grid 4 kolom x 3 baris)", originPairs.size === 12 && originX.size === 4, `${originPairs.size} kamar / ${originX.size} kolom`);

  const drawnOrigins = new Set<string>();
  for (const c of fake.calls) {
    if (c.op === "fillRect" && c.args[2] === ROOM_GRID.ROOM_W && c.args[3] === ROOM_GRID.ROOM_H) {
      drawnOrigins.add(`${c.args[0]}:${c.args[1]}`);
    }
  }
  check(
    "Render: seluruh 12 kamar digambar",
    [...originPairs].every((p) => drawnOrigins.has(p)),
    `${drawnOrigins.size} bingkai kamar terdeteksi`
  );

  check("Render: HUD judul 12 kamar kerja pribadi", fake.texts.some((t) => t.includes("12 KAMAR KERJA PRIBADI")));
  check("Render: HUD slot x/20", fake.texts.some((t) => t.includes("SLOT 7/20 TERISI")));
  check("Render: tanpa koordinat NaN/Infinity", fake.nonFinite.length === 0, fake.nonFinite.slice(0, 3).join(" | "));
  check(
    "Render: plakat nama 12 agen",
    OFFICE_AGENTS.every((a) => fake.texts.some((t) => t === a.name)),
    "nama agen muncul di plakat"
  );
}

// ── 2. Mode KERJA: agen di meja sendiri, tidak keluar kamar ───────────────────────
{
  const fake = createFakeCanvas();
  const entities = freshEntities();
  runFrames(fake, entities, 400, "WORK", "FAST", false);

  const allowed = new Set(["KERJA", "JALAN"]);
  check("Mode KERJA: status valid", entities.every((e) => allowed.has(e.status)), entities.map((e) => e.status).join(","));
  const working = entities.filter((e) => e.status === "KERJA").length;
  check("Mode KERJA: mayoritas duduk bekerja", working >= 6, `${working}/12 KERJA`);

  const inside = entities.every((e) => e.lx >= 0 && e.lx <= ROOM_GRID.ROOM_W && e.ly >= 0 && e.ly <= ROOM_GRID.ROOM_H);
  check("Privasi kamar: semua agen di dalam kamarnya", inside);

  const withinOwn = entities.every((e, i) => {
    const d = ROOM_DECOR[i];
    const gx = d.rx + e.lx;
    return gx >= d.rx && gx <= d.rx + ROOM_GRID.ROOM_W;
  });
  check("Privasi kamar: tidak ada agen menyeberang ke kamar lain", withinOwn);
}

// ── 3. Mode ISTIRAHAT manual + otomatis (slot penuh) ──────────────────────────────
for (const [label, mode, restMode] of [
  ["Mode ISTIRAHAT manual", "BREAK", false],
  ["Mode ISTIRAHAT otomatis (slot penuh 20/20)", "WORK", true],
] as [string, OfficeMode, boolean][]) {
  const fake = createFakeCanvas();
  const entities = freshEntities();
  runFrames(fake, entities, 500, mode, "FAST", restMode);
  check(
    `${label}: semua agen duduk santai`,
    entities.every((e) => e.status === "ISTIRAHAT"),
    entities.map((e) => e.status).join(",")
  );
  check(
    `${label}: posisi tepat di sofa/beanbag kamar`,
    entities.every((e) => {
      const spot =
        e.decor.seat === "BEANBAG" ? [274, 246] : e.decor.seat === "COUCH" ? [84, 240] : e.decor.posterVariant % 2 === 0 ? [84, 240] : [274, 246];
      return Math.abs(e.lx - spot[0]) < 0.6 && Math.abs(e.ly - spot[1]) < 0.6;
    }),
    entities.map((e) => `${e.profile.name}:${e.lx.toFixed(0)},${e.ly.toFixed(0)}`).join(" ")
  );
}

// ── 4. Mode RAPAT VIRTUAL ────────────────────────────────────────────────────────
{
  const fake = createFakeCanvas();
  const entities = freshEntities();
  runFrames(fake, entities, 300, "MEETING", "FAST", false);
  check("Mode RAPAT: semua agen berdiri di tengah kamar", entities.every((e) => e.status === "RAPAT"), entities.map((e) => e.status).join(","));
  check("Mode RAPAT: tetap di kamar masing-masing", entities.every((e) => e.lx > 0 && e.lx < ROOM_GRID.ROOM_W));
}

// ── 5. Balon ucapan live LLM + kestabilan banyak frame & tempo ───────────────────
{
  const fake = createFakeCanvas();
  const entities = freshEntities();
  entities[0].bubbleText = "Uji balon ucapan live dari LLM oke";
  entities[0].bubbleTimer = 400;
  runFrames(fake, entities, 1, "WORK", "TURBO", false, new Map([["macro-scout", "BTC 1h trending up"]]));
  check("Balon: teks live ter-render di kamar", fake.texts.some((t) => t.startsWith("Uji balon")));

  for (const speed of ["NORMAL", "FAST", "TURBO"] as SpeedMode[]) {
    const f = createFakeCanvas();
    const ents = freshEntities();
    let threw: string | null = null;
    try {
      runFrames(f, ents, 120, "WORK", speed, false);
    } catch (err) {
      threw = String(err);
    }
    check(`Stabil 120 frame tempo ${speed}`, threw === null && f.nonFinite.length === 0, threw ?? f.nonFinite[0] ?? "");
  }
}

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  -> ${r.detail}` : ""}`);
}
console.log(`\n${results.length - failed.length}/${results.length} smoke-check lulus.`);
if (failed.length) process.exit(1);

