import { defineConfig } from "vite";

// Milestone 1 is a single-page dev harness — no framework plugins needed.
export default defineConfig({
  server: { open: true },
  build: { target: "es2020" },
});
