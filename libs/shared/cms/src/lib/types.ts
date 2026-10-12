export type DeepNonNullable<T> = {
  // T extends never is a check for 'any' which is the type returned for Strapi multi-select plugin arrays
  [K in keyof T]: T[K] extends never
    ? any
    : Exclude<DeepNonNullable<T[K]>, null | undefined>;
};
