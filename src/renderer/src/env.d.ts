/// <reference types="vite/client" />
import type { Api } from "../../shared/schema";

declare global {
  interface Window {
    api: Api;
    stFiles?: {
      pathFor(file: File): string;
    };
  }
}

export {};
