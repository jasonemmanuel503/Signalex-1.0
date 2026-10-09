/** @type {import('next').NextConfig} */
module.exports = (phase) => {
  if (phase) {
    process.env.NEXT_PHASE = phase;
  }
  return {
    output: 'standalone',
    distDir: process.env.NEXT_DIST_DIR || (process.env.NODE_ENV === 'development' ? '.next-dev' : '.next'),
    experimental: {
      instrumentationHook: true,
    },
  };
};

