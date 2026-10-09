/**
 * build.mjs — 把 src/client/index.jsx 打成 lib/client.js。
 *
 * 客户端产物必须是「注册工厂」形态：执行时只调用
 * `window.__ModuleLoader__.load({ id, factory })` 注册工厂，模块体副作用留到
 * factory 被物化时执行。react / react-dom / @deepseek-ai/* 保持 external，
 * 由 Harness 的客户端模块加载器在运行时提供。
 *
 * 宿主半（lib/index.js）是手写 ESM，不需要构建。
 *
 * 用法：pnpm install && pnpm run build
 */
import { build } from "esbuild";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PKG = "dsh-apple-read";

const banner = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PKG)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`;
const footer = `
\t\treturn module.exports;
\t}
});
`;

await build({
  entryPoints: [join(here, "src/client/index.jsx")],
  loader: { ".css": "text" },
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "chrome120",
  jsx: "automatic",
  jsxImportSource: "react",
  outfile: join(here, "lib/client.js"),
  external: ["react", "react/jsx-runtime", "react-dom", "react-dom/client", "@deepseek-ai/*"],
  sourcemap: false,
  logLevel: "info",
  legalComments: "none",
  banner: { js: banner },
  footer: { js: footer },
});

console.log(`client lib/client.js ${(statSync(join(here, "lib/client.js")).size / 1024).toFixed(1)} KB`);
