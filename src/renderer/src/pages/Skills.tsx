import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CaretDown, Check, FolderOpen, Plus, Trash, X } from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { Skill, SkillFormat } from "../../../shared/schema";
import { getApi } from "../data";
import { Button, EmptyState, FOCUS, Pill, Skeleton } from "../components/ui";
import { pop } from "../motion";

const inputClass = `st-glass-field !border-0 w-full rounded-xl px-3 py-2.5 text-[13px] text-ink outline-none focus-visible:outline-solid ${FOCUS}`;
const sort = (skills: Skill[]) => [...skills].sort((a, b) => Number(b.global) - Number(a.global) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
type SaveStatus = "waiting" | "saving" | "saved" | "error";

export default function Skills() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, SaveStatus>>({});
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleted, setDeleted] = useState<Skill | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  const skillsRef = useRef<Skill[]>([]);
  const dirty = useRef(new Map<string, Skill>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const request = useRef(0);
  const deleting = useRef(new Set<string>());
  const reduceMotion = useReducedMotion();

  const apply = useCallback((next: Skill[]) => {
    skillsRef.current = sort(next);
    if (alive.current) setSkills(skillsRef.current);
  }, []);

  const refresh = useCallback(async () => {
    const version = ++request.current;
    try {
      const next = await getApi().listSkills();
      if (!alive.current || version !== request.current) return;
      // A filesystem notification must not erase a draft waiting to autosave.
      const merged = new Map(next.filter((skill) => !deleting.current.has(skill.id)).map((skill) => [skill.id, skill]));
      dirty.current.forEach((skill, id) => { if (!deleting.current.has(id)) merged.set(id, skill); });
      apply([...merged.values()]);
      setSelectedId((id) => id && merged.has(id) ? id : sort([...merged.values()])[0]?.id ?? null);
      setError(null);
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : "Could not load skills.");
    } finally { if (alive.current) setLoading(false); }
  }, [apply]);

  const save = useCallback((skill: Skill): Promise<void> => {
    clearTimeout(timers.current.get(skill.id));
    timers.current.delete(skill.id);
    const operation = queue.current.then(async () => {
      if (alive.current) setStatus((prev) => ({ ...prev, [skill.id]: "saving" }));
      try {
        const saved = await getApi().saveSkill(skill);
        if (dirty.current.get(skill.id) === skill) {
          dirty.current.delete(skill.id);
          if (alive.current) {
            apply(skillsRef.current.map((current) => current.id === saved.id ? saved : saved.global ? { ...current, global: false } : current));
            setStatus((prev) => ({ ...prev, [skill.id]: "saved" }));
          }
        }
        await refresh();
      } catch (cause) {
        if (alive.current) {
          setStatus((prev) => ({ ...prev, [skill.id]: "error" }));
          setError(cause instanceof Error ? cause.message : "Could not save this skill.");
        }
        throw cause;
      }
    });
    queue.current = operation.catch(() => {});
    return operation;
  }, [apply, refresh]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const unsubscribe = getApi().onSkillsChanged(() => { void refresh(); });
    return () => {
      alive.current = false;
      unsubscribe();
      // Switching pages should not lose the last 600 ms of typing.
      timers.current.forEach(clearTimeout);
      timers.current.clear();
      dirty.current.forEach((skill) => { void save(skill).catch(() => {}); });
    };
  }, [refresh, save]);

  useEffect(() => {
    if (!deleted && !notice) return;
    const timer = setTimeout(() => { setDeleted(null); setNotice(null); }, 10000);
    return () => clearTimeout(timer);
  }, [deleted, notice]);

  function edit(patch: Partial<Skill>) {
    const current = skillsRef.current.find((skill) => skill.id === selectedId);
    if (!current) return;
    const next = { ...current, ...patch };
    dirty.current.set(next.id, next);
    apply(skillsRef.current.map((skill) => skill.id === next.id ? next : skill));
    setStatus((prev) => ({ ...prev, [next.id]: "waiting" }));
    setError(null);
    setConfirmId(null);
    clearTimeout(timers.current.get(next.id));
    timers.current.set(next.id, setTimeout(() => { void save(next).catch(() => {}); }, 600));
  }

  async function newSkill() {
    setBusy(true); setError(null); setConfirmId(null);
    let id = "new-skill";
    let suffix = 2;
    while (skillsRef.current.some((skill) => skill.id === id)) id = `new-skill-${suffix++}`;
    const skill: Skill = {
      id, name: "New skill", description: "", global: false, path: "",
      format: skillsRef.current.find((s) => s.global)?.format ?? { aspect: "9:16", width: 1080, height: 1920, fps: null },
      body: "",
    };
    dirty.current.set(id, skill);
    apply([...skillsRef.current, skill]);
    setSelectedId(id);
    try { await save(skill); }
    catch { /* draft stays available for retry */ }
    finally { if (alive.current) setBusy(false); }
  }

  async function remove(skill: Skill) {
    setBusy(true); setError(null);
    try {
      const pending = dirty.current.get(skill.id);
      if (pending) await save(pending);
      await queue.current;
      deleting.current.add(skill.id);
      await getApi().deleteSkill(skill.id);
      dirty.current.delete(skill.id);
      apply(skillsRef.current.filter((current) => current.id !== skill.id));
      setSelectedId(skillsRef.current[0]?.id ?? null);
      setConfirmId(null); setDeleted(skill); setNotice(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not move this skill to the Trash.");
    } finally {
      deleting.current.delete(skill.id);
      setBusy(false);
      void refresh();
    }
  }

  async function undo() {
    if (!deleted) return;
    const skill = deleted;
    setBusy(true); setError(null);
    try {
      await queue.current;
      if ((await getApi().listSkills()).some((current) => current.id === skill.id)) {
        throw new Error("A skill with this id already exists. The deleted version is still in the Trash.");
      }
      // The API exposes Trash but no restore operation. Recreate the contents
      // rather than guessing which file in the system Trash belongs to us.
      const restored = await getApi().saveSkill({ ...skill, global: false });
      setDeleted(null); setNotice("Skill restored.");
      await refresh(); setSelectedId(restored.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not restore this skill.");
    } finally { setBusy(false); }
  }

  const selected = skills.find((skill) => skill.id === selectedId);
  const selectedStatus = selected ? status[selected.id] : undefined;
  const format = selected?.format ?? skills.find((skill) => skill.global)?.format ?? DEFAULT_FORMAT;
  function changeFormat(patch: Partial<SkillFormat>) { edit({ format: { ...format, ...patch } }); }
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-[19px] font-semibold text-ink">Skills</h2>
        <div className="flex gap-1">
          <Button variant="ghost" onClick={() => { void getApi().revealSkills().catch(() => setError("Could not open the skills folder.")); }}><FolderOpen size={15} /> Show in Finder</Button>
          <Button variant="primary" onClick={() => void newSkill()} disabled={busy || loading}><Plus size={15} /> New skill</Button>
        </div>
      </div>
      {error ? <div role="alert" className="mb-4 flex items-center gap-3 text-[13px] text-danger">{error}<Button variant="ghost" onClick={() => { const draft = selected && dirty.current.get(selected.id); if (draft) void save(draft).catch(() => {}); else void refresh(); }}>Retry</Button></div> : null}
      {loading ? <Skeleton kind="list" count={2} /> : (
        <div className="grid items-start gap-5 md:grid-cols-[160px_minmax(0,1fr)]">
          <div className="flex flex-col gap-1" aria-label="Skills list">
            {skills.map((skill) => (
              <button key={skill.id} onClick={() => { setSelectedId(skill.id); setConfirmId(null); }} aria-pressed={selectedId === skill.id}
                className={`w-full rounded-xl px-3 py-3 text-left outline-none ${FOCUS} ${selectedId === skill.id ? "bg-ink/[0.07]" : "hover:bg-ink/[0.04]"}`}>
                <span className="block break-words text-[13px] font-medium text-ink">{skill.name || "Untitled skill"}</span>
                {skill.global ? <span className="mt-1 block"><Pill>always on</Pill></span> : null}
              </button>
            ))}
          </div>
          {selected ? (
            <div className="min-w-0">
              <div className="space-y-3">
                <label className="block text-[12px] font-medium text-muted" htmlFor="skill-name">Name<input id="skill-name" className={`${inputClass} mt-1`} value={selected.name} disabled={busy} onChange={(event) => edit({ name: event.target.value })} /></label>
                <label className="block text-[12px] font-medium text-muted" htmlFor="skill-description">When to use it<input id="skill-description" className={`${inputClass} mt-1`} value={selected.description} disabled={busy} onChange={(event) => edit({ description: event.target.value })} /></label>
              </div>
              <div className="my-4 flex flex-wrap items-end gap-2" role="group" aria-label="Skill format">
                <div className="min-w-0 text-[11px] text-muted">Aspect
                  <FormatSelect label="Aspect" value={format.aspect} disabled={busy} options={Object.keys(SIZES).map((value) => ({ value, label: value }))}
                    onChange={(value) => { const aspect = value as SkillFormat["aspect"]; changeFormat({ aspect, ...SIZES[aspect] }); }} />
                </div>
                <label className="text-[11px] text-muted">Resolution
                  <span className="mt-1 flex items-center gap-1">
                    <input aria-label="Resolution width" type="number" min={1} max={16384} step={1} value={format.width} disabled={busy} onChange={(event) => { if (event.target.validity.valid && event.target.value) changeFormat({ width: Number(event.target.value) }); }} className={`${inputClass} !w-[72px] !px-2 !py-2`} />
                    <span>×</span><input aria-label="Resolution height" type="number" min={1} max={16384} step={1} value={format.height} disabled={busy} onChange={(event) => { if (event.target.validity.valid && event.target.value) changeFormat({ height: Number(event.target.value) }); }} className={`${inputClass} !w-[72px] !px-2 !py-2`} />
                  </span>
                </label>
                <div className="text-[11px] text-muted">Frame rate
                  <FormatSelect label="Frame rate" value={format.fps?.toString() ?? "match"} disabled={busy} options={[{ value: "match", label: "Match footage" }, ...[24, 25, 30, 50, 60].map((fps) => ({ value: String(fps), label: String(fps) }))]}
                    onChange={(value) => changeFormat({ fps: value === "match" ? null : Number(value) })} />
                </div>
              </div>
              <div className="rounded-2xl bg-ink/[0.025] py-4" aria-label="Skill body">
                <Suspense fallback={<div className="px-5"><Skeleton /><p className="mt-3 text-[12px] text-muted">Opening editor</p></div>}>
                  <RichEditor key={selected.id} body={selected.body} disabled={busy} onChange={(body) => edit({ body })} />
                </Suspense>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <span role="status" aria-live="polite" className="flex items-center gap-1 text-[12px] text-muted">
                  {selectedStatus === "saved" ? <><Check size={13} /> saved</> : selectedStatus === "error" ? "could not save" : selectedStatus === "saving" ? "saving" : selectedStatus === "waiting" ? "unsaved" : "Markdown on disk"}
                </span>
                {!selected.global && <Button variant="ghost" disabled={busy} onClick={() => setConfirmId(selected.id)}><Trash size={14} /> Delete skill</Button>}
              </div>
              {confirmId === selected.id && !selected.global && <div role="group" aria-label="Confirm delete" className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-ink/[0.04] p-3">
                <p className="w-full text-[13px] text-ink">Move {selected.name} to the Trash?</p>
                <Button onClick={() => setConfirmId(null)} disabled={busy}>Keep skill</Button>
                <Button onClick={() => void remove(selected)} disabled={busy} className="text-danger">Move to Trash</Button>
              </div>}
            </div>
          ) : <EmptyState title="No skills yet"><Button variant="primary" onClick={() => void newSkill()}>New skill</Button></EmptyState>}
        </div>
      )}
      <AnimatePresence>
        {deleted || notice ? (
          <motion.div key="skill-toast" variants={reduceMotion ? undefined : pop} initial={reduceMotion ? false : "initial"} animate="animate" exit="exit" role="status"
            className="st-glass-pop fixed bottom-8 left-1/2 z-50 flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-3 rounded-full px-5 py-3">
            <span className="text-[13px] text-ink">{deleted ? `${deleted.name} moved to the Trash.` : notice}</span>
            {deleted ? <Button variant="ghost" onClick={() => void undo()} disabled={busy}>Undo</Button> : null}
            <Button variant="ghost" aria-label="Dismiss notification" onClick={() => { setDeleted(null); setNotice(null); }}><X size={14} /></Button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

const DEFAULT_FORMAT: SkillFormat = { aspect: "9:16", width: 1080, height: 1920, fps: null };
const SIZES: Record<SkillFormat["aspect"], { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 }, "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 }, "4:5": { width: 1080, height: 1350 },
};
type EditorProps = { body: string; disabled: boolean; onChange: (body: string) => void };
// All BlockNote runtime imports and its CSS sit behind React.lazy. Nothing
// from the editor is downloaded until someone opens a skill.
const RichEditor = lazy(async () => {
  const [{ useCreateBlockNote }, { BlockNoteView }] = await Promise.all([
    import("@blocknote/react"), import("@blocknote/mantine"), import("@blocknote/mantine/style.css"),
  ]);
  return { default: function SkillEditor({ body, disabled, onChange }: EditorProps) {
    const editor = useCreateBlockNote();
    const syncing = useRef(false);
    const lastBody = useRef<string>();
    const snapshot = useRef("");
    const [theme, setTheme] = useState<"dark" | "light">(() => document.documentElement.dataset.theme === "light" ? "light" : "dark");
    useEffect(() => {
      const observer = new MutationObserver(() => setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark"));
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      return () => observer.disconnect();
    }, []);
    useLayoutEffect(() => {
      if (lastBody.current === body) return;
      syncing.current = true;
      try {
        const blocks = editor.tryParseMarkdownToBlocks(body);
        editor.replaceBlocks(editor.document, blocks.length ? blocks : [{ type: "paragraph" }]);
        snapshot.current = JSON.stringify(editor.document);
        lastBody.current = body;
      } finally { syncing.current = false; }
    }, [body, editor]);
    return <>
      <style>{`
        .st-skill-editor { --bn-colors-editor-background: transparent; --bn-colors-editor-text: var(--ink); --bn-font-family: inherit; }
        .st-skill-editor .bn-editor { background: transparent; color: var(--ink); min-height: 240px; padding: 0 32px; font-size: 13px; line-height: 1.7; }
        .st-skill-editor .bn-editor:focus { outline: none; }
        .st-skill-editor .bn-editor:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
        .st-skill-editor .bn-block-content[data-content-type="heading"] { font-family: var(--font-display); }
        .st-skill-editor .bn-block-content[data-content-type="heading"][data-level="1"] { font-size: 22px; }
        .st-skill-editor .bn-block-content[data-content-type="heading"][data-level="2"] { font-size: 18px; }
        .st-skill-editor .bn-block-content[data-content-type="heading"][data-level="3"] { font-size: 16px; }
      `}</style>
      <BlockNoteView className="st-skill-editor" editor={editor} theme={theme} editable={!disabled} filePanel={false}
        onChange={() => {
          if (syncing.current) return;
          const nextSnapshot = JSON.stringify(editor.document);
          if (nextSnapshot === snapshot.current) return;
          snapshot.current = nextSnapshot;
          const markdown = editor.blocksToMarkdownLossy(editor.document);
          lastBody.current = markdown;
          onChange(markdown);
        }} />
    </>;
  } };
});

function FormatSelect({ label, value, options, disabled, onChange }: { label: string; value: string; options: { value: string; label: string }[]; disabled: boolean; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", outside);
    root.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);
  return <div ref={root} className="relative mt-1" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}
    onKeyDown={(event) => {
      if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!open) { setOpen(true); return; }
        const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }
    }}>
    <button ref={trigger} type="button" aria-label={label} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)} className={`st-glass-field !border-0 flex items-center gap-2 rounded-xl px-2 py-2 text-[13px] text-ink ${FOCUS}`}>
      {options.find((option) => option.value === value)?.label ?? value}<CaretDown size={12} />
    </button>
    {open && <div role="listbox" aria-label={label} className="st-glass-pop absolute top-full left-0 z-20 mt-1 min-w-full rounded-xl p-1">
      {options.map((option) => <button key={option.value} type="button" role="option" aria-selected={option.value === value} onClick={() => { onChange(option.value); setOpen(false); trigger.current?.focus(); }} className={`block w-full whitespace-nowrap rounded-lg px-3 py-2 text-left text-[13px] text-ink hover:bg-ink/[0.06] ${option.value === value ? "bg-ink/[0.07]" : ""} ${FOCUS}`}>{option.label}</button>)}
    </div>}
  </div>;
}
