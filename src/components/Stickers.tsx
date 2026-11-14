"use client";

// Case/tray and pack stickers drawn at real size (mm), plus the two print modes. The layout is shared with the
// PDF (lib/stickerDraw), so the preview, the printed roll and the PDF match.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { Sticker } from "@/lib/core/stickers";
import { barsSvg, drawSticker, narrowestBarMm } from "@/lib/stickerDraw";
import { SPEC, type Box, type Rect, type TextBox } from "@/lib/stickerLayout";

const mm = (n: number) => `${n}mm`;

/** CSS pixels per millimetre (CSS fixes 1in = 96px = 25.4mm). */
const CSS_PX_PER_MM = 96 / 25.4;
/** Screen pixels per narrow bar wanted on screen. At about 1 px per bar (real size on a monitor) bar widths get
 *  rounded unevenly and Code 128 cannot be read from the screen; from 2 px it decodes, 3 leaves room for a camera. */
const SCREEN_PX_PER_MODULE = 3;

const SANS = "Helvetica, Arial, sans-serif";
const MONO = '"Courier New", Courier, monospace';

/** The monitor's device pixels per CSS pixel; it changes with browser zoom and when the window moves screens. */
function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(1);
  useEffect(() => {
    let query: MediaQueryList | null = null;
    const update = () => {
      setDpr(window.devicePixelRatio || 1);
      query?.removeEventListener("change", update);
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      query.addEventListener("change", update);
    };
    update();
    return () => query?.removeEventListener("change", update);
  }, []);
  return dpr;
}

/**
 * Screen-only zoom for a sticker so each narrow bar is a whole number (≥ 3) of screen pixels, which lets the
 * barcode be scanned from the monitor. Printing ignores it (applied under `@media screen` only).
 */
function useScreenZoom(moduleMm: number, scannable: boolean): number {
  const dpr = useDevicePixelRatio();
  if (!scannable) return 1;
  const px = moduleMm * CSS_PX_PER_MM * dpr;
  return Math.max(SCREEN_PX_PER_MODULE, Math.ceil(px)) / px;
}

const zoomStyle = (zoom: number) => (zoom === 1 ? {} : ({ "--screen-zoom": zoom } as CSSProperties));

const place = (r: Rect): CSSProperties => ({ position: "absolute", left: mm(r.x), top: mm(r.y), width: mm(r.w), height: mm(r.h) });

function Line({ box, text, font, weight }: { box: TextBox; text: string; font: string; weight: number }) {
  return (
    <div className="overflow-hidden whitespace-pre text-center text-black" style={{ ...place(box), fontFamily: font, fontWeight: weight, fontSize: mm(box.fontMm), lineHeight: mm(box.h) }}>
      {text}
    </div>
  );
}

/** One sticker. `scannable`: on screen, enlarge it so its barcode can be scanned from the monitor (print size unchanged). */
export function StickerView({ sticker, lotSize, packSize, scannable = false }: { sticker: Sticker; lotSize: Box; packSize: Box; scannable?: boolean }) {
  const d = useMemo(() => drawSticker(sticker, lotSize, packSize), [sticker, lotSize, packSize]);
  const bars = useMemo(() => barsSvg(d.bars), [d.bars]);
  const { layout, size } = d;
  const zoom = useScreenZoom(layout.barcode.moduleMm, scannable);
  return (
    <div
      className={sticker.kind === "LOT" ? "sticker sticker-lot" : "sticker sticker-pack"}
      data-code={sticker.code}
      data-kind={sticker.kind}
      style={{ position: "relative", flex: "none", background: "#fff", width: mm(size.widthMm), height: mm(size.heightMm), ...zoomStyle(zoom) }}
    >
      <Line box={layout.header} text={sticker.header} font={SANS} weight={700} />
      {/* White behind the quiet zones so a scanner finds the edges of the bars. */}
      <div style={{ ...place({ x: layout.barcode.x - layout.barcode.quietMm, y: layout.barcode.y, w: layout.barcode.w + 2 * layout.barcode.quietMm, h: layout.barcode.h }), background: "#fff" }} />
      <div role="img" aria-label={`Barcode ${sticker.code}`} style={place(layout.barcode)} dangerouslySetInnerHTML={{ __html: bars }} />
      <Line box={layout.text} text={sticker.code} font={MONO} weight={700} />
    </div>
  );
}

export type PrintMode = "roll" | "a4";

/** Page CSS for the chosen mode. Label roll: one sticker per page sized to the sticker. */
export function PrintStyles({ mode, lotSize, packSize }: { mode: PrintMode; lotSize: Box; packSize: Box }) {
  const css =
    // On screen each sticker shows its edge, like a die-cut label.
    `@media screen { .sticker { zoom: var(--screen-zoom, 1); border: 0.25mm solid #9ca3af; border-radius: 1.2mm; box-sizing: content-box; } }\n` +
    (mode === "roll"
      ? `@page lot { size: ${lotSize.widthMm}mm ${lotSize.heightMm}mm; margin: 0; }
         @page pack { size: ${packSize.widthMm}mm ${packSize.heightMm}mm; margin: 0; }
         @media print {
           .sheet { display: block !important; gap: 0 !important; padding: 0 !important; }
           .sticker { margin: 0 !important; border: none !important; break-after: page; break-inside: avoid; }
           .sticker-lot { page: lot; }
           .sticker-pack { page: pack; }
         }`
      : `@page { size: A4; margin: 8mm; }
         @media print {
           .sheet { display: flex !important; flex-wrap: wrap; gap: 2mm !important; padding: 0 !important; }
           .sticker { break-inside: avoid; border: 0.2mm dashed #bbb !important; }
         }`);
  return <style>{css}</style>;
}

/** Stickers in print order: each case/tray sticker, then its own pack stickers. */
export function StickerSheetView({ stickers, lotSize, packSize, mode, scannable = false }: { stickers: Sticker[]; lotSize: Box; packSize: Box; mode: PrintMode; scannable?: boolean }) {
  return (
    <div className={mode === "roll" ? "sheet flex flex-col items-start gap-3" : "sheet flex flex-wrap items-start gap-2"}>
      {stickers.map((s) => (
        <StickerView key={s.code} sticker={s} lotSize={lotSize} packSize={packSize} scannable={scannable} />
      ))}
    </div>
  );
}

export function stickerWarnings(stickers: Sticker[], lotSize: Box, packSize: Box): string[] {
  const out = new Set<string>();
  const lot = stickers.find((s) => s.kind === "LOT");
  const pack = stickers.find((s) => s.kind === "PACK");
  if (lot) drawSticker(lot, lotSize, packSize).layout.warnings.forEach((w) => out.add(`Case/tray sticker: ${w}`));
  if (pack) drawSticker(pack, lotSize, packSize).layout.warnings.forEach((w) => out.add(`Pack sticker: ${w}`));
  return [...out];
}

/** A note when the bars are too fine for a 203 dpi label printer, or null. */
export function printerNote(stickers: Sticker[], lotSize: Box, packSize: Box): string | null {
  const firsts = (["LOT", "PACK"] as const).map((k) => stickers.find((s) => s.kind === k)).filter((s): s is Sticker => !!s);
  const narrowest = narrowestBarMm(firsts.map((s) => drawSticker(s, lotSize, packSize)));
  if (narrowest === null || narrowest >= SPEC.dpi203ModuleMm) return null;
  return `The narrowest bars are ${narrowest.toFixed(2)} mm: print on a 300 dpi (or finer) label printer at 100% scale. A 203 dpi printer cannot draw them evenly.`;
}
