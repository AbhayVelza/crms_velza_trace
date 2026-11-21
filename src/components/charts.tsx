"use client";

// Lightweight charts (SVG + Motion, no chart library). They only draw the numbers they are given: every value
// comes from the caller's API data. Each chart has a text equivalent (sr-only table / legend) for screen readers.

import { motion } from "motion/react";
import { useId, useState } from "react";
import { EASE_OUT } from "./motion";
import { cx } from "./ui";

export interface Datum {
  label: string;
  value: number;
  /** CSS colour (defaults to the chart's neutral series colour). */
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

/**
 * Vertical bars with a y-axis, hairline gridlines, a value above each bar and a hover readout (DESIGN.md: calm
 * charcoal series, tabular mono figures). Bars grow in when first shown.
 */
export function BarChart({ data, height = 256, label }: { data: Datum[]; height?: number; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const { top, ticks } = niceScale(Math.max(0, ...data.map((d) => d.value)));
  return (
    <figure className="min-w-0">
      <div className="flex gap-2" style={{ height }}>
        {/* y-axis */}
        <div aria-hidden="true" className="flex w-9 shrink-0 flex-col-reverse justify-between pb-8 text-right font-mono text-[0.6875rem] text-subtle-foreground tabular">
          {ticks.map((t) => (
            <span key={t} className="leading-none">
              {compact(t)}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          {/* gridlines (the baseline a step stronger) */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-8 top-0 flex flex-col justify-between">
            {ticks.map((t, i) => (
              <span key={t} className={cx("block h-px w-full", i === ticks.length - 1 ? "bg-line-strong" : "bg-line")} />
            ))}
          </div>
          <div aria-hidden="true" className="absolute inset-x-0 bottom-0 top-0 flex items-end gap-[clamp(8px,4%,48px)] px-2 sm:px-6">
            {data.map((d, i) => {
              const pct = top ? (d.value / top) * 100 : 0;
              const h = Math.max(pct, d.value ? 1.5 : 0);
              return (
                <div
                  key={d.label}
                  className="group relative flex h-full min-w-0 flex-1 flex-col justify-end"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                >
                  <div className="relative mx-auto flex h-[calc(100%-2rem)] w-full max-w-14 items-end">
                    <span className="absolute inset-x-0 text-center font-mono text-xs font-semibold leading-4 text-foreground tabular" style={{ bottom: `calc(${h}% + 4px)` }}>
                      {fmt(d.value)}
                    </span>
                    <motion.div
                      className="w-full rounded-t-md transition-[filter] duration-200 group-hover:brightness-110"
                      style={{
                        height: `${h}%`,
                        background: d.color ?? "var(--chart-bar)",
                        originY: 1,
                      }}
                      initial={{ scaleY: 0 }}
                      whileInView={{ scaleY: 1 }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.7, delay: i * 0.05, ease: EASE_OUT }}
                    />
                  </div>
                  <span className={cx("mt-2 line-clamp-2 h-6 text-center text-[0.6875rem] font-medium leading-3 transition-colors sm:h-6 sm:text-xs sm:leading-3", hover === i ? "text-foreground" : "text-muted-foreground")} title={d.label}>
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

const DONUT_DEFAULT = "var(--chart-ink)";

/**
 * Donut with a centre total and a legend (count and share). The ring sweeps in when first shown.
 *
 * Each segment is a static dash (its arc) on the circle. The entrance animates a mask ring, never the segments:
 * Motion's `pathLength` rewrites stroke-dasharray/-offset, which would turn every segment into one full ring.
 */
export function DonutChart({ data, label, centerLabel = "Total" }: { data: Datum[]; label: string; centerLabel?: string }) {
  const total = data.reduce((a, d) => a + d.value, 0);
  const r = 42;
  const c = 2 * Math.PI * r;
  const maskId = `donut-${useId().replace(/[^\w-]/g, "")}`;
  const parts = data.filter((d) => d.value > 0).length;
  // Each segment's arc length and where it starts on the circle.
  const arcs = data.map((d, i) => ({
    d,
    len: total ? (d.value / total) * c : 0,
    start: total ? (data.slice(0, i).reduce((a, p) => a + p.value, 0) / total) * c : 0,
  }));
  return (
    <figure className="flex min-w-0 flex-col items-center gap-6">
      <div className="relative mt-2 h-44 w-44 shrink-0">
        <motion.svg viewBox="0 0 100 100" className="h-full w-full -rotate-90" aria-hidden="true" initial="hidden" whileInView="show" viewport={{ once: true }}>
          <defs>
            <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
              <motion.circle
                className="chart-draw"
                cx="50"
                cy="50"
                r={r}
                fill="none"
                stroke="#fff"
                strokeWidth="13"
                variants={{ hidden: { pathLength: 0 }, show: { pathLength: 1 } }}
                transition={{ duration: 0.9, delay: 0.1, ease: EASE_OUT }}
              />
            </mask>
          </defs>
          <circle cx="50" cy="50" r={r} fill="none" stroke="var(--chart-track)" strokeWidth="11" />
          {total > 0 && (
            <g mask={`url(#${maskId})`}>
              {arcs.map(({ d, len, start }) => {
                // A hairline gap between neighbouring segments; a lone segment is a closed ring.
                const dash = parts > 1 ? Math.max(len - 0.8, 0) : len;
                return (
                  <circle
                    key={d.label}
                    cx="50"
                    cy="50"
                    r={r}
                    fill="none"
                    stroke={d.color ?? DONUT_DEFAULT}
                    strokeWidth="11"
                    strokeDasharray={`${dash} ${c - dash}`}
                    strokeDashoffset={-start}
                  />
                );
              })}
            </g>
          )}
        </motion.svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold leading-none tracking-[-0.02em] text-foreground tabular">{compact(total)}</span>
          <span className="mt-1.5 text-[0.625rem] font-bold uppercase tracking-[0.08em] text-subtle-foreground">{centerLabel}</span>
        </div>
      </div>
      <ul className="w-full min-w-0 divide-y divide-line border-t border-line text-xs">
        {data.map((d) => (
          <li key={d.label} className="flex items-center gap-2.5 py-2.5 first:pt-4">
            <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: d.color ?? DONUT_DEFAULT }} />
            <span className="min-w-0 flex-1 truncate font-medium text-foreground-2">{d.label}</span>
            <span className="font-mono font-medium text-foreground tabular">{fmt(d.value)}</span>
            <span className="w-11 text-right font-mono text-subtle-foreground tabular">{total ? `${Math.round((d.value / total) * 100)}%` : "0%"}</span>
          </li>
        ))}
      </ul>
      <figcaption className="sr-only">{label}</figcaption>
    </figure>
  );
}

/**
 * Rows of label and count divided by hairlines (DESIGN.md). A row with a count gets a slim bar scaled to the
 * largest value (red: these are alerts); zero rows show just the hairline.
 */
export function MeterList({ data, label }: { data: Datum[]; label: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <ul aria-label={label} className="divide-y divide-line">
      {data.map((d, i) => (
        <li key={d.label} className="py-2 first:pt-0">
          <div className="flex items-baseline justify-between gap-3 text-[0.8125rem]">
            <span className={cx("truncate", d.value ? "font-medium text-foreground" : "text-muted-foreground")}>{d.label}</span>
            <span className={cx("font-mono tabular", d.value ? "font-semibold text-foreground" : "text-subtle-foreground")}>{fmt(d.value)}</span>
          </div>
          <div className={cx("overflow-hidden rounded-full", d.value ? "mt-1.5 h-1" : "h-0")}>
            <motion.div
              className="h-full rounded-full"
              style={{ background: d.color ?? "var(--primary)", originX: 0, width: `${(d.value / max) * 100}%` }}
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
