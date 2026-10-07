import type { NextConfig } from 'next';
import { assertProductionConfig } from './lib/production-config';

assertProductionConfig(process.env);

const backend = process.env.BACKEND_URL || 'http://127.0.0.1:8020';
const config: NextConfig = {
  output: 'standalone',
  distDir: process.env.NEXT_DIST_DIR || '.next',
  turbopack: { root: import.meta.dirname },
  poweredByHeader: false,
  // Recognition can outlast Next's default 30s proxy timeout. The client still
  // bounds its wait and recovers the persisted receipt without resubmitting.
  experimental: { proxyTimeout: 180_000 },
  async rewrites() {
    return [
      { source: '/api/v1/:path*', destination: `${backend}/api/v1/:path*` },
      { source: '/uploads/:path*', destination: `${backend}/uploads/:path*` },
    ];
  },
};
export default config;
