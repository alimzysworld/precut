import { Component, type ReactNode } from "react";
import { InlineError } from "./patterns";

/** 0.7.1: a part of the screen that can't draw (a viewer, a panel) says so in place, in plain words, and the rest of
 * precut keeps working. It tries again when what it shows changes (resetKey), or on Try again. */
export class PanelBoundary extends Component<{ label: string; resetKey?: unknown; children?: ReactNode }, { error: Error | null; key: unknown }> {
  state = { error: null as Error | null, key: this.props.resetKey };
  static getDerivedStateFromError(error: Error) { return { error }; }
  static getDerivedStateFromProps(props: { resetKey?: unknown }, state: { error: Error | null; key: unknown }) { return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null; }
  componentDidCatch(error: Error) { console.error(`[precut] couldn't show ${this.props.label}`, error); }
  render() {
    if (!this.state.error) return this.props.children;
    return <div data-panel-error className="flex flex-col items-start gap-2 p-4">
      <InlineError className="text-small text-muted">{`Couldn't show ${this.props.label}. Your edit is safe.`}</InlineError>
      <button type="button" onClick={() => this.setState({ error: null })} className="rounded-full bg-ink/[0.06] px-3 py-1 text-micro text-ink outline-none hover:bg-ink/[0.1] focus-visible:bg-ink/[0.1]">Try again</button>
    </div>;
  }
}
