"use client";

// Print view: preview at real size, choose label roll or A4 sheet, window.print(), then mark PRINTED.

import Link from "next/link";
import { useState } from "react";
import { api, errorText } from "@/lib/client";
import type { Sticker } from "@/lib/core/stickers";
import type { PrintOrder } from "@/lib/core/types";
import { notifyDataChanged } from "@/lib/events";
import type { Box } from "@/lib/stickerLayout";
import { PrintStyles, StickerSheetView, stickerWarnings, type PrintMode } from "./Stickers";
import { IconArrowLeft, IconPrinter } from "./icons";
import { Button, Loading, Notice, Pill } from "./ui";
import { useApi } from "./useApi";

interface Sheet {
  title: string;
  stickers: Sticker[];
  lotSize: Box;
  packSize: Box;
  printOrder: PrintOrder | null;
}

export function PrintView({ path, backHref, backLabel }: { path: string; backHref: string; backLabel: string }) {
  const { data: sheet, error, reload } = useApi<Sheet>(path);
  const [mode, setMode] = useState<PrintMode>("roll");
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!sheet) return <Loading>Loading stickers…</Loading>;

  const order = sheet.printOrder;

  async function markPrinted() {
    if (!order) return;
    try {
      const r = await api<{ lotsPrinted: number }>(`/api/print-orders/${order.id}/printed`, { body: {} });
      setMsg({ tone: "ok", text: r.lotsPrinted ? `${r.lotsPrinted} lot(s) marked PRINTED — ready for verification` : "Already marked PRINTED" });
      reload();
      notifyDataChanged();
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e) });
    }
  }

  function print() {
    window.print(); // blocks until the dialog closes
    void markPrinted();
  }

  const warnings = stickerWarnings(sheet.stickers, sheet.lotSize, sheet.packSize);
  const lots = sheet.stickers.filter((s) => s.kind === "LOT").length;

  return (
    <div>
      <PrintStyles mode={mode} lotSize={sheet.lotSize} packSize={sheet.packSize} />
      <div className="mb-6 space-y-3 border-b border-line pb-5 print:hidden">
        <div className="flex flex-wrap items-center gap-3">
          <Link href={backHref} className="inline-flex items-center gap-1.5 rounded-full py-1 pr-2 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground">
            <IconArrowLeft size={17} />
            {backLabel}
          </Link>
          <h1 className="text-lg font-bold tracking-tight">{sheet.title}</h1>
          {order && (
            <Pill tone={order.status === "PRINTED" ? "strong" : "muted"} dot>
              {order.status === "PRINTED" ? "PRINTED" : "NOT PRINTED YET"}
            </Pill>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex gap-0.5 rounded-full border border-line-strong bg-surface-2 p-0.5" role="radiogroup" aria-label="Print mode">
            {(["roll", "a4"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(m)}
                className={mode === m ? "rounded-full bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground transition-colors duration-150" : "rounded-full px-4 py-1.5 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"}
              >
                {m === "roll" ? "Label roll (1 per page)" : "A4 sheet"}
              </button>
            ))}
          </div>
          <Button onClick={print}>
            <IconPrinter size={17} />
            Print {sheet.stickers.length} sticker{sheet.stickers.length === 1 ? "" : "s"}</Button>
          {order && order.status !== "PRINTED" && (
            <Button variant="secondary" onClick={markPrinted}>
              Mark as printed
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {lots} lot sticker(s) {sheet.lotSize.widthMm}×{sheet.lotSize.heightMm} mm, {sheet.stickers.length - lots} pack sticker(s) {sheet.packSize.widthMm}×{sheet.packSize.heightMm} mm. Order: lot sticker first, then its packs. Set the browser print scale to 100% (no &quot;fit to page&quot;).
        </p>
        {warnings.map((w) => (
          <Notice key={w} tone="warn">
            {w} — change sticker sizes in Admin → Settings.
          </Notice>
        ))}
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      </div>
      <StickerSheetView stickers={sheet.stickers} lotSize={sheet.lotSize} packSize={sheet.packSize} mode={mode} />
    </div>
  );
}
