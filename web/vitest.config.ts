import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests live next to the code they test. `lib/**/*.test.ts` also picks
// up tests written by other agents (for example lib/audio/renderLoop.test.ts);
// component tests use `react-dom/server` so they run in node without a DOM.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "components/**/*.test.tsx"],
    exclude: ["node_modules/**", ".next/**"],
  },
});
