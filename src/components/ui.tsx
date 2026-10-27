"use client";

// Small UI kit (Tailwind). Kept deliberately plain.

import type { ButtonHTMLAttributes, ComponentProps, ReactNode, SelectHTMLAttributes } from "react";
import type { ItemStatus } from "@/lib/core/types";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function PageTitle({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-600">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, children, className, actions }: { title?: ReactNode; children: ReactNode; className?: string; actions?: ReactNode }) {
  return (
    <section className={cx("min-w-0 rounded-lg border border-slate-200 bg-white p-4 shadow-sm", className)}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="font-semibold text-slate-800">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

type Variant = "primary" | "secondary" | "danger" | "ghost";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-teal-700 text-white hover:bg-teal-800 disabled:bg-slate-300",
  secondary: "border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:text-slate-400",
  danger: "bg-red-600 text-white hover:bg-red-700 disabled:bg-slate-300",
  ghost: "text-teal-800 hover:bg-teal-50 disabled:text-slate-400",
};

export function Button({ variant = "primary", className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={cx("inline-flex min-h-10 items-center justify-center gap-1 rounded-md px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed", VARIANTS[variant], className)}
    />
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-slate-700">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-red-600">{error}</span>}
    </label>
  );
}

const inputClass = "w-full min-h-10 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20 disabled:bg-slate-100";

export function Input(props: ComponentProps<"input">) {
  return <input {...props} className={cx(inputClass, props.className)} />;
}

export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={cx(inputClass, props.className)}>
      {children}
    </select>
  );
}

export type Tone = "ok" | "error" | "warn" | "info";
const TONES: Record<Tone, string> = {
  ok: "border-green-200 bg-green-50 text-green-900",
  error: "border-red-200 bg-red-50 text-red-900",
  warn: "border-amber-200 bg-amber-50 text-amber-900",
  info: "border-sky-200 bg-sky-50 text-sky-900",
};

export function Notice({ tone = "info", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <div className={cx("rounded-md border px-3 py-2 text-sm", TONES[tone], className)} role={tone === "error" ? "alert" : "status"}>{children}</div>;
}

const STATUS_COLORS: Partial<Record<ItemStatus, string>> = {
  GENERATED: "bg-slate-100 text-slate-700",
  PRINTED: "bg-indigo-100 text-indigo-800",
  PACKED: "bg-teal-100 text-teal-800",
  IN_TRANSIT: "bg-amber-100 text-amber-900",
  AT_SS: "bg-sky-100 text-sky-800",
  AT_DB: "bg-sky-100 text-sky-800",
  AT_RETAILER: "bg-green-100 text-green-800",
  OPENED: "bg-violet-100 text-violet-800",
  QUARANTINED: "bg-orange-100 text-orange-900",
  VOID: "bg-slate-200 text-slate-600 line-through",
  DAMAGED: "bg-orange-100 text-orange-900",
  RETURNED: "bg-slate-200 text-slate-700",
  RECALLED: "bg-red-100 text-red-800",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={cx("inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-semibold", STATUS_COLORS[status as ItemStatus] ?? "bg-slate-100 text-slate-700")}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[0.95em] tracking-wide">{children}</span>;
}

export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: ReactNode }) {
  return (
    <div className="-mx-4 overflow-x-auto sm:mx-0">
      <table className="min-w-full text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            {head.map((h, i) => (
              <th key={i} className="whitespace-nowrap px-3 py-2 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
      {empty}
    </div>
  );
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cx("px-3 py-2 align-top", className)}>{children}</td>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-6 text-center text-sm text-slate-500">{children}</p>;
}

export function Stat({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: "warn" | "danger"; hint?: string }) {
  return (
    <div className={cx("rounded-lg border bg-white p-3", tone === "danger" ? "border-red-200" : tone === "warn" ? "border-amber-200" : "border-slate-200")}>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={cx("mt-1 text-2xl font-semibold", tone === "danger" ? "text-red-700" : tone === "warn" ? "text-amber-700" : "text-slate-900")}>{value}</div>
      {hint && <div className="text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
