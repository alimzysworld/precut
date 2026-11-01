import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const SERIF = resolve("src/main/titles/fonts/instrument-serif");

export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: resolve("src/main/index.ts"), "grade-worker": resolve("src/main/grade-worker.ts"), "balance-worker": resolve("src/main/balance-worker.ts") } } },
    plugins: [externalizeDepsPlugin(), {
      // A self-contained template: packaged renders never depend on node_modules,
      // a network font, or an OS-installed font. This also runs in dev builds.
      name: "title-template",
      generateBundle() {
        const faces: string[] = ["/* Bundled font licences:\n" + ["@fontsource/outfit", "@fontsource-variable/inter", "@fontsource/montserrat", "@fontsource/poppins", "@fontsource/bebas-neue", "@fontsource/archivo-black", "@fontsource/caveat"]
          .map(pkg => readFileSync(resolve("node_modules", pkg, "LICENSE"), "utf8")).join("\n\n") + "\n\n" + readFileSync(resolve(SERIF, "LICENSE"), "utf8") + "\n*/"];
        const embed = (family: string, file: string, weight: string, style: string, range: string) => {
          const data = readFileSync(file.startsWith("/") ? file : resolve("node_modules", file)).toString("base64");
          faces.push(`@font-face{font-family:"${family}";font-weight:${weight};font-style:${style};font-display:block;src:url(data:font/woff2;base64,${data}) format("woff2");unicode-range:${range}}`);
        };
        const ranges = {
          latin: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
          "latin-ext": "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0300-0303,U+0305-0307,U+0309-0328,U+032A-036F,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
        };
        for (const [subset, range] of Object.entries(ranges)) {
          for (const style of ["normal", "italic"]) {
            embed("Inter Display", `@fontsource-variable/inter/files/inter-${subset}-standard-${style}.woff2`, "100 900", style, range);
          }
          for (const weight of [600, 700, 800, 900]) {
            embed("Outfit", `@fontsource/outfit/files/outfit-${subset}-${weight}-normal.woff2`, String(weight), "normal", range);
          }
        }
        for (const [family, slug, weight] of [["Montserrat", "montserrat", 800], ["Poppins", "poppins", 800], ["Bebas Neue", "bebas-neue", 400], ["Archivo Black", "archivo-black", 400], ["Caveat", "caveat", 700]] as const) {
          embed(family, `@fontsource/${slug}/files/${slug}-latin-${weight}-normal.woff2`, "100 900", "normal", ranges.latin);
        }
        // The opening caption is italic and heavy: real italic faces where the caption family has them (LivePlayer matches).
        for (const [family, slug] of [["Montserrat", "montserrat"], ["Poppins", "poppins"]] as const) {
          embed(family, `@fontsource/${slug}/files/${slug}-latin-800-italic.woff2`, "100 800", "italic", ranges.latin);
          embed(family, `@fontsource/${slug}/files/${slug}-latin-900-italic.woff2`, "900", "italic", ranges.latin);
        }
        // CAP4: Instrument Serif (SIL OFL 1.1, vendored with its licence in src/main/titles/fonts, so nothing downloads), the
        // Film captions' serif. One weight: its face covers every weight a cue asks for, so it is never drawn faux bold.
        for (const [subset, range] of Object.entries(ranges)) for (const style of ["normal", "italic"]) {
          embed("Instrument Serif", resolve(SERIF, `instrument-serif-${subset}-400-${style}.woff2`), "100 900", style, range);
        }
        const template = readFileSync(resolve("src/main/titles/template.html"), "utf8");
        this.emitFile({ type: "asset", fileName: "titles/template.html", source: template.replace("/*__TITLE_FONTS__*/", faces.join("\n")) });
      },
    }],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve("src/main/terminal-preload.ts") } } },
  },
  renderer: {
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
        "@shared": resolve("src/shared"),
      },
    },
    plugins: [react(), tailwindcss()],
  },
});
