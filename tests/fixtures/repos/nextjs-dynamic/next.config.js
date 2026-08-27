/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  images: {
    domains: ['dreamer.samanp.xyz'],
  },
};

module.exports = nextConfig;
