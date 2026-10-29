import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Shoot } from "../../../../shared/schema";
import { TakeTile } from "./TakeTile";
import { itemStarred, takeStacks, type FootageItem } from "./model";
import { Button } from "../ui";
import { usePageActive } from "../../hooks/usePageActivity";

export const TILE_WIDTH = 176, TILE_GAP = 8, ROW_HEIGHT = 112, OVERSCAN = 2;
export function takeWindow(count: number, offset: number, extent: number, step: number, columns = 1) {
  const first = Math.min(count, Math.max(0, Math.floor(Math.max(0, offset) / step) - OVERSCAN) * columns);
  const end = Math.min(count, (Math.ceil((Math.max(0, offset) + Math.max(0, extent)) / step) + OVERSCAN) * columns);
  return { first, end };
}
// Every tile keeps one size; "Show all" wraps them into rows.
export function takeLayout(count: number, width: number, expanded: boolean, rowHeight = ROW_HEIGHT) {
  let x = 0, y = 0;
  return Array.from({ length: count }, () => {
    if (expanded && x && x + TILE_WIDTH > width) { x = 0; y += rowHeight + TILE_GAP; }
    const box = { x, y, width: TILE_WIDTH, height: rowHeight }; x += TILE_WIDTH + TILE_GAP;
    return box;
  });
}
export const TakeRow = memo(function TakeRow({ id, shoot, items, expanded, currentKey, selected, marks, onOpen, onSelect, onStar, inEdit, stackTakes = false, ranked = false }: {
  id: string; shoot: Shoot; items: FootageItem[]; expanded: boolean; currentKey?: string;
  selected: Map<string, FootageItem>; marks: Record<string, { star?: boolean; review?: string; note?: string }>;
  onOpen: (item: FootageItem) => void; onSelect: (item: FootageItem) => void; onStar: (item: FootageItem) => void;
  stackTakes?: boolean; ranked?: boolean; inEdit?: Set<string>;
}) {
  const active = usePageActive();
  const host = useRef<HTMLDivElement>(null), frame = useRef(0);
  const [bounds, setBounds] = useState({ width: 0, offset: 0, extent: 0, visible: false });
  const [openShots, setOpenShots] = useState<Set<string>>(() => new Set());
  const stacks = useMemo(() => {
    const stacks = takeStacks(items);
    if (ranked) {
      const order = new Map(items.map((item, index) => [item.key, index]));
      for (const stack of stacks) stack.items.sort((a, b) => order.get(a.key)! - order.get(b.key)!);
    }
    return stacks;
  }, [items, ranked]);
  const shown = useMemo(() => stackTakes ? stacks.flatMap(g => openShots.has(g.id) ? g.items : g.items.slice(0,1)) : items, [items, stacks, stackTakes, openShots]);
  const rowHeight = stackTakes ? ROW_HEIGHT + 28 : ROW_HEIGHT;
  const layout = takeLayout(shown.length, bounds.width, expanded, rowHeight);
  const layoutRef = useRef(layout); layoutRef.current = layout;
  useEffect(() => {
    if (!active) return;
    const element = host.current;
    if (!element) return;
    const scroll = element.closest<HTMLElement>("[data-library-scroll], [data-page-surface], main")!;
    const measure = () => {
      frame.current = 0;
      const rect = element.getBoundingClientRect(), viewport = scroll.getBoundingClientRect();
      const next = { width: element.clientWidth, offset: expanded ? Math.max(0, viewport.top - rect.top) : element.scrollLeft,
        extent: expanded ? Math.max(0, Math.min(viewport.height, viewport.bottom - rect.top)) : element.clientWidth,
        visible: rect.bottom >= viewport.top && rect.top <= viewport.bottom };
      setBounds(old => Object.keys(next).every(key => old[key as keyof typeof old] === next[key as keyof typeof next]) ? old : next);
    };
    const schedule = () => { if (!frame.current) frame.current = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule); observer.observe(element); observer.observe(scroll);
    const reveal = (event: Event) => {
      const key = (event as CustomEvent<string>).detail, index = shown.findIndex(item => item.key === key);
      if (index < 0 && stackTakes) {
        const group = stacks.find(g => g.items.some(i => i.key === key));
        if (group) setOpenShots(previous => new Set([...previous, group.id]));
        return;
      }
      const box = layoutRef.current[index]; if (!box) return;
      if (expanded) scroll.scrollTop += element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + box.y;
      else { element.scrollLeft = box.x; element.scrollIntoView({ block: "nearest" }); }
      measure();
    };
    scroll.addEventListener("scroll", schedule, { passive: true }); element.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("sidething:reveal-take", reveal); measure();
    return () => { observer.disconnect(); scroll.removeEventListener("scroll", schedule); element.removeEventListener("scroll", schedule); window.removeEventListener("sidething:reveal-take", reveal); cancelAnimationFrame(frame.current); };
  }, [expanded, shown, active, stackTakes, stacks]);
  const height = Math.max(rowHeight, ...layout.map(box => box.y + box.height));
  const width = expanded ? "100%" : Math.max(0, ...layout.map(box => box.x + box.width));
  return <div id={`footage-row-${id}`} ref={host} data-take-row data-expanded={expanded} className={`relative min-w-0 ${expanded ? "" : "overflow-x-auto"}`} tabIndex={0} style={{ height }}>
    <div className="relative" style={{ height: "100%", width }}>
      {shown.map((item, index) => {
        const box = layout[index], offset = expanded ? box.y : box.x, size = expanded ? box.height : box.width;
        if ((!bounds.visible || offset + size < bounds.offset - TILE_WIDTH * OVERSCAN || offset > bounds.offset + bounds.extent + TILE_WIDTH * OVERSCAN)) return null;
        return <div key={item.key} className="absolute top-0" style={{ left: box.x, top: box.y, width: box.width }}>
          <TakeTile shoot={shoot} item={item} active={currentKey === item.key} selected={selected.has(item.key)} starred={itemStarred(shoot, item)} inEdit={inEdit?.has(item.clip.id)} review={marks[item.key]?.review} onOpen={onOpen} onSelect={onSelect} onStar={onStar} />
          {stackTakes && <div className="mt-1 flex items-center gap-1 text-micro">
            {(() => { const stack = stacks.find(g => g.items[0].key === item.key); return stack && stack.items.length > 1 ? <Button className="!px-2 !py-0.5 !text-micro" aria-expanded={openShots.has(stack.id)} aria-label={`${stack.items.length} takes`} onClick={() => setOpenShots(previous => { const next = new Set(previous); if (next.has(stack.id)) next.delete(stack.id); else next.add(stack.id); return next; })}>{stack.items.length} takes</Button> : null; })()}
            {!!item.clip.angles?.some(id => shoot.clips.some(c => c.id === id && !c.leftOut)) && <Button className="!px-2 !py-0.5 !text-micro" onClick={() => { const other = shoot.clips.find(c => item.clip.angles!.includes(c.id) && !c.leftOut); if (other) onOpen({ key: other.id, clip: other, s: 0, e: other.meta?.durationS ?? null }); }}>Other angles</Button>}
          </div>}
        </div>;
      })}
    </div>
  </div>;
});
