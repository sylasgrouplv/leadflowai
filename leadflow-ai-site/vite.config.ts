import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// SPA build for LeadFlow AI. The production server (serve.ts) serves the built
// static bundle on port 3000 and mounts the Hono API under /api on the same
// port — one process, one public surface.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    host: true,
    allowedHosts: true,
    hmr: { clientPort: 443 },
    fs: { strict: true, allow: [import.meta.dirname], deny: [".env", ".env.*", "**/.run/**", "**/.git/**", "**/.data/**"] },
  },
});
