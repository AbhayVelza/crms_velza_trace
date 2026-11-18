"use client";

// Lightweight charts (SVG + Motion, no chart library). They only draw the numbers they are given: every value
// comes from the caller's API data. Each chart has a text equivalent (sr-only table / legend) for screen readers.

import { motion } from "motion/react";
import { useState } from "react";
import { EASE_OUT } from "./motion";
import { cx } from "./ui";

export interface Datum {
  label: string;
  value: number;
  /** CSS colour (defaults to the Velza red gradient). */
  color?: string;
}

const fmt = (n: number) => n.toLocaleString();

/** "Nice" axis maximum and 4 tick steps for a value range starting at 0. */
function niceScale(max: number) {
  if (max <= 0) return { top: 4, ticks: [0, 1, 2, 3, 4] };
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? 10 * pow;
  return { top: step * 4, ticks: [0, 1, 2, 3, 4].map((i) => i * step) };
}

const compact = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n));

/** Vertical bars with a y-axis, gridlines and a hover readout. Bars grow in when first shown. */
export function BarChart({ data, height = 240, label }: { data: Datum[]; height?: number; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const { top, ticks } = niceScale(Math.max(0, ...data.map((d) => d.value)));
  return (
    <figure className="min-w-0">
      <div className="flex gap-2" style={{ height }}>
        {/* y-axis */}
        <div aria-hidden="true" className="flex w-9 shrink-0 flex-col-reverse justify-between pb-6 text-right text-[0.6875rem] text-subtle-foreground tabular">
          {ticks.map((t) => (
            <span key={t} className="leading-none">
              {compact(t)}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          {/* gridlines */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-6 top-0 flex flex-col justify-between">
            {ticks.map((t) => (
              <span key={t} className="block h-px w-full bg-line/70" />
            ))}
          </div>
          <div aria-hidden="true" className="absolute inset-x-0 bottom-0 top-0 flex items-end gap-[clamp(6px,2.5%,18px)] px-1">
            {data.map((d, i) => {
              const pct = top ? (d.value / top) * 100 : 0;
              return (
                <div
                  key={d.label}
                  className="group relative flex h-full min-w-0 flex-1 flex-col justify-end"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                >
                  <div className="relative mx-auto flex h-[calc(100%-1.5rem)] w-full max-w-12 items-end">
                    <motion.div
                      className="w-full rounded-t-md shadow-[0_0_24px_-6px_rgb(230_33_23/0.55)]"
                      style={{
                        height: `${Math.max(pct, d.value ? 1.5 : 0)}%`,
                        background: d.color ?? "linear-gradient(180deg, #ff3b30 0%, #c1121f 55%, #6e0b12 100%)",
                        originY: 1,
                      }}
                      initial={{ scaleY: 0 }}
                      whileInView={{ scaleY: 1 }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.7, delay: i * 0.05, ease: EASE_OUT }}
                    />
                  </div>
                  <span className={cx("mt-2 h-4 truncate text-center text-[0.6875rem] leading-4 transition-colors", hover === i ? "text-foreground" : "text-subtle-foreground")} title={d.label}>
                    {d.label}
                  </span>
                  {hover === i && (
                    <motion.div
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.15 }}
                      className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-control border border-line-strong bg-surface-2 px-2.5 py-1.5 text-xs shadow-pop"
                    >
                      <span className="text-muted-foreground">{d.label}</span> <span className="font-bold text-foreground tabular">{fmt(d.value)}</span>
                    </motion.div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <SrTable label={label} data={data} />
    </figure>
  );
}

/** Donut with a centre total and a legend (count and share). Segments draw in when first shown. */
export function DonutChart({ data, label, centerLabel = "Total" }: { data: Datum[]; label: string; centerLabel?: string }) {
  const total = data.reduce((a, d) => a + d.value, 0);
  const r = 42;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <figure className="flex min-w-0 flex-col items-center gap-5">
      <div className="relative h-44 w-44 shrink-0">
        <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90" aria-hidden="true">
          <circle cx="50" cy="50" r={r} fill="none" stroke="var(--muted)" strokeWidth="11" />
          {total > 0 &&
            data.map((d, i) => {
              const len = (d.value / total) * c;
              const seg = (
                <motion.circle
                  key={d.label}
                  cx="50"
                  cy="50"
                  r={r}
                  fill="none"
                  stroke={d.color ?? "var(--primary)"}
                  strokeWidth="11"
                  strokeDasharray={`${len} ${c - len}`}
                  strokeDashoffset={-offset}
                  initial={{ opacity: 0, pathLength: 0 }}
                  whileInView={{ opacity: 1, pathLength: 1 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.8, delay: 0.1 + i * 0.08, ease: EASE_OUT }}
                  style={{ strokeDasharray: `${Math.max(len - 0.8, 0)} ${c}` }}
                />
              );
              offset += len;
              return seg;
            })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold leading-none text-foreground tabular">{compact(total)}</span>
          <span className="mt-1 text-[0.6875rem] uppercase tracking-[0.08em] text-subtle-foreground">{centerLabel}</span>
        </div>
      </div>
      <ul className="w-full min-w-0 space-y-2 text-sm">
        {data.map((d) => (
          <li key={d.label} className="flex items-center gap-2.5">
            <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: d.color ?? "var(--primary)" }} />
            <span className="min-w-0 flex-1 truncate text-foreground-2">{d.label}</span>
            <span className="font-semibold text-foreground tabular">{fmt(d.value)}</span>
            <span className="w-12 text-right text-xs text-subtle-foreground tabular">{total ? `${Math.round((d.value / total) * 100)}%` : "0%"}</span>
          </li>
        ))}
      </ul>
      <figcaption className="sr-only">{label}</figcaption>
    </figure>
  );
}

/** Horizontal meters (label, value, red bar scaled to the largest value). */
export function MeterList({ data, label }: { data: Datum[]; label: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <ul aria-label={label} className="space-y-3">
      {data.map((d, i) => (
        <li key={d.label}>
          <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate text-foreground-2">{d.label}</span>
            <span className={cx("font-semibold tabular", d.value ? "text-foreground" : "text-subtle-foreground")}>{fmt(d.value)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <motion.div
              className="h-full rounded-full"
              style={{ background: d.color ?? "linear-gradient(90deg, #8f0f18, #e62117)", originX: 0, width: `${(d.value / max) * 100}%` }}
              initial={{ scaleX: 0 }}
              whileInView={{ scaleX: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.7, delay: i * 0.04, ease: EASE_OUT }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function SrTable({ label, data }: { label: string; data: Datum[] }) {
  return (
    <table className="sr-only">
      <caption>{label}</caption>
      <tbody>
        {data.map((d) => (
          <tr key={d.label}>
            <th scope="row">{d.label}</th>
            <td>{d.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
