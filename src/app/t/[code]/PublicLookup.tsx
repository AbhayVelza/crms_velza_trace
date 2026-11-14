"use client";

import { useEffect, useState } from "react";
import { VelzaSymbol } from "@/components/brand";
import { IconCircleCheck, IconCircleX, IconLoader, IconTriangleAlert } from "@/components/icons";

interface PublicResult {
  code: string;
  product: string;
  registered: boolean;
  flavour?: string;
  batchCode?: string;
  mfgDate?: string | null;
  expiryDate?: string | null;
  packType?: string;
  status: { label: string; tone: "ok" | "danger" | "warn" };
}

const TONE = {
  ok: "border-success-line bg-success-soft text-success",
  danger: "border-danger-line bg-danger-soft text-danger",
  warn: "border-warning-line bg-warning-soft text-warning",
};
const ICON = { ok: IconCircleCheck, danger: IconCircleX, warn: IconTriangleAlert };

export function PublicLookup({ code }: { code: string }) {
  const [r, setR] = useState<PublicResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/lookup/${encodeURIComponent(code)}?view=public`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(setR, (e) => setError(e instanceof Error ? e.message : String(e)));
  }, [code]);

  return (
    <div className="w-full max-w-sm animate-rise-in rounded-card border border-line bg-surface p-6 shadow-card">
      <div className="mb-6 flex items-center gap-[26px]">
        <VelzaSymbol height={26} />
        <span className="text-lg font-bold tracking-tight text-foreground">Velza Beverage</span>
      </div>
      {error && <p className="text-sm text-danger">Could not check this code ({error}). Please try again.</p>}
      {!r && !error && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <IconLoader size={17} className="animate-spin" />
          Checking…
        </p>
      )}
      {r && (
        <>
          <StatusBox tone={r.status.tone} label={r.status.label} />
          {r.registered && r.flavour && (
            <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 border-t border-line pt-5 text-sm text-foreground">
              <dt className="text-muted-foreground">Product</dt>
              <dd className="font-semibold">{r.product}</dd>
              <dt className="text-muted-foreground">Flavour</dt>
              <dd className="font-semibold">{r.flavour}</dd>
              <dt className="text-muted-foreground">Batch</dt>
              <dd className="font-mono">{r.batchCode}</dd>
              <dt className="text-muted-foreground">Manufactured</dt>
              <dd>{r.mfgDate}</dd>
              <dt className="text-muted-foreground">Best before</dt>
              <dd>{r.expiryDate}</dd>
            </dl>
          )}
          <p className="mt-5 break-all font-mono text-xs text-subtle-foreground">{r.code}</p>
        </>
      )}
    </div>
  );
}

function StatusBox({ tone, label }: { tone: PublicResult["status"]["tone"]; label: string }) {
  const Icon = ICON[tone];
  return (
    <div className={`flex items-center gap-3 rounded-control border-2 p-4 ${TONE[tone]}`} data-testid="public-status">
      <Icon size={28} />
      <span className="text-lg font-bold">{label}</span>
    </div>
  );
}
