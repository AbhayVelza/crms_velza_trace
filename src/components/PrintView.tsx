"use client";

// Print view: preview at real size (or enlarged on screen so codes scan from the monitor), choose label roll or
// A4 sheet, window.print(), then mark PRINTED. Cases and trays are separate print runs on separate label rolls:
// the operator picks a run, prints only its stickers and confirms it on its own.

import Link from "next/link";
import { useState } from "react";
import { api, errorText } from "@/lib/client";
import type { Sticker } from "@/lib/core/stickers";
import type { LotType, PrintOrder } from "@/lib/core/types";
import { notifyDataChanged } from "@/lib/events";
import type { Box } from "@/lib/stickerLayout";
import { PrintStyles, StickerSheetView, stickerWarnings, type PrintMode } from "./Stickers";
import { useAction } from "./useAction";
import { IconArrowLeft, IconPrinter } from "./icons";
import { PRINT_CONFIRMATION_NOTE, PrintOrderStatus } from "./PrintOrderStatus";
import { Button, cx, fmtTime, Loading, Notice } from "./ui";
import { useApi } from "./useApi";

interface PrintRun {
  lotType: LotType;
  lots: number;
  stickers: number;
  pending: number;
}

interface Sheet {
  title: string;
  stickers: Sticker[];
  lotSize: Box;
  packSize: Box;
  printOrder: PrintOrder | null;
  runs: PrintRun[];
}

const RUN = { CASE: { one: "case", many: "cases", title: "Cases" }, TRAY: { one: "tray", many: "trays", title: "Trays" } } as const;

export function PrintView({ path, backHref, backLabel }: { path: string; backHref: string; backLabel: string }) {
  const { data: sheet, error, reload } = useApi<Sheet>(path);
  const [mode, setMode] = useState<PrintMode>("roll");
  // On screen only: real-size bars are about 1 screen pixel wide, too fine to scan from a monitor.
  const [scannable, setScannable] = useState(true);
  const [msg, setMsg] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  // The run being printed; null = the first run still waiting, else the first run.
  const [chosenRun, setChosenRun] = useState<LotType | null>(null);
  // The only way lots become PRINTED: the operator's explicit confirmation of a run. One request at a time.
  const [confirming, confirmPrinted] = useAction(async (orderId: string, lotType: LotType) => {
    try {
      const r = await api<{ lotsPrinted: number; printOrder: PrintOrder }>(`/api/print-orders/${orderId}/printed`, { body: { lotType } });
      const names = RUN[lotType];
      const rest = r.printOrder.status === "PRINTED" ? " — ready for QC verification" : ` — ready for QC verification. Now print the other run.`;
      setMsg({ tone: "ok", text: r.lotsPrinted ? `${r.lotsPrinted} ${names.one} lot(s) marked PRINTED at ${fmtTime(r.printOrder.printedAt ?? new Date().toISOString())}${rest}` : `The ${names.many} were already marked PRINTED` });
      reload();
      notifyDataChanged();
    } catch (e) {
      setMsg({ tone: "error", text: `Not marked as printed: ${errorText(e)}` });
    }
  });

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!sheet) return <Loading>Loading stickers…</Loading>;

  const order = sheet.printOrder;
  const runs = sheet.runs ?? [];
  const run = runs.find((r) => r.lotType === chosenRun) ?? runs.find((r) => r.pending > 0) ?? runs[0] ?? null;
  // An order prints one run at a time; a reprint (no runs) prints its single sticker.
  const stickers = run ? sheet.stickers.filter((s) => s.lotType === run.lotType) : sheet.stickers;
  const what = run ? `${RUN[run.lotType].one} sticker` : "sticker";

  /** Opens the browser print dialog only. Printing, cancelling or closing it records nothing. */
  function print() {
    window.print();
    if (order && run && run.pending > 0) {
      setMsg({ tone: "info", text: `Nothing has been recorded yet. When every ${RUN[run.lotType].one} sticker has printed correctly, press Mark ${RUN[run.lotType].many} as printed.` });
    }
  }

  const warnings = stickerWarnings(stickers, sheet.lotSize, sheet.packSize);
  const lots = stickers.filter((s) => s.kind === "LOT").length;

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
          {order && <PrintOrderStatus order={order} detail={false} />}
          {order?.printedAt && <span className="text-xs text-muted-foreground">Printed {fmtTime(order.printedAt)}</span>}
        </div>
        {order && runs.length > 0 && (
          <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Print run">
            <span className="text-sm font-semibold text-foreground">Print run:</span>
            {runs.map((r) => {
              const on = r.lotType === run?.lotType;
              return (
                <button
                  key={r.lotType}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  data-testid={`print-run-${r.lotType}`}
                  onClick={() => {
                    setChosenRun(r.lotType);
                    setMsg(null);
                  }}
                  className={cx(
                    "inline-flex min-h-10 flex-col items-start rounded-md border px-3 py-1 text-left text-sm transition-colors duration-150",
                    on ? "border-2 border-primary bg-primary text-primary-foreground" : "border-line-strong bg-surface text-foreground-2 hover:border-foreground hover:text-foreground",
                  )}
                >
                  <span className="font-semibold">
                    {RUN[r.lotType].title} · {r.lots} lot{r.lots === 1 ? "" : "s"}, {r.stickers} stickers
                  </span>
                  <span className={cx("text-xs", on ? "text-primary-foreground/80" : "text-muted-foreground")}>{r.pending > 0 ? "To print" : "Printed"}</span>
                </button>
              );
            })}
          </div>
        )}
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
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-muted-foreground" title="Printed stickers are always real size">
            <input type="checkbox" className="h-4 w-4" checked={scannable} onChange={(e) => setScannable(e.target.checked)} data-testid="scannable-preview" />
            Enlarge on screen to scan from the monitor
          </label>
          <Button onClick={print}>
            <IconPrinter size={17} />
            Print {stickers.length} {what}{stickers.length === 1 ? "" : "s"}</Button>
          {order && run && run.pending > 0 && (
            <Button variant="secondary" loading={confirming} onClick={() => void confirmPrinted(order.id, run.lotType)}>
              Mark {RUN[run.lotType].many} as printed
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {run && runs.length > 1 && `Cases and trays print separately: load the ${RUN[run.lotType].one} label roll for this run. `}
          {lots} {run ? RUN[run.lotType].one : "lot"} sticker(s) {sheet.lotSize.widthMm}×{sheet.lotSize.heightMm} mm, {stickers.length - lots} pack sticker(s) {sheet.packSize.widthMm}×{sheet.packSize.heightMm} mm. Order: {run ? RUN[run.lotType].one : "lot"} sticker first, then its packs. Set the browser print scale to 100% (no &quot;fit to page&quot;).{scannable ? " The preview is enlarged on screen so its barcodes can be scanned from the monitor; printed stickers are real size." : ""}
        </p>
        {order && order.status !== "PRINTED" && <Notice tone="info">{PRINT_CONFIRMATION_NOTE}</Notice>}
        {warnings.map((w) => (
          <Notice key={w} tone="warn">
            {w} — change sticker sizes in Admin → Settings.
          </Notice>
        ))}
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      </div>
      <StickerSheetView stickers={stickers} lotSize={sheet.lotSize} packSize={sheet.packSize} mode={mode} scannable={scannable} />
    </div>
  );
}
