"use client";

import { useEffect, useState } from "react";

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
  ok: "border-green-300 bg-green-50 text-green-900",
  danger: "border-red-300 bg-red-50 text-red-900",
  warn: "border-amber-300 bg-amber-50 text-amber-900",
};
const ICON = { ok: "✓", danger: "✕", warn: "?" };

export function PublicLookup({ code }: { code: string }) {
  const [r, setR] = useState<PublicResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/lookup/${encodeURIComponent(code)}?view=public`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(setR, (e) => setError(e instanceof Error ? e.message : String(e)));
  }, [code]);

  return (
    <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-4 flex items-center gap-2">
        <span className="inline-block h-8 w-8 rounded-lg bg-teal-700 text-center text-lg font-bold leading-8 text-white">V</span>
        <span className="text-lg font-semibold text-slate-900">Velza Beverage</span>
      </div>
      {error && <p className="text-sm text-red-700">Could not check this code ({error}). Please try again.</p>}
      {!r && !error && <p className="text-sm text-slate-500">Checking…</p>}
      {r && (
        <>
          <div className={`flex items-center gap-3 rounded-xl border-2 p-4 ${TONE[r.status.tone]}`} data-testid="public-status">
            <span className="text-2xl font-bold">{ICON[r.status.tone]}</span>
            <span className="text-lg font-semibold">{r.status.label}</span>
          </div>
          {r.registered && r.flavour && (
            <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-slate-500">Product</dt>
              <dd className="font-medium">{r.product}</dd>
              <dt className="text-slate-500">Flavour</dt>
              <dd className="font-medium">{r.flavour}</dd>
              <dt className="text-slate-500">Batch</dt>
              <dd className="font-mono">{r.batchCode}</dd>
              <dt className="text-slate-500">Manufactured</dt>
              <dd>{r.mfgDate}</dd>
              <dt className="text-slate-500">Best before</dt>
              <dd>{r.expiryDate}</dd>
            </dl>
          )}
          <p className="mt-5 break-all font-mono text-xs text-slate-400">{r.code}</p>
        </>
      )}
    </div>
  );
}
