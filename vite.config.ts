import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

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

// A versioned, same-origin app shell; never cache Supabase responses or usage JSON.
const offlineShell = (): Plugin => ({
  name: "token-view-offline-shell",
  apply: "build",
  closeBundle() {
    const directory = path.resolve("dist");
    const assets = fs.readdirSync(path.join(directory, "assets")).filter((name) => /\.(js|css|woff2?)$/.test(name)).map((name) => `/assets/${name}`);
    const files = ["/index.html", "/manifest.webmanifest", "/icon.png", "/icon-256.png", "/icon-512.png", ...assets];
    const version = createHash("sha256").update(files.map((file) => fs.readFileSync(path.join(directory, file))).reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0))).digest("hex").slice(0, 16);
    fs.writeFileSync(path.join(directory, "sw.js"), `const CACHE = ${JSON.stringify(`token-view-shell-${version}`)};
const FILES = ${JSON.stringify(files)};
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('token-view-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.open(CACHE).then(cache => cache.match('/index.html', { ignoreVary: true }))));
  } else if (!url.search && FILES.includes(url.pathname)) {
    // Vite/static hosts may attach Vary: Origin. Precache and module requests have
    // different Origin headers, but these allowlisted immutable files are identical.
    event.respondWith(caches.open(CACHE).then(cache => cache.match(url.pathname, { ignoreVary: true })).then(cached => cached || fetch(request)));
  }
});
`);
  },
});

export default defineConfig({
  plugins: [react(), devSnapshot(), offlineShell()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
});
