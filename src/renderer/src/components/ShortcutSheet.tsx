import { useDialogFocus } from "./ui";
import { DialogSurface } from "./ui";
import { Row, SectionHeader } from "./ui";
import { useEffect, useRef } from "react";
import { X } from "@phosphor-icons/react";
import type { Shortcut } from "../hooks/useShortcuts";
import { FOCUS } from "./ui";

export function ShortcutSheet({ shortcuts, onClose }: { shortcuts: Shortcut[]; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useDialogFocus(panel);
  return <div className="fixed inset-0 z-[95] grid place-items-center bg-black/10" onClick={onClose}>
    <DialogSurface ref={panel} tabIndex={-1} aria-modal="true" aria-label="Keyboard shortcuts" className="glass-surface max-h-[80vh] w-96 max-w-[calc(100vw-24px)] overflow-y-auto rounded-3xl p-5" onClick={event => event.stopPropagation()} onClose={onClose} onKeyDown={event => { if (event.key === "?") { event.preventDefault(); onClose(); } }}>
      <Row className="mb-4"><SectionHeader as="h2" className="text-body font-medium">Keyboard shortcuts</SectionHeader><button ref={close} type="button" aria-label="Close shortcuts" onClick={onClose} className={`rounded-full bg-ink/[0.06] p-2 ${FOCUS}`}><X size={14} /></button></Row>
      <ShortcutList shortcuts={shortcuts} />
    </DialogSurface>
  </div>;
}

export function ShortcutList({ shortcuts }: { shortcuts: Shortcut[] }) {
  return <dl className="space-y-3 text-small">{shortcuts.map(shortcut => <div key={shortcut.id} className="flex justify-between gap-4"><dt className="text-muted">{shortcut.label}</dt><dd className="shrink-0 font-mono text-micro">{shortcut.keys.join(" / ")}</dd></div>)}</dl>;
}
