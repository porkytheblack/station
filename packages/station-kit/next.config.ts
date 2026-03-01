import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  typescript: {
    tsconfigPath: "./tsconfig.next.json",
  },
};

export default nextConfig;
