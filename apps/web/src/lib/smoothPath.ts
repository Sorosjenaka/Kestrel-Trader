// apps/web/src/lib/smoothPath.ts — Kurva halus untuk line chart equity.
// Catmull-Rom -> cubic bezier (tension kecil: mulus TANPA overshing liar).
export function smoothLinePath(pts: Array<[number, number]>, tension = 0.2): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) * tension;
    const c1y = p1[1] + (p2[1] - p0[1]) * tension;
    const c2x = p2[0] - (p3[0] - p1[0]) * tension;
    const c2y = p2[1] - (p3[1] - p1[1]) * tension;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/** Area di bawah kurva: path halus yang ditutup ke baselineY. */
export function smoothAreaPath(pts: Array<[number, number]>, baselineY: number, tension = 0.2): string {
  if (pts.length === 0) return "";
  const line = smoothLinePath(pts, tension);
  return `${line} L${pts[pts.length - 1][0].toFixed(1)},${baselineY.toFixed(1)} L${pts[0][0].toFixed(1)},${baselineY.toFixed(1)} Z`;
}

/**
 * Perataan deret (centered moving average) untuk tampilan kurva yang MULUS.
 * Murni presentasi grafik — angka/label dihitung dari data asli, bukan dari hasil rataan.
 * Titik pertama & terakhir TETAP memakai nilai asli (ujung kurva tidak menyesatkan).
 */
export function smoothSeries(values: number[], window = 5): number[] {
  if (values.length < 3 || window < 3) return values.slice();
  const half = Math.floor(window / 2);
  const out = values.map((_, i) => {
    let sum = 0, n = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < values.length) { sum += values[j]; n++; }
    }
    return sum / n;
  });
  out[0] = values[0];
  out[out.length - 1] = values[values.length - 1];
  return out;
}
