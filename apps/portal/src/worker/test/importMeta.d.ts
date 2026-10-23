// Vite's `import.meta.glob`, which Vitest compiles away. Declared here for the tests that list the
// contract fixtures, read source files (`?raw`) or binary fixtures (`?inline`, a data URL), rather
// than depending on the `vite/client` types.
interface ImportMeta {
  glob<T>(pattern: string | string[], options: { eager: true; import: "default"; query?: "?raw" | "?inline" }): Record<string, T>;
}
