// GFX1: the bundled icon set for icon metaphors. 24 x 24 line icons, drawn as strokes so they can draw themselves on.
// Written for this app; no third-party artwork. Every shape carries pathLength="1" so one dash animation fits all of them.
export const GRAPHIC_ICONS: Record<string, string[]> = {
  check: ['<path d="M5 12.5l4.5 4.5L19 7.5"/>'],
  bolt: ['<path d="M13 2.5L4.5 13.5H11L10 21.5l8.5-11H12.5L13 2.5z"/>'],
  clock: ['<circle cx="12" cy="12" r="9"/>', '<path d="M12 7v5.2l3.2 2"/>'],
  heart: ['<path d="M12 20.5S4.5 16 4.5 10.2A4.2 4.2 0 0 1 12 7.8a4.2 4.2 0 0 1 7.5 2.4C19.5 16 12 20.5 12 20.5z"/>'],
  star: ['<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.7l5.9-.8L12 3.5z"/>'],
  growth: ['<path d="M3 17l6-6 4 4 8-8"/>', '<path d="M15 7h6v6"/>'],
  idea: ['<path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>', '<path d="M9.5 18.5h5M10.5 21h3"/>'],
  lock: ['<rect x="5" y="11" width="14" height="10" rx="2"/>', '<path d="M8 11V8a4 4 0 0 1 8 0v3"/>'],
  chat: ['<path d="M4 5h16v11H9.5L4 20.5V5z"/>'],
  play: ['<path d="M7 4.5v15l12-7.5-12-7.5z"/>'],
  mail: ['<rect x="3" y="5" width="18" height="14" rx="2"/>', '<path d="M3.5 7l8.5 6 8.5-6"/>'],
  target: ['<circle cx="12" cy="12" r="9"/>', '<circle cx="12" cy="12" r="5"/>', '<circle cx="12" cy="12" r="1"/>'],
  rocket: ['<path d="M12 3c3 2 5 5 5 9l-2 3.5H9L7 12c0-4 2-7 5-9z"/>', '<circle cx="12" cy="10" r="1.6"/>', '<path d="M9 15.5L6 20M15 15.5l3 4.5"/>'],
  people: ['<circle cx="9" cy="8.5" r="3.2"/>', '<path d="M3 20c.4-3.6 2.8-5.5 6-5.5s5.6 1.9 6 5.5"/>', '<path d="M16 5.6a3.2 3.2 0 0 1 0 5.8M18.5 14.8c1.6.8 2.4 2.4 2.5 5.2"/>'],
  globe: ['<circle cx="12" cy="12" r="9"/>', '<ellipse cx="12" cy="12" rx="4" ry="9"/>', '<path d="M3 12h18"/>'],
};
export const ICON_NAMES = Object.keys(GRAPHIC_ICONS);

/** A line icon that draws itself on: stroke-dashoffset 1 to 0, one shape after another. */
export function iconSvg(name: string, className = "icon"): string {
  const shapes = GRAPHIC_ICONS[name] ?? GRAPHIC_ICONS.check;
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">`
    + shapes.map((shape, i) => shape.replace(/<(\w+)/, `<$1 pathLength="1" class="stroke" style="--i:${i}"`)).join("") + "</svg>";
}
