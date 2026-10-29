import { NamedMessage } from "./ClipNames";
// V62: "What changed" reports what precut already changed, with Undo. Asking for
// improvements lives in Ask now; this note never starts work.
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Cut, CutVersion } from "../../../shared/schema";
import { Close, Undo, Wand } from "./icons";
import { FOCUS, SectionHeader, useMotionPresets } from "./ui";
import { instantFade, pop } from "../motion";

const seenKey = (root: string, cutId: string, version: number) => `sidething.mb1.seen:${root}:${cutId}:${version}`;
const seen = (root: string, cutId: string, version: number) => { try { return localStorage.getItem(seenKey(root, cutId, version)) === "1"; } catch { return false; } };
const markSeen = (root: string, cutId: string, version: number) => { try { localStorage.setItem(seenKey(root, cutId, version), "1"); } catch { /* shown again next time */ } };

/** The What changed list reads only the saved critique, so a first cut improved in the background shows it too. */
export function changesOf(version: CutVersion | undefined): string[] {
  return (version?.critique?.issues ?? []).filter(issue => issue.fixed && issue.how).map(issue => issue.how!).slice(0, 5);
}

export function WhatChanged({ root, cut, version, busy, onOpen }: {
  root: string; cut?: Cut; version?: CutVersion; busy: boolean;
  onOpen: (cutId: string, version: number) => void;
}) {
  const [, refresh] = useState(0);
  const { reduced } = useMotionPresets();
  const changes = changesOf(version);
  const showChanges = !!cut && !!version && changes.length > 0 && !seen(root, cut.cutId, version.version);
  const dismiss = () => { if (cut && version) markSeen(root, cut.cutId, version.version); refresh(n => n + 1); };
  return <AnimatePresence>{showChanges ? <motion.section key={`${cut!.cutId}:${version!.version}`} aria-label="What changed" role="status"
      variants={reduced ? instantFade : pop} initial="initial" animate="animate" exit="exit"
      className="st-pop absolute right-3 top-14 z-30 w-[min(320px,calc(100%_-_24px))] rounded-2xl p-3 text-small text-ink">
      <div className="flex items-center gap-2">
        <Wand size={14} className="shrink-0 text-muted" aria-hidden="true" />
        <SectionHeader as="h2" className="min-w-0 flex-1 font-medium">What changed</SectionHeader>
        <button type="button" aria-label="Dismiss" onClick={dismiss} className={`rounded-full p-1 text-muted hover:bg-ink/[0.06] hover:text-ink ${FOCUS}`}><Close size={14} /></button>
      </div>
      <ul className="mt-2 space-y-1.5">{changes.map(change => <li key={change} className="text-small leading-snug"><NamedMessage>{change}</NamedMessage></li>)}</ul>
      {version!.critique?.from ? <div className="mt-3 flex justify-end">
        <button type="button" disabled={busy} onClick={() => { markSeen(root, cut!.cutId, version!.version); refresh(n => n + 1); onOpen(cut!.cutId, version!.critique!.from!); }}
          className={`inline-flex items-center gap-1.5 rounded-full bg-ink/[0.06] px-3 py-1.5 text-small font-medium hover:bg-ink/[0.1] disabled:opacity-40 ${FOCUS}`}><Undo size={14} />Undo</button>
      </div> : null}
    </motion.section> : null}</AnimatePresence>;
}

/** Kept for older imports. It only reports changes now; it never starts work. */
export const MakeBetter = WhatChanged;
