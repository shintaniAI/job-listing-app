import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Ensure the Japanese font files in public/fonts are bundled into the
  // serverless function output so PDF generation works on Vercel.
  outputFileTracingIncludes: {
    "/api/pdf": [
      "./public/fonts/**/*",
    ],
  },
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
