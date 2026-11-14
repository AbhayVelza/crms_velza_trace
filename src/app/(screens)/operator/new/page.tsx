"use client";

// Guided print order wizard (spec 6.2), one flow for new and existing batches:
// batch code → flavour → cases & trays → summary → print.
// A flavour the batch code does not have yet starts its lots at 00001 (it needs its dates);
// a flavour it already has continues from its next lot number with its own dates.
// The summary comes from the server; the UI holds no business rules.

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useSession } from "@/components/session";
import { thisPcId } from "@/components/DeviceBar";
import { GeneratedCodes } from "@/components/GeneratedCodes";
import { IconArrowLeft, IconArrowRight, IconCheck, IconMinus, IconPlus, IconPrinter } from "@/components/icons";
import { Button, Card, Code, cx, Field, Input, Loading, Notice, PageTitle, Pill, Table, Td } from "@/components/ui";
import { useApi } from "@/components/useApi";
import { api, errorText } from "@/lib/client";
import type { BatchCounter } from "@/lib/core/codes";
import type { PrintOrderPlanSummary } from "@/lib/core/printOrder";
import type { PrintOrder } from "@/lib/core/types";
import { notifyDataChanged } from "@/lib/events";
import { countLabel, lotRangeLabel } from "@/lib/format";

const STEPS = ["Batch code", "Flavour", "Cases & trays", "Summary", "Print"] as const;

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function defaultDates() {
  const today = new Date();
  const expiry = new Date(today);
  expiry.setFullYear(expiry.getFullYear() + 1);
  return { mfgDate: isoDate(today), expiryDate: isoDate(expiry) };
}

function CountInput({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <Button variant="secondary" aria-label={`Decrease ${label}`} className="w-10 px-0" onClick={() => onChange(Math.max(0, value - 1))}>
        <IconMinus size={16} />
      </Button>
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        aria-label={label}
        className="w-28 text-center text-lg font-semibold tabular"
        value={Number.isNaN(value) ? "" : value}
        // 0 or a whole number, no minimum: an empty box counts as 0.
        onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
      />
      <Button variant="secondary" aria-label={`Increase ${label}`} className="w-10 px-0" onClick={() => onChange((Number.isNaN(value) ? 0 : value) + 1)}>
        <IconPlus size={16} />
      </Button>
    </div>
  );
}

function StepList({ steps, step }: { steps: readonly string[]; step: number }) {
  return (
    <ol className="mb-5 flex flex-wrap items-center gap-x-1 gap-y-2 text-xs" aria-label="Steps">
      {steps.map((s, i) => (
        <li key={s} aria-current={i === step ? "step" : undefined} className="flex items-center gap-1">
          <span
            className={cx(
              "inline-flex items-center gap-2 rounded-full border py-1 pl-1 pr-3 transition-colors duration-200",
              i === step ? "border-primary bg-primary font-semibold text-primary-foreground" : i < step ? "border-line-strong bg-surface text-foreground" : "border-line bg-transparent text-muted-foreground",
            )}
          >
            <span
              className={cx(
                "inline-flex h-5 w-5 items-center justify-center rounded-full text-[0.6875rem] font-bold",
                i === step ? "bg-primary-foreground text-primary" : i < step ? "bg-foreground text-background" : "bg-muted text-muted-foreground",
              )}
            >
              {i < step ? <IconCheck size={12} strokeWidth={2.5} /> : i + 1}
            </span>
            {s}
          </span>
          {i < steps.length - 1 && <span aria-hidden="true" className="h-px w-3 bg-line-strong" />}
        </li>
      ))}
    </ol>
  );
}

/** A flavour a batch code already has (GET /api/print-orders/continue). */
interface ExistingBatch {
  batchCode: string;
  flavour: string;
  flavourName: string;
  mfgDate: string;
  expiryDate: string;
  status: "ACTIVE" | "EXHAUSTED" | "COUNTER_INVALID" | "RECALLED";
  counter: BatchCounter;
  continuable: boolean;
  blockedReason: string | null;
}

interface ContinuePreview {
  ok: boolean;
  problem: { code: string; message: string } | null;
  device: { offline: boolean };
  stickerCount: number;
  expectedFirstLotHex: string | null;
  expectedLastLotHex: string | null;
  remainingAfter: number | null;
  maxLotsPerOrder: number;
}

