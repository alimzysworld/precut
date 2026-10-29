import type { ReactNode, SVGProps } from "react";

export type IconProps = Omit<SVGProps<SVGSVGElement>,
  "children" | "viewBox" | "width" | "height" | "fill" | "stroke" | "strokeWidth" |
  "strokeLinecap" | "strokeLinejoin" | "role" | "aria-hidden" | "aria-label" | "focusable"
> & { size?: number; label?: string };

/** precut's stroke family. A 24px grid with optical padding around each shape.
 * Keep icons decorative inside labelled buttons; label standalone illustrations.
 * Cut is the duration panel. TransitionCut is the hard-cut join.
 */
export function Icon({ size = 18, label, children, ...props }: IconProps & { children?: ReactNode }) {
  return <svg {...props} width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"
    focusable="false" aria-hidden={label ? undefined : true} aria-label={label || undefined} role={label ? "img" : undefined}>
    {children}
  </svg>;
}

// Rail: open shapes, quiet at 18px and legible at 14px.
export function Info(props: IconProps) {
  return <Icon {...props}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v6M12 7.5h.01" /></Icon>;
}
export function Text(props: IconProps) {
  return <Icon {...props}><path d="M4 6h16M4 12h16M4 18h10" /></Icon>;
}
// Scene drawings use the same stroke, grid and optical padding as the rail.
export function LayoutFace(props: IconProps) { return <Icon {...props}><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="12" cy="10" r="2.5"/><path d="M7 18c0-5 10-5 10 0"/></Icon>; }
export function LayoutScreen(props: IconProps) { return <Icon {...props}><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8M12 18v3M6 8h12M6 11h7"/></Icon>; }
export function LayoutBubble(props: IconProps) { return <Icon {...props}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M6 8h12M6 11h7"/><circle cx="17" cy="16" r="3"/></Icon>; }
export function LayoutSplit(props: IconProps) { return <Icon {...props}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16M15 8h3M15 11h3"/><circle cx="7.5" cy="10" r="2"/><path d="M5 17c0-4 5-4 5 0"/></Icon>; }
export function LayoutTitle(props: IconProps) { return <Icon {...props}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M12 9v7M10 16h4"/></Icon>; }
export function LayoutPlaceholder(props: IconProps) { return <Icon {...props}><rect x="3" y="4" width="18" height="16" rx="2" strokeDasharray="2 3"/><path d="M8 12h8M12 8v8"/></Icon>; }
export function Captions(props: IconProps) {
  return <Icon {...props}><rect x="3.5" y="5" width="17" height="14" rx="2" /><path d="M10.5 10a2.5 2.5 0 1 0 0 4M17 10a2.5 2.5 0 1 0 0 4" /></Icon>;
}
export function Look(props: IconProps) {
  return <Icon {...props}><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5v17M12 7.5h6M12 12h8M12 16.5h6" /></Icon>;
}
export function Sound(props: IconProps) {
  return <Icon {...props}><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 10v4" /></Icon>;
}
export function Transitions(props: IconProps) {
  return <Icon {...props}><path d="M4 8h16l-4-4M20 16H4l4 4" /></Icon>;
}
export function Cut(props: IconProps) {
  return <Icon {...props}><circle cx="12" cy="13" r="7.5" /><path d="M10 2.5h4M12 2.5v3M12 9v4l3 2" /></Icon>;
}
export function Clips(props: IconProps) {
  return <Icon {...props}><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M7 4.5h10M10 11.5l4 2.5-4 2.5z" /></Icon>;
}
export function Library(props: IconProps) {
  return <Icon {...props}><rect x="3.5" y="6.5" width="17" height="14" rx="2" /><path d="M7 3.5h10M4 17l5-5 4 4 3-3 4 4" /><circle cx="15.5" cy="10.5" r=".75" fill="currentColor" stroke="none" /></Icon>;
}
export function Ask(props: IconProps) {
  return <Icon {...props}><path d="m4 17 11-11 3 3L7 20ZM13 8l3 3M18 3v2M20 6h1" /></Icon>;
}
export function Search(props: IconProps) {
  return <Icon {...props}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 4.5 4.5" /></Icon>;
}

// Edit bar.
export function Undo(props: IconProps) {
  return <Icon {...props}><path d="m8.5 13-4-4 4-4M4.5 9h9a5.5 5.5 0 0 1 0 11H11" /></Icon>;
}
export function Redo(props: IconProps) {
  return <Icon {...props}><path d="m15.5 13 4-4-4-4M19.5 9h-9a5.5 5.5 0 0 0 0 11H13" /></Icon>;
}
export function Split(props: IconProps) {
  return <Icon {...props}><circle cx="6" cy="6.5" r="2.5" /><circle cx="6" cy="17.5" r="2.5" /><path d="m8 8 12 12M8 16 20 4" /></Icon>;
}
export function Trim(props: IconProps) {
  return <Icon {...props}><path d="M8 4H5v16h3M16 4h3v16h-3M12 9v6" /></Icon>;
}
export function Duplicate(props: IconProps) {
  return <Icon {...props}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M5 16H4V6a2 2 0 0 1 2-2h10v1" /></Icon>;
}
export function Delete(props: IconProps) {
  return <Icon {...props}><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5" /></Icon>;
}

// Joins: a hard cut is a boundary; the other silhouettes describe the motion.
export function TransitionCut(props: IconProps) {
  return <Icon {...props}><path d="M12 4v16" /></Icon>;
}
export function Snap(props: IconProps) {
  return <Icon {...props}><rect x="4" y="6" width="6" height="12" rx="1" /><rect x="14" y="6" width="6" height="12" rx="1" /></Icon>;
}
export function Ease(props: IconProps) {
  return <Icon {...props}><path d="M4 18c8 0 8-12 16-12" /></Icon>;
}
export function Zoom(props: IconProps) {
  return <Icon {...props}><circle cx="10.5" cy="10.5" r="6" /><path d="M10.5 7.5v6M7.5 10.5h6M15 15l5 5" /></Icon>;
}
export function Whip(props: IconProps) {
  return <Icon {...props}><path d="M4 7h10M4 12h16M4 17h10M16 8l4 4-4 4" /></Icon>;
}
export function Dissolve(props: IconProps) {
  return <Icon {...props}><path d="M9 4.5a7.5 7.5 0 0 0 0 15M15 4.5a7.5 7.5 0 0 1 0 15M12 7v1M12 11.5v1M12 16v1" /></Icon>;
}
export function Ramp(props: IconProps) {
  return <Icon {...props}><path d="M4 19c8 0 8-14 16-14M16 5h4v4" /></Icon>;
}
export function Whoosh(props: IconProps) {
  return <Icon {...props}><path d="M4 8h11a2.5 2.5 0 1 0-2.5-2.5M4 12h16M4 16h9a2.5 2.5 0 1 1-2.5 2.5" /></Icon>;
}
export function Hit(props: IconProps) {
  return <Icon {...props}><path d="M4 13h4l2-9 4 16 2-7h4M5 5l2 2M17 7l2-2" /></Icon>;
}
export function Pop(props: IconProps) {
  return <Icon {...props}><circle cx="12" cy="13" r="4" /><path d="M12 3v2M4 7l2 1M18 8l2-1M5 19l2-1M17 18l2 1" /></Icon>;
}
export function Riser(props: IconProps) {
  return <Icon {...props}><path d="M4 17v3M8 13v7M12 9v11M16 5v15M19 7l1-3 1 3" /></Icon>;
}

// Lanes and visibility. Captions serves both the rail and the captions lane.
export function Video(props: IconProps) {
  return <Icon {...props}><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="m10 9 5 3-5 3z" /></Icon>;
}
export function Voice(props: IconProps) {
  return <Icon {...props}><rect x="9" y="3.5" width="6" height="11" rx="3" /><path d="M6 11.5a6 6 0 0 0 12 0M12 17.5v3M9 20.5h6" /></Icon>;
}
export function Music(props: IconProps) {
  return <Icon {...props}><path d="M9 17V6l11-2v11M9 9l11-2" /><ellipse cx="6.5" cy="17.5" rx="2.5" ry="2" /><ellipse cx="17.5" cy="15.5" rx="2.5" ry="2" /></Icon>;
}
export function Overlays(props: IconProps) {
  return <Icon {...props}><rect x="4" y="4" width="11" height="11" rx="2" /><path d="M18 9h2v11H9v-2" /></Icon>;
}
export function Eye(props: IconProps) {
  return <Icon {...props}><path d="M3 12s3-6 9-6 9 6 9 6-3 6-9 6-9-6-9-6Z" /><circle cx="12" cy="12" r="2.5" /></Icon>;
}
export function EyeOff(props: IconProps) {
  return <Icon {...props}><path d="m4 4 16 16M9.5 6.3A10 10 0 0 1 12 6c6 0 9 6 9 6a15 15 0 0 1-2.5 3.3M6.1 7.5A16 16 0 0 0 3 12s3 6 9 6a11 11 0 0 0 4-.8M10.2 10.2a2.5 2.5 0 0 0 3.6 3.6" /></Icon>;
}

// Chrome.
export function Sun(props: IconProps) {
  return <Icon {...props}><circle cx="12" cy="12" r="4" /><path d="M12 3v1M12 20v1M3 12h1M20 12h1M5.6 5.6l.8.8M17.6 17.6l.8.8M5.6 18.4l.8-.8M17.6 6.4l.8-.8" /></Icon>;
}
export function Moon(props: IconProps) {
  return <Icon {...props}><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z" /></Icon>;
}
export function Export(props: IconProps) {
  return <Icon {...props}><path d="M12 15V3.5M7.5 8l4.5-4.5L16.5 8M4.5 14.5V20h15v-5.5" /></Icon>;
}
export function Gear(props: IconProps) {
  return <Icon {...props}><path d="m10 3.5-.5 2.4-2 .9-2.2-.8-2 3.5L5 11v2l-1.7 1.5 2 3.5 2.2-.8 2 .9.5 2.4h4l.5-2.4 2-.9 2.2.8 2-3.5L19 13v-2l1.7-1.5-2-3.5-2.2.8-2-.9-.5-2.4Z" /><circle cx="12" cy="12" r="3" /></Icon>;
}
export function Close(props: IconProps) {
  return <Icon {...props}><path d="m6 6 12 12M6 18 18 6" /></Icon>;
}
export function ChevronLeft(props: IconProps) {
  return <Icon {...props}><path d="m15 6-6 6 6 6" /></Icon>;
}
export function ChevronRight(props: IconProps) {
  return <Icon {...props}><path d="m9 6 6 6-6 6" /></Icon>;
}
export function ChevronDown(props: IconProps) {
  return <Icon {...props}><path d="m6 9 6 6 6-6" /></Icon>;
}
export function Play(props: IconProps) {
  return <Icon {...props}><path d="m8 4.5 12 7.5-12 7.5Z" /></Icon>;
}
export function Pause(props: IconProps) {
  return <Icon {...props}><path d="M8 5v14M16 5v14" /></Icon>;
}
export function FullScreen(props: IconProps) {
  return <Icon {...props}><path d="M9 4H4v5M15 4h5v5M20 15v5h-5M9 20H4v-5" /></Icon>;
}
export function Crop(props: IconProps) {
  return <Icon {...props}><path d="M7 3v14h14M3 7h14v14" /></Icon>;
}
export function Link(props: IconProps) {
  return <Icon {...props}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></Icon>;
}
export function Wand(props: IconProps) {
  return <Icon {...props}><path d="m4.5 17.5 12-12 3 3-12 12ZM14 8l3 3M8 4v2M3.5 8.5h2" /></Icon>;
}
export function Plus(props: IconProps) {
  return <Icon {...props}><path d="M12 5v14M5 12h14" /></Icon>;
}
export function Minus(props: IconProps) {
  return <Icon {...props}><path d="M5 12h14" /></Icon>;
}
export function Star(props: IconProps) {
  return <Icon {...props}><path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3-5.7-3-5.7 3 1.1-6.3-4.6-4.5 6.4-.9Z" /></Icon>;
}
export function Check(props: IconProps) {
  return <Icon {...props}><path d="m5 12 4.5 4.5L19 7" /></Icon>;
}
export function Image(props: IconProps) {
  return <Icon {...props}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="m4 16 5-5 4 4 3-3 4 4" /><circle cx="15" cy="8.5" r=".75" fill="currentColor" stroke="none" /></Icon>;
}
export function Film(props: IconProps) {
  return <Icon {...props}><rect x="4" y="3.5" width="16" height="17" rx="2" /><path d="M8 3.5v17M16 3.5v17M4 9h4M4 15h4M16 9h4M16 15h4" /></Icon>;
}
export function Note(props: IconProps) {
  return <Icon {...props}><path d="M11 17V4l7 2v5l-7-2" /><ellipse cx="8" cy="17.5" rx="3" ry="2.5" /></Icon>;
}

// Editor fallback marks; installed bundles supply their own native app artwork.
export function EditorPremiere(props: IconProps) { return <Icon {...props}><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7 16V8h3a2.5 2.5 0 0 1 0 5H7m7 3v-5m0 2c0-2 2-2 3-2"/></Icon>; }
export function EditorFinalCut(props: IconProps) { return <Icon {...props}><rect x="3" y="8" width="18" height="12" rx="2"/><path d="m3 8 17-5 1 5H3m3-1 2-3m3 2 2-3m3 2 2-3M4 12h16m-9 2 4 2-4 2z"/></Icon>; }
export function EditorCapCut(props: IconProps) { return <Icon {...props}><path d="m4 5 16 11v3H4v-3L20 5M4 8h16"/></Icon>; }
export function EditorResolve(props: IconProps) { return <Icon {...props}><circle cx="12" cy="12" r="9"/><path d="M12 11C6 7 9 4 12 5c3-1 6 2 0 6Zm-1 2c0 7-4 7-5 4-2-2-1-6 5-4Zm2 0c6-2 7 2 5 4-1 3-5 3-5-4Z"/></Icon>; }
export function More(props: IconProps) { return <Icon {...props}><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/></Icon>; }
export function Grid(props: IconProps) { return <Icon {...props}><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></Icon>; }
export function List(props: IconProps) { return <Icon {...props}><path d="M9 6h11M9 12h11M9 18h11M4 6h1M4 12h1M4 18h1"/></Icon>; }
export function FolderOpen(props: IconProps) { return <Icon {...props}><path d="M3 8V5h6l2 3h10v3M3 8v12h16l3-9H7l-3 9"/></Icon>; }
export function ArrowUp(props: IconProps) { return <Icon {...props}><path d="M12 19V5m-6 6 6-6 6 6"/></Icon>; }
export function Attach(props: IconProps) { return <Icon {...props}><path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7"/></Icon>; }
// Footage inspector rows (F2).
export function Clock(props: IconProps) { return <Icon {...props}><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></Icon>; }
export function Calendar(props: IconProps) { return <Icon {...props}><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M8 3v4M16 3v4"/></Icon>; }
export function Camera(props: IconProps) { return <Icon {...props}><path d="M4 8h3l1.5-2h7L17 8h3v11H4Z"/><circle cx="12" cy="13.5" r="3.5"/></Icon>; }
export function FileSize(props: IconProps) { return <Icon {...props}><path d="M6 3.5h8l4 4V20.5H6Z"/><path d="M14 3.5v4h4"/></Icon>; }
export function Frame(props: IconProps) { return <Icon {...props}><rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M8 10v4M12 10v4M16 10v4"/></Icon>; }
export function Volume(props: IconProps) { return <Icon {...props}><path d="M4 10v4h3l5 4V6l-5 4ZM16 9.5a3.5 3.5 0 0 1 0 5M18.5 7a7 7 0 0 1 0 10"/></Icon>; }
export function VolumeOff(props: IconProps) { return <Icon {...props}><path d="M4 10v4h3l5 4V6l-5 4ZM16 10l5 4M21 10l-5 4"/></Icon>; }
export function Pencil(props: IconProps) { return <Icon {...props}><path d="m5 19 1-4L16.5 4.5a2 2 0 0 1 3 3L9 18Z"/></Icon>; }

export function Rotate(props: IconProps) {
  return <Icon {...props}><path d="M20 9a8 8 0 1 0-1 9M20 3v6h-6" /></Icon>;
}
export function Grip(props: IconProps) { return <Icon {...props}><circle cx="9" cy="5" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="5" r="1" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="9" cy="19" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="19" r="1" fill="currentColor" stroke="none"/></Icon>; }
