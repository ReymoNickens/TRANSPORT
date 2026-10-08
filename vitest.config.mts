import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));
const emptyModule = fileURLToPath(new URL("./tests/empty-module.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": src,
      // "server-only" throws outside Next's server build; tests run on the server anyway.
      "server-only": emptyModule,
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["src/**/*.test.ts"], environment: "node" },
      },
      {
        extends: true,
        test: {
          name: "db",
          include: ["tests/db/**/*.test.ts"],
          environment: "node",
          globalSetup: ["tests/db/global-setup.ts"],
          setupFiles: ["tests/db/env-setup.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
