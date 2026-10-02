import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [
    {
      name: "cli-hashbang-for-tests",
      enforce: "pre",
      transform(code, id) {
        // Vitest inlines local .mjs files; SSR import hoisting moves the hashbang
        // off the first line. Keep CLI source and test line numbers unchanged.
        if (id.replace(/\\/g, "/").endsWith("/scripts/test-qa-postgres.mjs") && code.startsWith("#!")) {
          return { code: `//${code.slice(2)}`, map: null };
        }
      },
    },
    react(),
  ],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}", "worker/test/**/*.{test,spec}.{ts,tsx}", "scripts/**/*.test.mjs"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
