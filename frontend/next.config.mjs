/** @type {import('next').NextConfig} */
const nextConfig = {
  // Docker 生产部署：standalone 产物自带最小 server，镜像更小
  output: "standalone",
  // 压缩保持默认（源站 gzip）：2026-11-24 实测经 Cloudflare 时，源站 gzip 比边缘自己的 gzip/brotli
  // 都小 1%~3%；设 compress:false 让边缘来编码反而更大
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
