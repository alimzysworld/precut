import { Fragment, type ReactNode } from "react";

/** Claude's replies: paragraphs, lists, **bold**, `code` and fenced code. Text only, never HTML. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) => part.startsWith("`") && part.endsWith("`") && part.length > 2 ? <code key={i}>{part.slice(1, -1)}</code>
    : part.startsWith("**") && part.endsWith("**") && part.length > 4 ? <b key={i}>{part.slice(2, -2)}</b> : <Fragment key={i}>{part}</Fragment>);
}
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const parts = text.split(/```[^\n]*\n?/);
  parts.forEach((part, p) => {
    if (p % 2) { blocks.push(<pre key={`c${p}`}>{part.replace(/\n$/, "")}</pre>); return; }
    let list: {text:string; number?:number}[] = [], ordered = false;
    const flush = (key: string) => { if (list.length) blocks.push(ordered ? <ol key={key} start={list[0].number}>{list.map((x, i) => <li key={i} value={x.number}>{inline(x.text)}</li>)}</ol> : <ul key={key}>{list.map((x, i) => <li key={i}>{inline(x.text)}</li>)}</ul>); list = []; };
    part.split(/\n{2,}/).forEach((para, i) => {
      for (const line of para.split("\n")) {
        const bullet = /^\s*[-*]\s+(.*)$/.exec(line), number = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
        if (bullet || number) { if (list.length && ordered !== !!number) flush(`l${p}-${i}-${blocks.length}`); ordered = !!number; list.push(number ? {text:number[2],number:Number(number[1])} : {text:bullet![1]}); continue; }
        flush(`l${p}-${i}-${blocks.length}`);
        if (!line.trim()) continue;
        const heading = /^#{1,6}\s+(.*)$/.exec(line);
        blocks.push(<p key={`p${p}-${i}-${blocks.length}`} className={heading ? "cc-strong" : undefined}>{inline(heading ? heading[1] : line)}</p>);
      }
      flush(`l${p}-${i}-end`);
    });
  });
  return <>{blocks}</>;
}

