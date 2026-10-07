import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const config = {
  poweredByHeader: false,
  output: 'standalone',
  serverExternalPackages: ['@node-rs/argon2', 'postgres', 'pino'],
  webpack(cfg) {
    cfg.resolve.alias['@'] = path.join(root, 'src');
    return cfg;
  },
};
export default config;
