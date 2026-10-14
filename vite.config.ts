import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";

// Serves .dev/snapshot.json at /dev-snapshot.json during `vite` dev only, so the UI can
// be worked on in a browser without the Tauri backend. Never part of a build.
const devSnapshot = (): Plugin => ({
  name: "dev-snapshot",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use("/dev-snapshot.json", (_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(fs.readFileSync(".dev/snapshot.json"));
    });
  },
});

export default defineConfig({
  plugins: [react(), devSnapshot()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
});
