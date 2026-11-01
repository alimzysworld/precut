import { useEffect, useRef, useState } from "react";
import { EDIT_LOOKS, type LookChoice } from "./LookPanel";
import { sampleLookGpu } from "./sampleLookGpu";
import { Slider } from "./Controls";
import { useShortcuts } from "../../hooks/useShortcuts";
import photo from "../../assets/samples/night-city.jpg";
import "./look.css";

export const LOOK_FAMILIES = ["Film", "Warm", "Cool", "Soft", "Mono", "Clean"];
let preparedPhoto: Promise<HTMLImageElement> | undefined;
export function prepareSetupLooks() {
  preparedPhoto ??= new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = error => { preparedPhoto = undefined; reject(error); }; image.src = photo;
  });
  return preparedPhoto;
}
export function forgetSetupLooks() { preparedPhoto = undefined; }
export function SampleLookPicker({ value, disabled, onChoose, onReady }: { value: LookChoice; disabled?: boolean; onChoose: (value: LookChoice) => Promise<boolean>; onReady?: (ready: boolean) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null), strip = useRef<HTMLDivElement>(null);
  const renderer = useRef<ReturnType<typeof sampleLookGpu>>();
  const [images, setImages] = useState<Record<string, string>>({}), [family, setFamily] = useState("Film");
  const [hover, setHover] = useState<string | null>(null), [before, setBefore] = useState(false), [error, setError] = useState<string | null>(null);
  const latest = useRef({ value, hover, before }); latest.current = { value, hover, before };
  const draw = () => {
    const node = canvas.current, gpu = renderer.current; if (!node || !gpu) return;
    const { value, hover, before } = latest.current, size = node.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    gpu.draw(hover ?? value.preset, before ? 0 : value.intensity ?? .7, Math.max(1, Math.round(size.width * dpr)), Math.max(1, Math.round(size.height * dpr)));
  };
  useEffect(() => {
    let active = true;
    void prepareSetupLooks().then(image => {
      if (!active || !canvas.current) return;
      const gpu = renderer.current = sampleLookGpu(canvas.current, image), tiles: Record<string, string> = {};
      const dpr = window.devicePixelRatio || 1;
      for (const look of EDIT_LOOKS) { gpu.draw(look.id, .7, Math.round(92 * dpr), Math.round(78 * dpr)); tiles[look.id] = canvas.current.toDataURL("image/jpeg", .92); }
      setImages(tiles); draw(); onReady?.(true);
    }).catch(() => { if (active) setError("Couldn't show the looks. Reopen this step to try again."); });
    const resize = new ResizeObserver(draw); if (canvas.current) resize.observe(canvas.current);
    const release = () => setBefore(false);
    const keyup = (event: KeyboardEvent) => { if (event.code === "Space") release(); };
    window.addEventListener("keyup", keyup); window.addEventListener("blur", release);
    return () => { active = false; resize.disconnect(); renderer.current?.dispose(); renderer.current = undefined; window.removeEventListener("keyup", keyup); window.removeEventListener("blur", release); };
  }, []);
  useEffect(draw, [value, hover, before]);
  useShortcuts("setup", [{ id: "setup-compare", keys: ["Space"], label: "Hold to compare your look", scope: "setup", enabled: !disabled, handler: () => setBefore(true) }]);
  const shown = EDIT_LOOKS.find(look => look.id === (hover ?? value.preset));
  const choose = (preset: string) => { setHover(null); void onChoose({ ...value, preset, words: null }); };
  return <div className="setup-look">
    <button type="button" className="setup-look-preview" aria-label="Hold to compare your look" title="Hold to compare · Space" disabled={disabled}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); setBefore(true); }} onPointerUp={() => setBefore(false)} onPointerCancel={() => setBefore(false)} onLostPointerCapture={() => setBefore(false)} onBlur={() => setBefore(false)}>
      <img src={photo} alt="Hong Kong street signs and lights at night" /><canvas ref={canvas} aria-hidden="true" />
      <span className="setup-look-name"><b>{before ? "Before" : shown?.name}</b><span>{shown?.description}</span></span><span className="setup-look-hold">Hold to compare</span>
    </button>
    <div className="setup-look-controls"><div role="group" aria-label="Look families" className="flex flex-wrap gap-1">{LOOK_FAMILIES.map(name => <button type="button" key={name} className="look-chip" aria-pressed={family === name} onClick={() => { setFamily(name); const section = strip.current?.querySelector<HTMLElement>(`[data-family="${name}"]`); if (section && strip.current) strip.current.scrollLeft = section.offsetLeft - strip.current.offsetLeft; }}>{name}</button>)}</div>
      <Slider label="Intensity" min={0} max={100} step={1} defaultValue={70} value={Math.round((value.intensity ?? .7) * 100)} disabled={disabled} onChange={amount => void onChoose({ ...value, intensity: amount / 100 })} />
    </div>
    <div ref={strip} className="setup-look-strip" role="group" aria-label="Look gallery" onMouseLeave={() => setHover(null)}>{LOOK_FAMILIES.map(name => <section key={name} data-family={name} className="setup-look-family"><h3>{name}</h3><div>{EDIT_LOOKS.filter(look => look.family === name).map(look => <button type="button" key={look.id} aria-label={look.name} aria-pressed={value.preset === look.id} disabled={disabled} className="setup-look-tile" title={look.description} onMouseEnter={() => setHover(look.id)} onFocus={() => setHover(look.id)} onBlur={() => setHover(null)} onClick={() => choose(look.id)}><img src={images[look.id] ?? photo} alt="" /><span>{look.name}</span></button>)}</div></section>)}</div>
    {error ? <p role="alert" className="text-small text-danger">{error}</p> : null}
  </div>;
}
