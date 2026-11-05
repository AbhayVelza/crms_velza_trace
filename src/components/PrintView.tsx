"use client";

// Print view: preview at real size, choose label roll or A4 sheet, window.print(), then mark PRINTED.

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, errorText } from "@/lib/client";
import type { Sticker } from "@/lib/core/stickers";
import type { PrintOrder } from "@/lib/core/types";
import { notifyDataChanged } from "@/lib/events";
import type { Box } from "@/lib/stickerLayout";
import { PrintStyles, StickerSheetView, stickerWarnings, type PrintMode } from "./Stickers";
import { thisPcId } from "./DeviceBar";
import { useAction } from "./useAction";
import { IconArrowLeft, IconPrinter } from "./icons";
import { PRINT_CONFIRMATION_NOTE, PrintOrderStatus } from "./PrintOrderStatus";
import { Button, fmtTime, Loading, Notice } from "./ui";
import { useApi } from "./useApi";

interface Sheet {
  title: string;
  stickers: Sticker[];
  lotSize: Box;
  packSize: Box;
  printOrder: PrintOrder | null;
  withheldLots?: number;
}

// One-time sheets (a logged reprint) are fetched with a POST that uses the authorization up. Kept per page
// load so a re-render or React's development double effect doesn't ask twice.
const onceSheets = new Map<string, Promise<Sheet>>();

function useOnceSheet(path: string | null): { data: Sheet | undefined; error: string | null } {
  const [state, setState] = useState<{ data?: Sheet; error: string | null }>({ error: null });
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    let p = onceSheets.get(path);
    if (!p) {
      p = api<Sheet>(path, { body: {} });
      onceSheets.set(path, p);
    }
    p.then(
      (data) => !cancelled && setState({ data, error: null }),
      (e) => !cancelled && setState({ error: errorText(e) }),
    );
    return () => {
      cancelled = true;
    };
  }, [path]);
  return state.data || state.error ? { data: state.data, error: state.error } : { data: undefined, error: null };
}

/**
 * `path` = GET a print order's sheet (first-time printing; refused once the order is PRINTED).
 * `oncePath` = POST a logged reprint's sticker (served once).
 */
export function PrintView({ path, oncePath, backHref, backLabel }: { path?: string; oncePath?: string; backHref: string; backLabel: string }) {
  const fetched = useApi<Sheet>(path ?? null);
  const once = useOnceSheet(oncePath ?? null);
  const loaded = oncePath ? once.data : fetched.data;
  const error = oncePath ? once.error : fetched.error;
  // After "Mark as printed" the order is updated here; the sheet is not fetched again (the server no longer serves it).
  const [confirmedOrder, setConfirmedOrder] = useState<PrintOrder | null>(null);
  const [mode, setMode] = useState<PrintMode>("roll");
  const [msg, setMsg] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  // The only way an order becomes PRINTED: the operator's explicit confirmation. One request at a time.
  const [confirming, confirmPrinted] = useAction(async (orderId: string) => {
    try {
      const r = await api<{ lotsPrinted: number; printOrder: PrintOrder }>(`/api/print-orders/${orderId}/printed`, { body: { deviceId: thisPcId() } });
      const when = fmtTime(r.printOrder.printedAt);
      setMsg({ tone: "ok", text: r.lotsPrinted ? `${r.lotsPrinted} lot(s) marked PRINTED at ${when} — ready for QC verification` : `Already marked PRINTED at ${when}` });
      setConfirmedOrder(r.printOrder);
      notifyDataChanged();
    } catch (e) {
      setMsg({ tone: "error", text: `Not marked as printed: ${errorText(e)}` });
    }
  });

  if (error) {
    return (
      <div className="space-y-3">
        <Notice tone="error">{error}</Notice>
        <Link href={backHref} className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
          <IconArrowLeft size={17} />
          {backLabel}
        </Link>
      </div>
    );
  }
  if (!loaded) return <Loading>Loading stickers…</Loading>;

  const sheet = loaded;
  const order = confirmedOrder ?? sheet.printOrder;
  const printed = order?.status === "PRINTED";

  /** Opens the browser print dialog only. Printing, cancelling or closing it records nothing. */
  function print() {
    window.print();
    if (order && order.status !== "PRINTED") {
      setMsg({ tone: "info", text: "Nothing has been recorded yet. When every sticker has printed correctly, press Mark as printed." });
    }
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
          {order && <PrintOrderStatus order={order} detail={false} />}
          {order?.printedAt && <span className="text-xs text-muted-foreground">Printed {fmtTime(order.printedAt)}</span>}
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
          {!printed && (
            <Button onClick={print}>
              <IconPrinter size={17} />
              Print {sheet.stickers.length} sticker{sheet.stickers.length === 1 ? "" : "s"}</Button>
          )}
          {order && !printed && (
            <Button variant="secondary" loading={confirming} onClick={() => void confirmPrinted(order.id)}>
              Mark as printed
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {lots} lot sticker(s) {sheet.lotSize.widthMm}×{sheet.lotSize.heightMm} mm, {sheet.stickers.length - lots} pack sticker(s) {sheet.packSize.widthMm}×{sheet.packSize.heightMm} mm. Order: lot sticker first, then its packs. Set the browser print scale to 100% (no &quot;fit to page&quot;).
        </p>
        {order && !printed && <Notice tone="info">{PRINT_CONFIRMATION_NOTE}</Notice>}
        {printed && (
          <Notice tone="info">
            This order is confirmed printed, so its stickers are not printed again from here. To replace a damaged sticker, use{" "}
            <Link href="/operator/reprint" className="font-semibold underline">
              Reprint
            </Link>{" "}
            (a reason is required and every reprint is logged).
          </Notice>
        )}
        {!!sheet.withheldLots && <Notice tone="warn">{sheet.withheldLots} voided or recalled lot(s) of this order are not printed.</Notice>}
        {oncePath && <Notice tone="info">This logged reprint prints once: print it now. To print the sticker again later, log a new reprint.</Notice>}
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
