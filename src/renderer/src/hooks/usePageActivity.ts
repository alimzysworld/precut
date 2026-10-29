import { createContext, useContext } from "react";
import type { NavState } from "../nav";

/** A retained page owns its route, even while another tab owns the URL. */
export const PageSession = createContext<{ active: boolean; navigation: NavState } | null>(null);
export function usePageActive(): boolean {
  return useContext(PageSession)?.active ?? true;
}
