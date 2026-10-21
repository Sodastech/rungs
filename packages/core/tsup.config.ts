import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/store.ts", "src/engine.ts"],
  format: ["esm"],
  target: "node22",
  dts: true,
  sourcemap: true,
  clean: true,
});
