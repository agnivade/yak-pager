import { defineConfig } from "vitest/config"

export default defineConfig({
  server: {
    allowedHosts: ["agniva-thinkpad-p16-gen-2.swordtail-ide.ts.net"],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
})
