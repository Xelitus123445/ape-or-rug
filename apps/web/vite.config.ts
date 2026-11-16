import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: { target: "es2022" },
  // The room socket goes to the game server (pnpm dev starts both).
  server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy: { "/ws": { target: "ws://127.0.0.1:8787", ws: true } } },
});
