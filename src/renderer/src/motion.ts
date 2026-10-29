import { createElement,forwardRef,useState } from "react";
import { motion,useReducedMotion,type HTMLMotionProps,type Transition,type Variants } from "framer-motion";

// Three physical responses, shared by every new interaction.
export const spring = {
  hover: { type: "spring", stiffness: 400, damping: 30 },
  press: { type: "spring", stiffness: 600, damping: 35 },
  sheet: { type: "spring", stiffness: 300, damping: 32 },
  // Compatibility names for surfaces outside this brief's edit boundary.
  get soft() { return this.sheet; },
  get snappy() { return this.press; },
  get pill() { return this.hover; },
} satisfies Record<string, Transition>;

// Legacy consumers still import these; new motion never uses timed easing.
const easeOut = [0.16, 1, 0.3, 1] as const;
export const ease = { out: easeOut, smooth: easeOut, house: easeOut };
export const dur = { fast: 0.12, base: 0.16, smooth: 0.2 };
// Reduced motion has no spring, scale, lift or layout interpolation.
export const instant = { type: "tween", duration: 0 } satisfies Transition;
export const fade = spring.sheet;
export const page: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: spring.sheet },
  exit: { opacity: 0, transition: spring.press },
};
export const instantFade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: instant },
  exit: { opacity: 0, transition: instant },
};
export const list: Variants = { initial: {}, animate: {} };
export const item: Variants = { initial: { opacity: 0 }, animate: { opacity: 1, transition: spring.sheet } };
// Cards do not grow on hover (a design decision, 15 Oct); kept as a no-op for callers.
export const hoverLift = {};
export const press = { scale: 0.96, transition: spring.press };
export const pop: Variants = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1, transition: spring.sheet },
  exit: { opacity: 0, scale: 0.96, transition: spring.press },
};
export const drawer = pop;
export const imgIn = spring.sheet;

type MagnifyKind = "card" | "control";
export function useMagnify(kind: MagnifyKind = "card", disabled = false) {
  const reduced = useReducedMotion();
  const [hovering, setHovering] = useState(false);
  return {
    "data-magnify": kind,
    whileHover: disabled || kind === "card" ? undefined : reduced ? { opacity: 0.92 } : { scale: 1.03, transition: spring.hover },
    whileTap: disabled ? undefined : reduced ? { opacity: 0.8 } : kind === "card" ? { scale: 0.99, transition: spring.press } : press,
    transition: reduced ? instant : spring.hover,
    onHoverStart: () => setHovering(true),
    onHoverEnd: () => setHovering(false),
    style: { willChange: hovering && !reduced && !disabled ? "transform" : undefined },
  };
}

// This file deliberately stays .ts: createElement keeps the public wrapper small.
export const Magnify = forwardRef<HTMLDivElement, HTMLMotionProps<"div"> & {
  as?: "div" | "article"; kind?: MagnifyKind; disabled?: boolean;
}>(function Magnify({ as = "div", kind = "card", disabled, style, onHoverStart, onHoverEnd, ...props }, ref) {
  const magnify = useMagnify(kind, disabled);
  return createElement(motion[as] as typeof motion.div, {
    ...magnify, ...props, ref, style: { ...style, ...magnify.style },
    onHoverStart: (event, info) => { magnify.onHoverStart(); onHoverStart?.(event, info); },
    onHoverEnd: (event, info) => { magnify.onHoverEnd(); onHoverEnd?.(event, info); },
  });
});

// Source correction arrivals share one 300 ms ease, including paused repaint.
export const correctionArrival = { durationMs: 300, progress: (elapsed: number) => 1 - (1 - Math.min(1, Math.max(0, elapsed / 300))) ** 3 };
// Source length choices slide together; handle drags stay immediate.
export const sourceWindowTransition = 'left 180ms cubic-bezier(0.16, 1, 0.3, 1), width 180ms cubic-bezier(0.16, 1, 0.3, 1)';
export const musicGridTransition = 'x 160ms cubic-bezier(0.16, 1, 0.3, 1)';
