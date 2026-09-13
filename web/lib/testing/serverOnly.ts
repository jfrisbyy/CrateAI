// Stands in for the `server-only` marker package under vitest, where there is
// no React server condition to resolve it to an empty module (its real entry
// point throws). Aliased in vitest.config.ts; never imported by app code.

export {};
