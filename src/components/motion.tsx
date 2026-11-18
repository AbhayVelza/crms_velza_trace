"use client";

// Motion (motion.dev, the Framer Motion library) building blocks shared by every screen.
// Rules: transform and opacity only, 150–600 ms, nothing loops. Under the device's reduced-motion setting
// (MotionConfig reducedMotion="user") movement is dropped but fades, colour changes and count-ups still play.

import { animate, motion, MotionConfig, useInView, type HTMLMotionProps, type Variants } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";

export const EASE_OUT = [0.2, 0.8, 0.2, 1] as const;

/** Wrap the app once: every motion component below then respects reduced motion. */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={{ duration: 0.3, ease: EASE_OUT }}>
      {children}
    </MotionConfig>
  );
}

const container: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } },
};
const item: Variants = {
  hidden: { opacity: 0, y: 24, scale: 0.98 },
  show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.55, ease: EASE_OUT } },
};

/** A group whose `RevealItem` children rise in one after another when it first scrolls into view. */
export function Reveal({ children, className, ...rest }: HTMLMotionProps<"div">) {
  return (
    <motion.div className={className} variants={container} initial="hidden" whileInView="show" viewport={{ once: true, margin: "0px 0px -40px 0px" }} {...rest}>
      {children}
    </motion.div>
  );
}

export function RevealItem({ children, className, ...rest }: HTMLMotionProps<"div">) {
  return (
    <motion.div className={className} variants={item} {...rest}>
      {children}
    </motion.div>
  );
}

/** Counts up to `value` the first time it is seen, then eases between later values (data refreshes). */
export function AnimatedNumber({ value, className }: { value: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const from = useRef(0);

  // Writes straight to the text node (no React state), so counting never re-renders the tile.
  useEffect(() => {
    const el = text.current;
    if (!inView || !el) return;
    // Counting digits do not move anything on screen, so they run even under reduced motion.
    const show = (n: number) => (el.textContent = Math.round(n).toLocaleString());
    const controls = animate(from.current, value, { duration: from.current === 0 ? 1.1 : 0.5, ease: EASE_OUT, onUpdate: show });
    from.current = value;
    return () => controls.stop();
  }, [value, inView]);

  // Screen readers and tests read the real value; the counting digits are decorative.
  return (
    <span ref={ref} className={className}>
      <span className="sr-only">{value.toLocaleString()}</span>
      <span ref={text} aria-hidden="true">
        0
      </span>
    </span>
  );
}
