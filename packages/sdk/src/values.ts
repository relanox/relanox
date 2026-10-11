/** All durable times are integer Unix epoch milliseconds. JSON excludes undefined. */
export type Json =
  null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

export type EpochMs = number;
export const SDK_MAJOR = 1 as const;
