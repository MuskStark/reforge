/** @type {import('next').NextConfig} */
const nextConfig = {
  // Docker 生产部署：standalone 产物自带最小 server，镜像更小
  output: "standalone",
  // 不在源站压缩：Cloudflare 边缘按客户端能力重新编码，静态资源才能拿到 brotli（比 gzip 小约 15%）；
  // 源站一旦自己 gzip，边缘会原样缓存 gzip 版本，brotli 永远不生效
  compress: false,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // 后端地址可在容器运行时通过 BACKEND_ORIGIN 覆盖（compose 内指向 backend 服务）
  // HTML 响应安全头(/api 由 Go 后端负责)
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
  async rewrites() {
    const backend =
      process.env.BACKEND_ORIGIN ?? "http://127.0.0.1:8080";
    return [
      {
        source: "/api/:path*",
        destination: `${backend}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
