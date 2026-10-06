import type { NextConfig } from 'next';
const config: NextConfig = { poweredByHeader: false, output: 'standalone', serverExternalPackages: ['@node-rs/argon2', 'postgres', 'pino'] };
export default config;
