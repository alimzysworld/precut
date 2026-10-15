// The one motion language, ported from sidething (src/utils/uiAnimations.ts
// and its sheets) so this app moves like sidething does. Every animation in
// the renderer uses these; no ad-hoc durations or curves.
import type { Transition, Variants } from "framer-motion";

export const ease = {
  out: [0.16, 1, 0.3, 1] as const,        // sidething easeOut: fast start, long soft settle
  smooth: [0.4, 0, 0.2, 1] as const,      // sidething smoothEase
  house: [0.22, 0.61, 0.36, 1] as const,  // sidething page curve
};

export const spring = {
  // sidething's two workhorse springs
  soft: { type: "spring", damping: 25, stiffness: 300 } as Transition,
  snappy: { type: "spring", damping: 28, stiffness: 350 } as Transition,
  // the sliding rail/tab highlight: one small overshoot, then settles
  pill: { type: "spring", stiffness: 400, damping: 30, mass: 0.8 } as Transition,
};

export const dur = { fast: 0.15, base: 0.2, smooth: 0.3 };

// Page change: cross-fade with a 10 px rise. Never AnimatePresence mode="wait"
// (that plays the exit, then the enter, and doubles the wait).
export const page: Variants = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0, transition: { duration: dur.smooth, ease: ease.out } },
  exit: { opacity: 0, transition: { duration: dur.fast, ease: ease.smooth } },
};

// Lists and grids: children fade up in a short stagger, capped so long grids don't drag.
export const list: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.03, delayChildren: 0.02 } },
};
export const item: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: dur.smooth, ease: ease.out } },
};

// Cards and buttons (sidething cardHover / buttonPress)
export const hoverLift = { scale: 1.01, transition: { duration: dur.base, ease: ease.out } };
export const press = { scale: 0.97, transition: { duration: dur.fast, ease: ease.out } };

// Drawer from the right and pop-overs (sidething sheets: fade + zoom from 0.95 on desktop)
export const drawer: Variants = {
  initial: { x: 48, opacity: 0 },
  animate: { x: 0, opacity: 1, transition: spring.soft },
  exit: { x: 32, opacity: 0, transition: { duration: dur.base, ease: ease.smooth } },
};
export const pop: Variants = {
  initial: { opacity: 0, scale: 0.95, y: 6 },
  animate: { opacity: 1, scale: 1, y: 0, transition: spring.snappy },
  exit: { opacity: 0, scale: 0.97, transition: { duration: dur.fast, ease: ease.smooth } },
};

// Images and video frames: fade in when loaded, never pop.
export const imgIn = { duration: dur.smooth, ease: ease.out };
