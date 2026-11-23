// moduleResolution "node" ignores package.json "exports", so the ./testing subpath needs mapping by hand.
declare module '@nestjs/locks/testing' {
  export * from '@nestjs/locks/dist/testing/index.js';
}
