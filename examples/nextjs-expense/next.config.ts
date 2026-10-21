import type { NextConfig } from "next";

const config: NextConfig = {
  // PGlite loads its WebAssembly and data files from its own package directory at runtime.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default config;
