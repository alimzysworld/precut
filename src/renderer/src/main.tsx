import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@fontsource-variable/inter";
import "@fontsource/outfit/400.css";
import "@fontsource/outfit/500.css";
import "@fontsource/outfit/600.css";
import "@fontsource/outfit/700.css";
import "./brand.css";

const root = document.documentElement;
root.classList.toggle("st-vibrant", Boolean(window.api) && /Mac/i.test(navigator.platform));

// The existing theme helper writes legacy meta colours. Follow its root theme
// changes here so the chrome always matches the current solid window ground.
function syncThemeColor(): void {
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    "content", getComputedStyle(root).getPropertyValue("--ground").trim(),
  );
}
syncThemeColor();
new MutationObserver(syncThemeColor).observe(root, {
  attributes: true,
  attributeFilter: ["data-theme"],
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
