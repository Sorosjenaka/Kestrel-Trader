// apps/web/src/components/FlashValue.tsx
//
// Angka yang berkedip singkat saat nilainya berubah — naik = cyan (--up),
// turun = merah (--down), palet Tema B. Animasi memakai kelas .flash-up /
// .flash-down yang sudah ada di index.css. `key` berubah tiap perubahan agar
// animasi CSS diputar ulang walau arahnya sama.
import type React from "react";
import { useEffect, useRef, useState } from "react";

export function FlashValue({
  value,
  className,
  style,
  title,
  children,
}: {
  value: number | null | undefined;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
  children: React.ReactNode;
}) {
  const prev = useRef<number | null>(null);
  const [flash, setFlash] = useState<{ cls: string; seq: number }>({ cls: "", seq: 0 });

  useEffect(() => {
    if (value == null || !Number.isFinite(value)) {
      prev.current = null;
      return;
    }
    const before = prev.current;
    prev.current = value;
    if (before == null || value === before) return;
    setFlash((f) => ({ cls: value > before ? "flash-up" : "flash-down", seq: f.seq + 1 }));
  }, [value]);

  return (
    <span
      key={flash.seq}
      className={`${className ?? ""} ${flash.cls}`.trim()}
      style={{ fontVariantNumeric: "tabular-nums", ...style }}
      title={title}
    >
      {children}
    </span>
  );
}