interface ContinueResult {
  replayed: boolean;
  printOrder: PrintOrder;
  firstLotHex: string;
  lastLotHex: string;
  totalLots: number;
  stickerCount: number;
  counter: BatchCounter;
}

/** The summary of either kind of order, in one shape. */
interface Summary {
  ok: boolean;
  problems: string[];
  offline: boolean;
  lots: ReactNode;
  stickerCount: number;
  remainingAfter: number | null;
  maxLotsPerOrder: number;
}

interface Created {
  printOrder: PrintOrder;
  message: ReactNode;
}

const STATUS_PILL: Record<ExistingBatch["status"], { tone: "ok" | "warn" | "danger"; label: string }> = {
  ACTIVE: { tone: "ok", label: "Active" },
  EXHAUSTED: { tone: "warn", label: "Exhausted" },
  COUNTER_INVALID: { tone: "danger", label: "Counter invalid" },
  RECALLED: { tone: "danger", label: "Recalled" },
};

const fmt = (n: number | null) => (n === null ? "—" : n.toLocaleString("en-IN"));

const chip = (on: boolean) =>
  on
    ? "inline-flex min-h-10 items-center gap-2 rounded-full border-2 border-primary bg-primary px-4 font-semibold text-primary-foreground transition-colors duration-150 [&_span]:text-primary-foreground/70"
    : "inline-flex min-h-10 items-center gap-2 rounded-full border border-line-strong bg-surface px-4 text-foreground-2 transition-colors duration-150 hover:border-foreground hover:text-foreground";

