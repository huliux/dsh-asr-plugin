import type { UserConfig } from "tsdown";

const CLIENT_ID = "@huliux/dsh-asr-plugin";
const EXTERNALS = new Set(["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives"]);

const config: UserConfig = {
  name: `${CLIENT_ID}/client`,
  entry: { client: "src/client/index.tsx" },
  outDir: "dist",
  format: "cjs",
  platform: "browser",
  target: "es2024",
  clean: false,
  dts: false,
  sourcemap: true,
  css: { minify: true },
  plugins: [{
    name: "dsh-asr-inline-css",
    generateBundle: { order: "post", handler(_, bundle) {
      const css = bundle["style.css"];
      const client = bundle["client.js"];
      if (css?.type !== "asset" || client?.type !== "chunk") throw new Error("CLIENT_CSS_MISSING");
      const text = typeof css.source === "string" ? css.source : new TextDecoder().decode(css.source);
      const selector = 'style[data-plugin-css="@huliux/dsh-asr-plugin/client"]';
      client.code = `${client.code}
if (typeof document !== "undefined" && !document.querySelector(${JSON.stringify(selector)})) {
        const style = document.createElement("style");
        style.dataset.plugin = "@huliux/dsh-asr-plugin";
        style.dataset.pluginCss = "@huliux/dsh-asr-plugin/client";
        style.textContent = ${JSON.stringify(text)};
        document.head.appendChild(style);
      }`;
    } },
  }],
  deps: {
    neverBundle: (specifier: string) => EXTERNALS.has(specifier),
    alwaysBundle: (specifier: string) => !EXTERNALS.has(specifier),
  },
  outputOptions: {
    entryFileNames: "client.js",
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {`,
    footer: "return module.exports; } });",
    intro: "var module = { exports: {} }; var exports = module.exports;",
  },
};

export default config;
