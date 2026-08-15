import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // The dashboard does not use next/image. Keeping optimization disabled stops
  // standalone builds from bundling a publisher-machine-specific sharp binary.
  images: { unoptimized: true },
  typescript: {
    tsconfigPath: "./tsconfig.next.json",
  },
};

export default nextConfig;