export default function NewPrintOrderPage() {
  const { data, flavourName } = useSession();
  const router = useRouter();
  // Batch codes come from Velza Admin's list, with the flavours each already has.
  const codes = useApi<{ codes: { code: string; flavours: string[] }[] }>("/api/print-orders/batch-codes", { refreshOnChange: true });
  // The existing batch rows (one per batch code + flavour) with their dates and lot counters.
  const existingList = useApi<{ maxLotsPerOrder: number; batches: ExistingBatch[] }>("/api/print-orders/continue", { refreshOnChange: true });

  const [step, setStep] = useState(0);
  const [batchCode, setBatchCode] = useState("");
  const [flavour, setFlavour] = useState("");
  const [dates, setDates] = useState(defaultDates);
  const [cases, setCases] = useState(0);
  const [trays, setTrays] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  // One request key per exact order: a retry of the same order reuses it (the server returns the order it
  // already saved instead of allocating again); a changed order gets a new key.
  const [request, setRequest] = useState<{ key: string; body: string } | null>(null);

  const flavours = (data?.flavours ?? []).filter((f) => f.active);
  const takenFlavours = codes.data?.codes.find((c) => c.code === batchCode)?.flavours ?? [];
  const isExisting = takenFlavours.includes(flavour);
  const existing = isExisting ? (existingList.data?.batches.find((b) => b.batchCode === batchCode && b.flavour === flavour) ?? null) : null;

  /** The request body for this order (without preview / key / device). */
  function orderBody() {
    return isExisting ? { batchCode, flavour, cases, trays } : { batchCode, batches: [{ flavour, ...dates, cases, trays }] };
  }
  const endpoint = () => (isExisting ? "/api/print-orders/continue" : "/api/print-orders");

  async function loadSummary() {
    setBusy(true);
    setError(null);
    try {
      const body = { ...orderBody(), preview: true, deviceId: thisPcId() };
      if (isExisting) {
        const p = await api<ContinuePreview>(endpoint(), { body });
        setSummary({
          ok: p.ok,
          problems: p.problem ? [p.problem.message] : [],
          offline: p.device.offline,
          lots: p.expectedFirstLotHex ? <Code>{p.expectedFirstLotHex === p.expectedLastLotHex ? p.expectedFirstLotHex : `${p.expectedFirstLotHex}–${p.expectedLastLotHex}`}</Code> : "—",
          stickerCount: p.stickerCount,
          remainingAfter: p.remainingAfter,
          maxLotsPerOrder: p.maxLotsPerOrder,
        });
      } else {
        const r = await api<{ plan: PrintOrderPlanSummary; device: { offline: boolean }; maxLotsPerOrder: number }>(endpoint(), { body });
        const b = r.plan.batches[0];
        setSummary({
          ok: r.plan.ok,
          problems: r.plan.errors.map((e) => e.message),
          offline: r.device.offline,
          lots: b?.firstLotCode && b.lastLotCode ? <Code>{b.firstLotCode === b.lastLotCode ? b.firstLotCode : `${b.firstLotCode}–${b.lastLotCode.slice(10)}`}</Code> : "—",
          stickerCount: r.plan.totalStickers,
          remainingAfter: null,
          maxLotsPerOrder: r.maxLotsPerOrder,
        });
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function next() {
    setError(null);
    if (step === 0 && !batchCode) return setError("Choose a batch code");
    if (step === 1) {
      if (!flavour) return setError("Choose a flavour");
      if (isExisting && !existing) return setError("Still loading this flavour's lots — try again in a moment");
      if (existing && !existing.continuable) return setError(existing.blockedReason ?? `${batchCode} ${flavourName(flavour)} cannot take more lots`);
      if (!isExisting && (!dates.mfgDate || !dates.expiryDate)) return setError("Enter the manufacture and expiry dates");
    }
    if (step === 2) {
      if (!Number.isInteger(cases) || !Number.isInteger(trays) || cases < 0 || trays < 0) return setError("Cases and trays must be 0 or a whole number");
      if (cases + trays < 1) return setError("Nothing to print: enter cases or trays (either one may be 0)");
      const max = existingList.data?.maxLotsPerOrder;
      if (max && cases + trays > max) {
        return setError(
          `At most ${fmt(max)} lots (cases + trays) per print order; you entered ${fmt(cases + trays)}. Print up to ${fmt(max)} now, then start another order with the same batch code and flavour: it continues the lot numbers.`,
        );
      }
      setSummary(null);
      await loadSummary();
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  async function create() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const fields = orderBody();
      const body = JSON.stringify({ endpoint: endpoint(), ...fields });
      const idempotencyKey = request?.body === body ? request.key : crypto.randomUUID();
      setRequest({ key: idempotencyKey, body });
      if (isExisting) {
        const r = await api<ContinueResult>(endpoint(), { body: { ...fields, idempotencyKey, deviceId: thisPcId() } });
        setCreated({
          printOrder: r.printOrder,
          message: (
            <>
              {r.replayed ? "This order was already created (the request was repeated), so it is shown again. " : "Print order created: "}
              {countLabel(r.stickerCount, "sticker")}, {countLabel(r.totalLots, "lot")} for {batchCode} · {flavourName(flavour)}:{" "}
              <Code>
                <span data-testid="created-range">{lotRangeLabel(r.firstLotHex, r.lastLotHex)}</span>
              </Code>
              . {countLabel(r.counter.remaining, "lot")} left
              {r.counter.nextLotHex ? (
                <>
                  {" "}
                  (next <Code>{r.counter.nextLotHex}</Code>).
                </>
              ) : (
                "; this flavour of the batch is now exhausted."
              )}
            </>
          ),
        });
      } else {
        const r = await api<{ printOrder: PrintOrder }>(endpoint(), { body: { ...fields, idempotencyKey, deviceId: thisPcId() } });
        setCreated({
          printOrder: r.printOrder,
          message: (
            <>
              Print order created: {countLabel(r.printOrder.stickerCount, "sticker")} for {batchCode} · {flavourName(flavour)}
              {!r.printOrder.synced && " (offline — unsynced)"}.
            </>
          ),
        });
      }
      notifyDataChanged();
      setStep(4);
    } catch (e) {
      // Keep the key: if the order was saved before the error reached us, retrying returns it.
      const message = errorText(e);
      await loadSummary();
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  function restart() {
    setStep(0);
    setBatchCode("");
    setFlavour("");
    setDates(defaultDates());
    setCases(0);
    setTrays(0);
    setSummary(null);
    setRequest(null);
    setCreated(null);
    setError(null);
  }

  const heading = (
    <>
      <Code>{batchCode}</Code> · {flavourName(flavour)}
    </>
  );

  return (
    <>
      <PageTitle title="New print order" subtitle="Choose a batch code and a flavour, enter cases and trays, check the summary and print. Lot numbers are generated by the system." />
      <StepList steps={STEPS} step={step} />

      <Card>
        {step === 0 && (
          <Field label="Which batch code?" hint="Batch codes are created by Velza Admin. One batch code can carry several flavours.">
            {codes.error ? (
              <Notice tone="error">{codes.error}</Notice>
            ) : !codes.data ? (
              <Loading>Loading batch codes…</Loading>
            ) : !codes.data.codes.length ? (
              <Notice tone="warn">No batch codes yet — ask Velza Admin to add one under Batch codes.</Notice>
            ) : (
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Batch code">
                {codes.data.codes.map((c) => (
                  <button
                    key={c.code}
                    type="button"
                    role="radio"
                    aria-checked={batchCode === c.code}
                    data-testid={`batch-code-${c.code}`}
                    onClick={() => {
                      if (c.code !== batchCode) setFlavour("");
                      setBatchCode(c.code);
                    }}
                    className={cx(chip(batchCode === c.code), "font-mono")}
                  >
                    {c.code}
                    {c.flavours.length > 0 && <span className="font-sans text-xs opacity-70">has {c.flavours.join(", ")}</span>}
                  </button>
                ))}
              </div>
            )}
          </Field>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <h2 className="font-bold text-foreground">
              Which flavour for <Code>{batchCode}</Code>?
            </h2>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Flavour">
              {flavours.map((f) => (
                <button key={f.code} type="button" role="radio" aria-checked={flavour === f.code} data-testid={`flavour-${f.code}`} onClick={() => setFlavour(f.code)} className={chip(flavour === f.code)}>
                  {f.name} <span className="font-mono text-xs text-muted-foreground">{f.code}</span>
                  {takenFlavours.includes(f.code) && <span className="text-xs text-muted-foreground">· existing</span>}
                </button>
              ))}
            </div>

            {flavour && isExisting && !existing && !existingList.error && <Loading>Loading this flavour&apos;s lots…</Loading>}
            {existingList.error && isExisting && <Notice tone="error">{existingList.error}</Notice>}

            {existing && (
              <div className="rounded-md border border-line bg-surface-2 p-3 text-sm sm:p-4" data-testid="existing-flavour">
                <div className="mb-2 flex flex-wrap items-center gap-2 font-bold text-foreground">
                  {heading} already has lots — this order continues them
                  <Pill tone={STATUS_PILL[existing.status].tone} dot className="uppercase">
                    {STATUS_PILL[existing.status].label}
                  </Pill>
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                  <div>
                    <dt className="text-xs text-muted-foreground">Mfg / Exp</dt>
                    <dd>
                      {existing.mfgDate} / {existing.expiryDate}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Last lot</dt>
                    <dd>{existing.counter.lastLotHex ? <Code>{existing.counter.lastLotHex}</Code> : "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Next lot</dt>
                    <dd>{existing.counter.nextLotHex ? <Code>{existing.counter.nextLotHex}</Code> : "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Lots left</dt>
                    <dd>{fmt(existing.counter.remaining)}</dd>
                  </div>
                </dl>
                {existing.blockedReason && (
                  <Notice tone="error" className="mt-3">
                    {existing.blockedReason}
                  </Notice>
                )}
              </div>
            )}

            {flavour && !isExisting && (
              <div className="rounded-md border border-line bg-surface-2 p-3 sm:p-4">
                <div className="mb-2.5 text-sm font-bold text-foreground">{heading} is new for this batch code — its lots start at 00001</div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Manufacture date">
                    <Input type="date" aria-label="Manufacture date" value={dates.mfgDate} onChange={(e) => setDates((d) => ({ ...d, mfgDate: e.target.value }))} />
                  </Field>
                  <Field label="Expiry date">
                    <Input type="date" aria-label="Expiry date" value={dates.expiryDate} onChange={(e) => setDates((d) => ({ ...d, expiryDate: e.target.value }))} />
                  </Field>
                </div>
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <h2 className="font-bold text-foreground">How many cases and trays for {heading}?</h2>
            <Field label="Cases (4 packs × 6 cans)">
              <CountInput label="Cases" value={cases} onChange={setCases} />
            </Field>
            <Field label="Trays (6 packs × 4 cans)">
              <CountInput label="Trays" value={trays} onChange={setTrays} />
            </Field>
            <p className="text-sm text-muted-foreground" data-testid="lots-hint">
              {fmt(cases + trays)} lot{cases + trays === 1 ? "" : "s"} · at most {fmt(existingList.data?.maxLotsPerOrder ?? null)} lots (cases + trays) per order
              {existing && (
                <>
                  {" "}
                  · {fmt(existing.counter.remaining)} lots left in this flavour (next <Code>{existing.counter.nextLotHex ?? "—"}</Code>)
                </>
              )}
              .
            </p>
          </div>
        )}

        {step === 3 && (
          <>
            <h2 className="mb-3 font-bold text-foreground">Summary</h2>
            {summary?.offline && (
              <Notice tone="warn" className="mb-3">
                Device is offline: the order will be saved unsynced (it can be printed and verified, but not dispatched until synced).
              </Notice>
            )}
            {summary ? (
              <>
                <Table head={["Batch code", "Flavour", "Mfg / Exp", "Cases", "Trays", isExisting ? "Expected lots" : "Lots", "Stickers", ...(isExisting ? ["Left after"] : [])]}>
                  <tr data-testid="summary-row">
                    <Td>
                      <Code>{batchCode}</Code>
                    </Td>
                    <Td>
                      {flavourName(flavour)} <span className="font-mono text-xs text-muted-foreground">{flavour}</span>
                      <div className="text-xs text-muted-foreground">{isExisting ? "continues existing lots" : "new flavour"}</div>
                    </Td>
                    <Td className="whitespace-nowrap text-xs">{existing ? `${existing.mfgDate} → ${existing.expiryDate}` : `${dates.mfgDate} → ${dates.expiryDate}`}</Td>
                    <Td>{cases}</Td>
                    <Td>{trays}</Td>
                    <Td data-testid="summary-range">{summary.lots}</Td>
                    <Td>
                      <span data-testid="summary-total-stickers">{fmt(summary.stickerCount)}</span>
                      <div className="text-xs text-muted-foreground">
                        {cases}×5 + {trays}×7
                      </div>
                    </Td>
                    {isExisting && <Td>{fmt(summary.remainingAfter)}</Td>}
                  </tr>
                </Table>
                <p className="mt-3 text-xs text-muted-foreground">At most {fmt(summary.maxLotsPerOrder)} lots per order. The final lot range is confirmed by the server when you create the order.</p>
                {summary.problems.length > 0 && (
                  <Notice tone="error" className="mt-3">
                    <ul className="list-disc pl-5">
                      {summary.problems.map((p, i) => (
                        <li key={i}>{p}</li>
                      ))}
                    </ul>
                  </Notice>
                )}
              </>
            ) : (
              !error && <Loading>Calculating…</Loading>
            )}
          </>
        )}

        {step === 4 && created && (
          <div className="space-y-3">
            <Notice tone="ok">{created.message}</Notice>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => router.push(`/print/${created.printOrder.id}`)}>
                <IconPrinter size={17} />
                Open print view
              </Button>
              <Button variant="secondary" onClick={restart}>
                New print order
              </Button>
            </div>
            <GeneratedCodes printOrderId={created.printOrder.id} />
          </div>
        )}

        {error && !summary?.problems.includes(error) && (
          <Notice tone="error" className="mt-3">
            {error}
          </Notice>
        )}

        {step < 4 && (
          <div className="mt-5 flex justify-between gap-2 border-t border-line pt-4">
            <Button
              variant="secondary"
              onClick={() => {
                setError(null);
                setStep((s) => Math.max(0, s - 1));
              }}
              disabled={step === 0 || busy}
            >
              <IconArrowLeft size={17} />
              Back
            </Button>
            {step < 3 ? (
              <Button onClick={next} loading={busy}>
                Next
                <IconArrowRight size={17} />
              </Button>
            ) : (
              <Button onClick={create} loading={busy} disabled={!summary?.ok}>
                <IconPrinter size={17} />
                Create &amp; print
              </Button>
            )}
          </div>
        )}
      </Card>
    </>
  );
}
