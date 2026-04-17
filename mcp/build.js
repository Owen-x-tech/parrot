#!/usr/bin/env node
// Bundles the MCP server and SessionStart hook into self-contained JS files
// under dist/, so the plugin works without requiring end-users to npm install.

import * as esbuild from "esbuild";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  // Produce ESM output that doesn't choke on dynamic requires / import.meta
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  // Firebase ships CJS that uses some Node built-ins; let esbuild resolve them.
  external: [],
  minify: false,
  sourcemap: false,
  logLevel: "info",
};

await esbuild.build({
  ...common,
  entryPoints: [join(root, "mcp", "index.js")],
  outfile: join(root, "dist", "mcp-server.js"),
});

await esbuild.build({
  ...common,
  entryPoints: [join(root, "hook", "check-inbox.js")],
  outfile: join(root, "dist", "check-inbox.js"),
});

console.log("Built dist/mcp-server.js and dist/check-inbox.js");
