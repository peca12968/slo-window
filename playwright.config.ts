import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./browser-tests",
  use: {
    baseURL: "http://127.0.0.1:4173",
    launchOptions: { executablePath: process.env.BROWSER_PATH },
  },
  webServer: {
    command: "npm run dev -- --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
  },
});
