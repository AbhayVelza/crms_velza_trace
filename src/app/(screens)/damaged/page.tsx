"use client";

// Report damage in five steps: what is wrong → scan the damaged item → photo of it showing its barcode
// → 1 to 4 photos of the damage itself → report. The barcode read from the photo must be the scanned code;
// the server checks that again.

import { useRef, useState } from "react";
import { IconCamera, IconCircleCheck, IconCircleX } from "@/components/icons";
import { ScanInput, ScanLog, type ScanLogEntry } from "@/components/ScanInput";
import { Button, Card, Code, Empty, Field, fmtTime, Input, Notice, PageTitle, Table, Td } from "@/components/ui";
import { useApi } from "@/components/useApi";
import { api, errorText } from "@/lib/client";
import { prepareExtraPhoto, preparePhoto, type PreparedPhoto } from "@/lib/damagePhotoClient";
import { notifyDataChanged } from "@/lib/events";

interface DamagedItem {
  code: string;
  kind: "LOT" | "PACK";
  lotType: "CASE" | "TRAY";
  opened: boolean;
  packs: number;
  flavour: string;
  batchCode: string;
  reason: string | null;
  reportedAt: string | null;
  reportedBy: string | null;
  /** The barcode photo first, then the extra photos of the damage. */
  photoUrls: string[];
}

/** Photos of the damage per report, at least one (the server checks the same). */
const MAX_EXTRA_PHOTOS = 4;

const QUICK_REASONS = ["Crushed / dented", "Leaking", "Torn or wet packaging", "Broken cans"];

const PHOTO_BUTTON = "inline-flex min-h-10 items-center gap-2 rounded-full border px-4 transition-colors duration-150";
const PHOTO_BUTTON_ON = `${PHOTO_BUTTON} cursor-pointer border-line-strong bg-surface font-semibold text-foreground hover:border-foreground`;
const PHOTO_BUTTON_OFF = `${PHOTO_BUTTON} cursor-not-allowed border-line bg-surface text-muted-foreground opacity-60`;

let seq = 0;

type PhotoState = { status: "reading" } | { status: "ready"; photo: PreparedPhoto } | { status: "error"; message: string };

