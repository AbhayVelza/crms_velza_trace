"use client";

// Small UI kit (Tailwind + the Velza tokens in globals.css): the one place buttons, fields, cards, tables,
// badges and stat tiles are styled, so every screen shares the same black-and-red system.

import type { ButtonHTMLAttributes, ComponentProps, ComponentType, ReactNode, SelectHTMLAttributes } from "react";
import type { ItemStatus } from "@/lib/core/types";
import { IconChevronDown, IconCircleCheck, IconCircleX, IconInbox, IconInfo, IconLoader, IconTriangleAlert, type IconProps } from "./icons";
import { AnimatedNumber } from "./motion";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

/** Base min-height (min-h-10) unless the caller sets its own, e.g. compact `min-h-8` buttons and selects. */
const minH = (className?: string) => (className?.includes("min-h-") ? "" : "min-h-10");
/** Full width unless the caller sets a width (`w-auto`, `w-28` …). */
const width = (className?: string) => (/(^|\s)w-/.test(className ?? "") ? "" : "w-full");

export function PageTitle({ title, subtitle, actions, eyebrow }: { title: string; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3 sm:mb-8">
      <div className="min-w-0">
        {eyebrow && <div className="mb-2 text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-subtle-foreground">{eyebrow}</div>}
        <h1 className="text-[1.625rem] font-bold leading-tight tracking-[-0.02em] text-foreground sm:text-[1.875rem]">{title}</h1>
        {subtitle && <p className="mt-2 max-w-3xl text-[0.9375rem] leading-relaxed text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, children, className, actions, icon: Icon }: { title?: ReactNode; children: ReactNode; className?: string; actions?: ReactNode; icon?: ComponentType<IconProps> }) {
  return (
    <section className={cx("card-surface min-w-0 rounded-card border border-line bg-surface p-4 shadow-card transition-[border-color,box-shadow] duration-200 ease-out sm:p-6", className)}>
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 sm:mb-5">
          {title && (
            <h2 className="flex min-w-0 items-center gap-2.5 text-[1.0625rem] font-bold leading-snug tracking-[-0.01em] text-foreground sm:text-lg">
              {Icon && (
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-brand-line bg-brand-soft text-brand">
                  <Icon size={17} />
                </span>
              )}
              {title}
            </h2>
          )}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

type Variant = "primary" | "secondary" | "outline" | "danger" | "ghost";
const VARIANTS: Record<Variant, string> = {
  // Velza red: the main action on a screen.
  primary:
    "bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_6px_16px_-10px_var(--primary)] hover:bg-primary-hover disabled:bg-muted-strong disabled:text-subtle-foreground disabled:shadow-none",
  // Dark charcoal: everything else that acts.
  secondary: "border border-line-strong bg-surface-2 text-foreground hover:border-subtle-foreground/60 hover:bg-muted disabled:border-line disabled:bg-surface disabled:text-subtle-foreground",
  outline: "border border-line-strong bg-transparent text-foreground hover:border-brand-line hover:bg-brand-soft disabled:border-line disabled:text-subtle-foreground",
  danger: "bg-danger text-danger-foreground hover:bg-danger-hover disabled:bg-muted-strong disabled:text-subtle-foreground",
  ghost: "text-foreground hover:bg-muted disabled:text-subtle-foreground",
};

/** `loading` shows a spinner and disables the button; everything else is a plain <button>. */
export function Button({ variant = "primary", className, loading, disabled, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-control px-4.5 py-2 text-sm font-semibold transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.98] active:duration-75 disabled:cursor-not-allowed disabled:active:scale-100",
        minH(className),
        VARIANTS[variant],
        className,
      )}
    >
      {loading && <IconLoader size={16} className="animate-spin" />}
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1.5 block text-[0.8125rem] font-semibold tracking-[0.01em] text-foreground-2">{label}</span>
      {children}
      {hint && !error && <span className="mt-1.5 block text-[0.8125rem] leading-snug text-muted-foreground">{hint}</span>}
      {error && <span className="mt-1.5 block animate-fade-in text-[0.8125rem] font-medium text-danger">{error}</span>}
    </label>
  );
}

const inputClass =
  "rounded-control border border-line-strong bg-input px-3 py-2 text-sm text-foreground placeholder:text-subtle-foreground transition-[border-color,box-shadow,background-color] duration-150 ease-out hover:border-subtle-foreground focus:border-primary focus:outline-none focus:ring-3 focus:ring-primary/20 disabled:cursor-not-allowed disabled:bg-muted disabled:text-subtle-foreground aria-[invalid=true]:border-danger";

export function Input(props: ComponentProps<"input">) {
  return <input {...props} className={cx(inputClass, width(props.className), minH(props.className), props.className)} />;
}

/**
 * Native <select> (keyboard and mobile pickers unchanged) with the same chevron in both themes.
 * `wrapperClassName` sizes the box around it when the select itself is responsive (e.g. full width on phones).
 */
export function Select({ children, wrapperClassName, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { wrapperClassName?: string }) {
  const w = width(props.className);
  return (
    <span className={cx("relative", wrapperClassName ?? (w ? "flex w-full" : "inline-flex"))}>
      <select {...props} className={cx(inputClass, w, minH(props.className), "cursor-pointer appearance-none pr-9", props.className)}>
        {children}
      </select>
      <IconChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
    </span>
  );
}

export type Tone = "ok" | "error" | "warn" | "info";
const TONES: Record<Tone, { box: string; icon: string; Icon: ComponentType<IconProps> }> = {
  ok: { box: "border-success-line bg-success-soft", icon: "text-success", Icon: IconCircleCheck },
  error: { box: "border-danger-line bg-danger-soft", icon: "text-danger", Icon: IconCircleX },
  warn: { box: "border-warning-line bg-warning-soft", icon: "text-warning", Icon: IconTriangleAlert },
  info: { box: "border-info-line bg-info-soft", icon: "text-info", Icon: IconInfo },
};

export function Notice({ tone = "info", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  const t = TONES[tone];
  return (
    <div className={cx("flex animate-rise-in items-start gap-2.5 rounded-control border px-3.5 py-3 text-sm leading-relaxed text-foreground", t.box, className)} role={tone === "error" ? "alert" : "status"}>
      <t.Icon size={18} className={cx("mt-px", t.icon)} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Semantic tone of a status or count: neutral for normal states, colour only where risk must stand out. */
export type PillTone = "neutral" | "strong" | "ok" | "warn" | "danger" | "muted";
const PILL: Record<PillTone, string> = {
  neutral: "border-line bg-surface-2 text-foreground-2",
  strong: "border-foreground/25 bg-muted text-foreground",
  ok: "border-success-line bg-success-soft text-success",
  warn: "border-warning-line bg-warning-soft text-warning",
  danger: "border-danger-line bg-danger-soft text-danger",
  muted: "border-line bg-transparent text-subtle-foreground",
};

/** Small rounded label (counts, flags). `dot` adds a status dot in the current colour. */
export function Pill({ tone = "neutral", dot, className, children }: { tone?: PillTone; dot?: boolean; className?: string; children: ReactNode }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold leading-[1.125rem] tracking-[0.02em]", PILL[tone], className)}>
      {dot && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

// Every status keeps its own label; the tone groups them: done/at a retailer (ok), needs attention
// (warn), lost or blocked (danger), out of use (muted), everything else neutral.
const STATUS_TONES: Partial<Record<ItemStatus, PillTone>> = {
  GENERATED: "muted",
  PRINTED: "neutral",
  PACKED: "strong",
  IN_TRANSIT: "warn",
  AT_CUSTOMS: "warn",
  AT_WAREHOUSE: "strong",
  AT_SS: "strong",
  AT_DB: "strong",
  AT_RETAILER: "ok",
  OPENED: "neutral",
  QUARANTINED: "warn",
  VOID: "muted",
  DAMAGED: "danger",
  RETURN_IN_TRANSIT: "warn",
  RETURNED: "neutral",
  EXPIRED: "danger",
  RECALLED: "danger",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Pill tone={STATUS_TONES[status as ItemStatus] ?? "neutral"} dot className={cx("uppercase", status === "VOID" && "line-through")}>
      {status.replace(/_/g, " ")}
    </Pill>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[0.92em] tracking-wide">{children}</span>;
}

/** Wide tables scroll sideways inside their own box on small screens; the page itself never does. */
export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: ReactNode }) {
  return (
    <div className="-mx-4 overflow-x-auto overscroll-x-contain sm:mx-0 sm:rounded-control sm:border sm:border-line">
      <table className="min-w-full text-left text-sm tabular">
        <thead className="border-b border-line bg-surface-2 text-[0.6875rem] uppercase tracking-[0.08em] text-muted-foreground">
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col" className="whitespace-nowrap px-3.5 py-3 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line [&>tr]:transition-colors [&>tr]:duration-150 [&>tr:hover]:bg-surface-2">{children}</tbody>
      </table>
      {empty}
    </div>
  );
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cx("px-3.5 py-3 align-top text-foreground", className)}>{children}</td>;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="flex flex-col items-center gap-3 px-3 py-10 text-center text-[0.9375rem] text-muted-foreground">
      <span aria-hidden="true" className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface-2 text-subtle-foreground">
        <IconInbox size={20} />
      </span>
      <span>{children}</span>
    </p>
  );
}

/**
 * Loading text with a small spinner (the spinner stops under reduced motion; the text stays). It fades in after
 * 150 ms, so a fast load shows nothing instead of a flash.
 */
export function Loading({ children = "Loading…", className }: { children?: ReactNode; className?: string }) {
  return (
    <p className={cx("flex animate-fade-in-late items-center gap-2 text-sm text-muted-foreground", className)} role="status">
      <IconLoader size={16} className="animate-spin" />
      {children}
    </p>
  );
}

/** A placeholder block shaped like the content it stands in for. Size it with `className` (h-*, w-*). */
export function Skeleton({ className }: { className?: string }) {
  return <span data-skeleton aria-hidden="true" className={cx("block animate-skeleton rounded-control bg-muted", className)} />;
}

/**
 * A page-shaped loading state: the real title (so nothing jumps when data arrives) over skeleton blocks.
 * Screen readers hear one "Loading…" status; the blocks are hidden from them.
 */
export function LoadingPage({ title, subtitle, actions, children }: { title: string; subtitle?: boolean; actions?: ReactNode; children: ReactNode }) {
  // A subtitle wraps to two lines on phones; the placeholder does too, and `actions` (the page's own buttons,
  // disabled) keep their row, so the content below doesn't move when the data arrives.
  const sub = subtitle ? (
    <>
      <Skeleton className="inline-block h-4 w-[28rem] max-w-full align-middle" />
      <span className="sm:hidden">
        <br />
        <Skeleton className="inline-block h-4 w-40 align-middle" />
      </span>
    </>
  ) : undefined;
  return (
    <div className="animate-fade-in-late">
      <PageTitle title={title} subtitle={sub} actions={actions} />
      <p role="status" className="sr-only">
        Loading {title}…
      </p>
      {children}
    </div>
  );
}

/**
 * A key figure. `icon` shows a red outline icon top-right; `tone` marks a figure that needs attention (border,
 * icon and value colour). Numbers count up when first shown. `share` (0–1, from the caller's real data) draws a
 * small meter under the value; the tile never invents a trend.
 */
export function Stat({
  label,
  value,
  tone,
  hint,
  icon: Icon,
  share,
}: {
  label: string;
  value: ReactNode;
  tone?: "warn" | "danger";
  hint?: string;
  icon?: ComponentType<IconProps>;
  share?: number;
}) {
  const color = tone === "danger" ? "text-danger" : tone === "warn" ? "text-warning" : "text-foreground";
  return (
    <div
      className={cx(
        "card-surface group/stat relative flex min-w-0 flex-col rounded-card border bg-surface p-4 shadow-card transition-[border-color,box-shadow,transform] duration-300 ease-out hover:-translate-y-1 hover:shadow-hover sm:p-5",
        tone === "danger" ? "border-danger-line" : tone === "warn" ? "border-warning-line" : "border-line hover:border-brand-line",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5 text-[0.8125rem] font-semibold text-foreground-2">
          {!Icon && tone === "danger" && <IconTriangleAlert size={15} className="text-danger" />}
          {!Icon && tone === "warn" && <IconTriangleAlert size={15} className="text-warning" />}
          <span className="truncate">{label}</span>
        </div>
        {Icon && (
          <Icon
            size={20}
            className={cx("transition-transform duration-300 ease-out group-hover/stat:scale-110", tone === "danger" ? "text-danger" : tone === "warn" ? "text-warning" : "text-brand")}
          />
        )}
      </div>
      <div className={cx("mt-3 text-[1.75rem] font-bold leading-none tracking-[-0.02em] tabular sm:text-[2rem]", color)}>
        {typeof value === "number" ? <AnimatedNumber value={value} /> : value}
      </div>
      {share !== undefined && (
        <div aria-hidden="true" className="mt-4 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full origin-left rounded-full bg-gradient-to-r from-primary-hover to-primary transition-transform duration-700 ease-out"
            style={{ transform: `scaleX(${Math.max(0, Math.min(1, share))})` }}
          />
        </div>
      )}
      {hint && <div className="mt-2 text-[0.8125rem] text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
