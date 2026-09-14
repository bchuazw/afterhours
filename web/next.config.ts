import type { NextConfig } from "next";

const ghPages = process.env.GH_PAGES === "true";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  ...(ghPages ? { basePath: "/afterhours", assetPrefix: "/afterhours/" } : {}),
  reactStrictMode: true,
  // wagmi/viem pull in optional node-only deps for WalletConnect that we never use.
  webpack: (config) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, net: false, tls: false };
    config.externals.push("pino-pretty", "lokijs", "encoding");
    return config;
  },
};

export default nextConfig;