export default function DamagedPage() {
  const list = useApi<{ counts: { cases: number; trays: number; packs: number }; items: DamagedItem[] }>("/api/damaged", { refreshOnChange: true });
  const [reason, setReason] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [photo, setPhoto] = useState<PhotoState | null>(null);
  const [extras, setExtras] = useState<{ id: number; dataUrl: string; bytes: number }[]>([]);
  const [extraBusy, setExtraBusy] = useState(false);
  const [extraError, setExtraError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<ScanLogEntry[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const extraRef = useRef<HTMLInputElement>(null);

  const ready = photo?.status === "ready" ? photo.photo : null;
  const matches = !!ready && !!code && ready.code === code;
  const canReport = !!reason.trim() && !!code && matches && extras.length > 0 && !busy && !extraBusy;
  const canPhoto = !!code && !busy;

  function clearPhoto() {
    setPhoto(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  function clearExtras() {
    setExtras([]);
    setExtraError(null);
    if (extraRef.current) extraRef.current.value = "";
  }

  async function onExtraPhotos(files: FileList | null) {
    const chosen = [...(files ?? [])];
    if (extraRef.current) extraRef.current.value = ""; // the same file can be chosen again
    if (!chosen.length) return;
    const room = MAX_EXTRA_PHOTOS - extras.length;
    setExtraError(chosen.length > room ? `Only ${MAX_EXTRA_PHOTOS} photos of the damage can be added — ${chosen.length - Math.max(room, 0)} left out` : null);
    setExtraBusy(true);
    try {
      const added: { id: number; dataUrl: string; bytes: number }[] = [];
      for (const f of chosen.slice(0, Math.max(room, 0))) added.push({ id: ++seq, ...(await prepareExtraPhoto(f)) });
      setExtras((x) => [...x, ...added].slice(0, MAX_EXTRA_PHOTOS));
    } catch (e) {
      setExtraError(errorText(e));
    } finally {
      setExtraBusy(false);
    }
  }

  function onScan(scanned: string) {
    setCode(scanned);
    // A photo checked against another code must be taken again.
    if (photo?.status === "ready" && photo.photo.code !== scanned) clearPhoto();
  }

  async function onPhoto(file: File | undefined) {
    if (!file) return;
    setPhoto({ status: "reading" });
    try {
      setPhoto({ status: "ready", photo: await preparePhoto(file) });
    } catch (e) {
      setPhoto({ status: "error", message: errorText(e) });
    }
  }

  async function report() {
    if (!canReport || !ready || !code) return;
    setBusy(true);
    let ok = false;
    let message: string;
    try {
      const r = await api<{ ok: boolean; code?: string; message: string }>("/api/damaged", { body: { code, reason, photo: ready.dataUrl, photoCode: ready.code, damagePhotos: extras.map((x) => x.dataUrl) } });
      ok = r.ok;
      message = r.ok ? r.message : `${r.code}: ${r.message}`;
    } catch (e) {
      message = errorText(e);
    } finally {
      setBusy(false);
    }
    setLog((l) => [{ id: ++seq, code, ok, message, at: new Date().toISOString() }, ...l].slice(0, 30));
    if (ok) {
      setCode(null);
      clearPhoto();
      clearExtras();
      notifyDataChanged();
      list.reload();
    }
  }

  const items = list.data?.items ?? [];
  const counts = list.data?.counts ?? { cases: 0, trays: 0, packs: 0 };
  return (
    <>
      <PageTitle
        title="Damaged"
        subtitle="Report a damaged case, tray or pack held here, with a photo of it. It leaves your stock, can no longer move, and Velza HQ is alerted."
      />
      <div className="grid gap-4 lg:grid-cols-2 lg:gap-5">
        <Card title="Report damage">
          <Field label="1. What is wrong?" hint="Kept for every item you report until you change it">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Crushed in transit" maxLength={300} />
          </Field>
          <div className="mt-2 flex flex-wrap gap-2">
            {QUICK_REASONS.map((r) => (
              <Button key={r} variant="secondary" className="min-h-8 px-3 py-1 text-xs" onClick={() => setReason(r)}>
                {r}
              </Button>
            ))}
          </div>

          <div className="mt-4">
            {!reason.trim() && <Notice tone="info" className="mb-2">Say what is wrong first, then scan.</Notice>}
            <ScanInput label="2. Scan the damaged case, tray or pack" onScan={onScan} demoScreen="damage" disabled={!reason.trim()} />
            {code && (
              <p className="mt-2 text-sm" data-testid="damage-code">
                Reporting <Code>{code}</Code>{" "}
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                  onClick={() => {
                    setCode(null);
                    clearPhoto();
                    clearExtras();
                  }}
                >
                  change
                </button>
              </p>
            )}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Scan the lot code to report a whole case or tray, sealed or opened (an opened one takes the packs of it still here).
            Single packs can be reported once the lot is opened.
          </p>

          <div className="mt-4">
            <Field label="3. Photo of the damage, with its barcode" hint="One photo showing the damage and the item's barcode or QR sticker, clear and in focus.">
              <input
                ref={fileRef}
                id="damage-photo"
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                aria-label="Photo of the damaged item"
                disabled={!canPhoto}
                onChange={(e) => onPhoto(e.target.files?.[0])}
              />
              <label htmlFor="damage-photo" aria-disabled={!canPhoto} className={canPhoto ? PHOTO_BUTTON_ON : PHOTO_BUTTON_OFF}>
                <IconCamera size={17} />
                {photo ? "Retake / choose another photo" : "Take or choose photo"}
              </label>
            </Field>
            {!code && <p className="mt-1 text-xs text-muted-foreground">Scan the damaged item first.</p>}
            {photo?.status === "reading" && <p className="mt-2 text-sm text-muted-foreground">Reading the barcode in the photo…</p>}
            {photo?.status === "error" && (
              <Notice tone="error" className="mt-2">
                {photo.message}
              </Notice>
            )}
            {ready && (
              <div className="mt-3 flex gap-3" data-testid="damage-photo-check">
                {/* eslint-disable-next-line @next/next/no-img-element -- local preview of the photo being uploaded */}
                <img src={ready.dataUrl} alt="Photo of the damaged item" className="h-28 w-28 shrink-0 rounded-md border border-line object-cover" />
                <div className="text-sm">
                  {!ready.code ? (
                    <p className="flex items-start gap-1.5 text-danger">
                      <IconCircleX size={17} className="mt-0.5 shrink-0" />
                      <span>No barcode or QR code found in this photo. Retake it with the code label clear and in focus.</span>
                    </p>
                  ) : matches ? (
                    <p className="flex items-start gap-1.5 text-success">
                      <IconCircleCheck size={17} className="mt-0.5 shrink-0" />
                      <span>
                        Barcode in the photo matches <Code>{ready.code}</Code>.
                      </span>
                    </p>
                  ) : (
                    <p className="flex items-start gap-1.5 text-danger">
                      <IconCircleX size={17} className="mt-0.5 shrink-0" />
                      <span>
                        The photo shows <Code>{ready.code}</Code>, not the scanned <Code>{code}</Code>. Photograph the damaged item itself.
                      </span>
                    </p>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">{Math.round(ready.bytes / 1024)} KB</p>
                </div>
              </div>
            )}
          </div>

          <div className="mt-4">
            <Field label="4. Photos of the damage" hint={`At least 1, up to ${MAX_EXTRA_PHOTOS}: close-ups of the dent, leak or tear, other sides. No barcode needed.`}>
              <input
                ref={extraRef}
                id="damage-extra-photos"
                type="file"
                accept="image/*"
                multiple
                className="sr-only"
                aria-label="More photos of the damage"
                disabled={!canPhoto || extraBusy || extras.length >= MAX_EXTRA_PHOTOS}
                onChange={(e) => onExtraPhotos(e.target.files)}
              />
              <label
                htmlFor="damage-extra-photos"
                aria-disabled={!canPhoto || extraBusy || extras.length >= MAX_EXTRA_PHOTOS}
                className={canPhoto && !extraBusy && extras.length < MAX_EXTRA_PHOTOS ? PHOTO_BUTTON_ON : PHOTO_BUTTON_OFF}
              >
                <IconCamera size={17} />
                {extras.length >= MAX_EXTRA_PHOTOS ? `${MAX_EXTRA_PHOTOS} photos added` : extras.length ? "Add more photos" : "Add photos of the damage"}
              </label>
            </Field>
            {extraBusy && <p className="mt-2 text-sm text-muted-foreground">Preparing photos…</p>}
            {extraError && (
              <Notice tone="error" className="mt-2">
                {extraError}
              </Notice>
            )}
            {!!extras.length && (
              <ul className="mt-3 flex flex-wrap gap-2" data-testid="damage-extra-photos">
                {extras.map((x, i) => (
                  <li key={x.id} className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element -- local preview of a photo being uploaded */}
                    <img src={x.dataUrl} alt={`Damage photo ${i + 1}`} className="h-20 w-20 rounded-md border border-line object-cover" />
                    <button
                      type="button"
                      aria-label={`Remove damage photo ${i + 1}`}
                      className="absolute -right-1.5 -top-1.5 grid h-6 w-6 place-items-center rounded-full border border-line-strong bg-surface text-foreground shadow-sm hover:bg-muted"
                      onClick={() => setExtras((list) => list.filter((y) => y.id !== x.id))}
                    >
                      <IconCircleX size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mt-5 border-t border-line pt-4">
            <Button onClick={report} loading={busy} disabled={!canReport}>
              5. Report damaged
            </Button>
            {!canReport && !busy && <p className="mt-2 text-xs text-muted-foreground">Needs a reason, the scanned code, a photo whose barcode matches it and at least one photo of the damage.</p>}
          </div>
          <div className="mt-4">
            <ScanLog entries={log} />
          </div>
        </Card>
        <Card title={`Damaged here (${items.length})`}>
          {list.error && <Notice tone="error">{list.error}</Notice>}
          <div className="mb-3 grid grid-cols-3 gap-2 text-center" data-testid="damaged-counts">
            {(
              [
                ["Cases", counts.cases],
                ["Trays", counts.trays],
                ["Single packs", counts.packs],
              ] as const
            ).map(([label, n]) => (
              <div key={label} className="rounded-control border border-line bg-surface-2 px-2 py-2">
                <div className={n ? "text-xl font-semibold text-danger" : "text-xl font-semibold text-subtle-foreground"}>{n}</div>
                <div className="text-xs text-muted-foreground">{label}</div>
              </div>
            ))}
          </div>
          <Table head={["Code", "What", "Reason", "Photo", "Reported"]} empty={items.length ? null : <Empty>Nothing reported damaged</Empty>}>
            {items.map((d) => (
              <tr key={d.code} data-testid="damaged-row">
                <Td>
                  <Code>{d.code}</Code>
                </Td>
                <Td className="text-xs">
                  {d.kind === "LOT" ? (d.lotType === "CASE" ? "Case" : "Tray") : "Pack"} · {d.flavour}
                  {d.kind === "LOT" && <div className="text-muted-foreground">{d.opened ? `Opened · ${d.packs} packs` : "Sealed"}</div>}
                  <div className="text-muted-foreground">Batch {d.batchCode}</div>
                </Td>
                <Td>{d.reason ?? "—"}</Td>
                <Td>
                  {d.photoUrls.length ? (
                    <div className="flex max-w-[11rem] flex-wrap gap-1">
                      {d.photoUrls.map((url, i) => (
                        <a key={url} href={url} target="_blank" rel="noreferrer" data-testid="damaged-photo">
                          {/* eslint-disable-next-line @next/next/no-img-element -- private photo from our own API */}
                          <img
                            src={url}
                            alt={i ? `Damage photo ${i} of ${d.code}` : `Photo of damaged ${d.code} with its barcode`}
                            className={i ? "h-10 w-10 rounded-md border border-line object-cover" : "h-14 w-14 rounded-md border border-line object-cover"}
                            loading="lazy"
                          />
                        </a>
                      ))}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </Td>
                <Td className="whitespace-nowrap text-xs text-muted-foreground">
                  {fmtTime(d.reportedAt)}
                  {d.reportedBy && <div>{d.reportedBy}</div>}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}
