/** Whisper can split compounds into `full` and `-time` (or `full-`, `time`). */
export function transcriptSeparator(previous: string, next = ""): string {
  const left = previous.trim(), right = next.trim();
  return /[\p{L}\p{N}]-$/u.test(left) && /^[\p{L}\p{N}]/u.test(right) ||
    /[\p{L}\p{N}]$/u.test(left) && /^-[\p{L}\p{N}]/u.test(right) ||
    /[\p{L}\p{N}]$/u.test(left) && right === "-" || left === "-" && /^[\p{L}\p{N}]/u.test(right) ? "" : " ";
}

export function transcriptText(tokens: string[]): string {
  return tokens.map(token => token.trim()).filter(Boolean).reduce((text, token) =>
    text + (text ? transcriptSeparator(text, token) : "") + token, "")
    .replace(/([\p{L}\p{N}])\s+-([\p{L}\p{N}])/gu, "$1-$2")
    .replace(/([\p{L}\p{N}])-\s+(?=[\p{L}\p{N}])/gu, "$1-");
}

/** Keep compounds in one caption cue, retaining all source tokens and timings. */
export function transcriptGroups<T>(tokens: T[], text: (token: T) => string, samePiece: (left: T, right: T) => boolean) {
  const groups: { text: string; tokens: T[] }[] = [];
  for (const token of tokens) {
    const previous = groups.at(-1);
    if (previous && samePiece(previous.tokens.at(-1)!, token) && transcriptSeparator(previous.text, text(token)) === "") {
      previous.text = transcriptText([previous.text, text(token)]);
      previous.tokens.push(token);
    } else groups.push({ text: transcriptText([text(token)]), tokens: [token] });
  }
  return groups;
}
