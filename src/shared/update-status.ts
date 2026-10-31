// SIGN2: what the updater tells the top bar and Settings. Main owns it (src/main/updater.ts).
export type UpdateState = "off" | "idle" | "checking" | "current" | "downloading" | "ready" | "failed";
export interface UpdateStatus {
  state: UpdateState;
  version: string;            // the installed version
  next?: string;              // the version on offer
  pct?: number;               // download progress, 0 to 100
  preparing?: boolean;        // downloading: the zip is down and Squirrel is unzipping and checking it
  failedAt?: "check" | "download" | "verify" | "install";
  message?: string;           // plain words, shown as is
  checkedAt?: string;         // ISO time of the last finished check
  manual?: boolean;           // the last check was asked for in Settings
}

