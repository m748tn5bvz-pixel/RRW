import { defineConfig } from "vite";

export default defineConfig({
  // Los datos convertidos por el importador se sirven como estáticos en local.
  publicDir: "assets",
  server: { port: 5173, strictPort: true },
});
