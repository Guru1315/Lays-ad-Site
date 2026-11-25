import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Test-only keys and bindings. Real secrets are never needed to run the tests.
        bindings: {
          ALLOWED_ORIGINS: "https://guru-lays-site.vercel.app,http://localhost:3000",
          EMAIL_ENC_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
          EMAIL_HASH_KEY: "Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA=",
          PROXY_SECRET: "test-proxy-secret-0123456789abcdef",
          // Pinned so a developer's .dev.vars (e.g. RP_ID=localhost) never changes test results.
          RP_ID: "guru-lays-site.vercel.app",
          RP_NAME: "Crunch Lab",
          RP_ORIGINS: "https://guru-lays-site.vercel.app",
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
      },
    })),
  ],
  test: { setupFiles: ["./test/setup.ts"] },
});
