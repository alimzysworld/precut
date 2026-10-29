import type { Api } from "../../../../shared/schema";
type Source = NonNullable<Parameters<Api["createCut"]>[1]["from"]>[number];
const selections = new Map<string, { keys: string[]; sources: Source[] }>();
export function selectedSources(root: string): Source[] { return selections.get(root)?.sources ?? []; }
export function selectedKeys(root: string): string[] { return selections.get(root)?.keys ?? []; }
export function rememberSelection(root: string, keys: string[], sources: Source[]) { selections.set(root, { keys, sources }); }
