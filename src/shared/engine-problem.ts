// ONB2: why an AI engine can't be used right now, read from its own words. Shared so the main process (which
// records the last problem a real call hit) and the shared "Needs your AI" card read errors the same way.
// null means a real failure, not an access problem: it still shows as a failure.
export type EngineProblem = "none" | "not-installed" | "signed-out" | "allowance" | "offline";
export const NO_ENGINE_MESSAGE = "No AI chosen. Add one in Settings to use this.";

export function engineProblemOf(message: string): EngineProblem | null {
  if (!message) return null;
  if (message.startsWith("No AI chosen")) return "none";
  if (/isn't installed|\bENOENT\b/.test(message)) return "not-installed";
  if (/isn't signed in|not logged in|not signed in|please (?:run )?\/?login|invalid api key|authentication_error|401 unauthori/i.test(message)) return "signed-out";
  if (/usage limit|rate limit|limit reached|reached your limit|quota|out of (?:credits|usage)|exceeded your|hour limit|weekly limit|credit balance/i.test(message)) return "allowance";
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|getaddrinfo|network (?:error|is unreachable)|you(?:'re| are) offline|could not resolve host|unable to connect|connection (?:error|refused|reset)/i.test(message)) return "offline";
  return null;
}
