import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MenuSurface } from './ui';

/** The Edits list and clip actions share focus, dismissal, geometry and keyboard policy. */
export function ContextMenu({ x, y, label, onClose, returnFocus, children, wide }: {
  x: number; y: number; label: string; onClose: () => void; returnFocus: HTMLElement | null; children: ReactNode; wide?: boolean;
}) {
  const menu = useRef<HTMLDivElement>(null), close = useRef(onClose); close.current = onClose;
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(x, window.innerWidth - box.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(y, window.innerHeight - box.height - 8))}px`;
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: Event) => { if (!element.contains(event.target as Node)) close.current(); };
    const dismiss = (event?: Event) => { if (!event || !element.contains(event.target as Node)) close.current(); };
    window.addEventListener('pointerdown', outside); window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      window.removeEventListener('pointerdown', outside); window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true); returnFocus?.focus();
    };
  }, [x, y, returnFocus]);
  return createPortal(<MenuSurface ref={menu} aria-label={label} onClose={onClose} className={`fixed z-[90] ${wide ? "w-72" : "w-48"} rounded-xl p-1.5`} style={{ left: x, top: y, backdropFilter: "none", WebkitBackdropFilter: "none", boxShadow: "none", backgroundColor: "var(--surface)" }}>{children}</MenuSurface>, document.body);
}
