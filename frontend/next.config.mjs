/** @type {import('next').NextConfig} */
const nextConfig = {
  // Docker 生产部署：standalone 产物自带最小 server，镜像更小
  output: "standalone",
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // 后端地址可在容器运行时通过 BACKEND_ORIGIN 覆盖（compose 内指向 backend 服务）
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
