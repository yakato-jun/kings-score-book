import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cloud Run 用に最小依存のサーバをビルド(.next/standalone に server.js＋必要な node_modules だけ trace)。
  output: "standalone",
};

export default nextConfig;
