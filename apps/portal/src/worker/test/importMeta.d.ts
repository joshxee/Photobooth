// Vite's `import.meta.glob`, which Vitest compiles away. Declared here for the one test that
// lists the contract fixtures, rather than depending on the `vite/client` types.
interface ImportMeta {
  glob<T>(pattern: string, options: { eager: true; import: "default" }): Record<string, T>;
}
