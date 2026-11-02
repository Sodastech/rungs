import type { NextConfig } from "next";

const config: NextConfig = {
  // PGlite loads its WebAssembly and data files from its own package directory at runtime.
  serverExternalPackages: ["@electric-sql/pglite"],
  poweredByHeader: false,
  // The only images are two small SVG icons, so nothing needs the image optimizer.
  images: { unoptimized: true },
  experimental: { serverActions: { bodySizeLimit: "32kb" } },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default config;
