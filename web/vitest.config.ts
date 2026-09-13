import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests live next to the code they test. `lib/**/*.test.ts` also picks
// up tests written by other agents (for example lib/audio/renderLoop.test.ts);
// component tests use `react-dom/server` so they run in node without a DOM.
// `app/api/**/route.test.ts` runs the route handlers themselves against the
// Supabase double in lib/testing.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      // `import "server-only"` throws outside a React server build; under
      // vitest the marker resolves to an empty module instead.
      "server-only": fileURLToPath(new URL("./lib/testing/serverOnly.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "components/**/*.test.tsx", "app/**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
    setupFiles: ["./lib/testing/setup.ts"],
  },
});
