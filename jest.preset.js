const nxPreset = require('@nx/jest/preset').default;

module.exports = {
  ...nxPreset,
  maxWorkers: 1,
  // @faker-js/faker 10, @nestjs/schedule 12 and @nestjs/locks are ESM-only, so jest has to transform them rather than skip them
  transformIgnorePatterns: [
    '/node_modules/(?!(\\.pnpm/)?((@faker-js\\+faker|@nestjs\\+schedule|@nestjs\\+locks)@[^/]+/node_modules/)?(@faker-js/faker|@nestjs/schedule|@nestjs/locks)/)',
  ],
};
