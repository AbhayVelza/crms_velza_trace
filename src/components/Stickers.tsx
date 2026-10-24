"use client";

// Lot and pack stickers drawn at real size (mm), plus the two print modes.

import { useMemo } from "react";
import { code128Svg, qrSvg } from "@/lib/barcode";
import type { LotSticker, PackSticker, Sticker } from "@/lib/core/stickers";
import { lotStickerLayout, modulesFromSvg, packStickerLayout, SPEC, type Box } from "@/lib/stickerLayout";

const mm = (n: number) => `${n}mm`;

function Svg({ svg, width, height, label }: { svg: string; width: number; height: number; label: string }) {
  return <div role="img" aria-label={label} style={{ width: mm(width), height: mm(height) }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

function LotStickerView({ s, size }: { s: LotSticker; size: Box }) {
  const bars = useMemo(() => code128Svg(s.code), [s.code]);
  const qr = useMemo(() => qrSvg(s.qrUrl), [s.qrUrl]);
  const layout = lotStickerLayout(size, modulesFromSvg(bars));
  return (
    <div className="sticker sticker-lot" data-code={s.code} data-kind="LOT" style={{ width: mm(size.widthMm), height: mm(size.heightMm), padding: mm(layout.padMm) }}>
      <div className="truncate font-bold" style={{ height: mm(layout.headerMm), fontSize: mm(layout.headerFontMm), lineHeight: mm(layout.headerMm) }}>
        {s.header}
      </div>
      <div className="flex items-center" style={{ gap: mm(2), height: mm(size.heightMm - 2 * layout.padMm - layout.headerMm) }}>
        <div style={{ padding: mm(SPEC.qrQuietMm), background: "#fff" }}>
          <Svg svg={qr} width={layout.qrMm!} height={layout.qrMm!} label={`QR ${s.qrUrl}`} />
        </div>
        <div className="flex flex-1 flex-col items-center justify-center">
          <div style={{ padding: `0 ${mm(SPEC.quietZoneMm)}`, background: "#fff" }}>
            <Svg svg={bars} width={layout.barcode.widthMm} height={layout.barcode.heightMm} label={`Barcode ${s.code}`} />
          </div>
          <div className="font-mono font-bold tracking-wider" style={{ fontSize: mm(layout.textFontMm), lineHeight: mm(layout.textMm) }}>
            {s.code}
          </div>
        </div>
      </div>
    </div>
  );
}

function PackStickerView({ s, size }: { s: PackSticker; size: Box }) {
  const bars = useMemo(() => code128Svg(s.code), [s.code]);
  const layout = packStickerLayout(size, modulesFromSvg(bars));
  return (
    <div className="sticker sticker-pack flex flex-col items-center" data-code={s.code} data-kind="PACK" style={{ width: mm(size.widthMm), height: mm(size.heightMm), padding: mm(layout.padMm) }}>
      <div className="w-full truncate text-center font-bold" style={{ height: mm(layout.headerMm), fontSize: mm(layout.headerFontMm), lineHeight: mm(layout.headerMm) }}>
        {s.header}
      </div>
      <div style={{ padding: `0 ${mm(SPEC.quietZoneMm)}`, background: "#fff" }}>
        <Svg svg={bars} width={layout.barcode.widthMm} height={layout.barcode.heightMm} label={`Barcode ${s.code}`} />
      </div>
      <div className="font-mono font-semibold tracking-wider" style={{ fontSize: mm(layout.textFontMm), lineHeight: mm(layout.textMm) }}>
        {s.code}
      </div>
    </div>
  );
}

export function StickerView({ sticker, lotSize, packSize }: { sticker: Sticker; lotSize: Box; packSize: Box }) {
  return sticker.kind === "LOT" ? <LotStickerView s={sticker} size={lotSize} /> : <PackStickerView s={sticker} size={packSize} />;
}

export type PrintMode = "roll" | "a4";

/** Page CSS for the chosen mode. Label roll: one sticker per page sized to the sticker. */
export function PrintStyles({ mode, lotSize, packSize }: { mode: PrintMode; lotSize: Box; packSize: Box }) {
  const css =
    mode === "roll"
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
         }`;
  return <style>{css}</style>;
}

export function StickerSheetView({ stickers, lotSize, packSize, mode }: { stickers: Sticker[]; lotSize: Box; packSize: Box; mode: PrintMode }) {
  return (
    <div className={mode === "roll" ? "sheet flex flex-col items-start gap-3" : "sheet flex flex-wrap items-start gap-2"}>
      {stickers.map((s) => (
        <StickerView key={s.code} sticker={s} lotSize={lotSize} packSize={packSize} />
      ))}
    </div>
  );
}

export function stickerWarnings(stickers: Sticker[], lotSize: Box, packSize: Box): string[] {
  const first = (k: Sticker["kind"]) => stickers.find((s) => s.kind === k);
  const out = new Set<string>();
  const lot = first("LOT");
  const pack = first("PACK");
  if (lot) lotStickerLayout(lotSize, modulesFromSvg(code128Svg(lot.code))).warnings.forEach((w) => out.add(`Lot sticker: ${w}`));
  if (pack) packStickerLayout(packSize, modulesFromSvg(code128Svg(pack.code))).warnings.forEach((w) => out.add(`Pack sticker: ${w}`));
  return [...out];
}
