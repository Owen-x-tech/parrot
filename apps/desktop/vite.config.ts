import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  publicDir: new URL("../../assets", import.meta.url).pathname,
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
  build: { target: "es2022", minify: process.env.TAURI_DEBUG ? false : "esbuild" },
  test: { environment: "jsdom", setupFiles: "./src/test/setup.ts" },
});
