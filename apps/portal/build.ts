import { rm } from "node:fs/promises";

// Builds both SPAs from their HTML entry points into dist/<spa>/:
//   dist/<spa>/index.html            the shell (not hashed; served with no-cache)
//   dist/<spa>/assets/<name>-<hash>  bundles, served at /assets/ and cached as immutable
// `publicPath: "/"` makes the HTML refer to /assets/..., which the Worker maps to dist/<spa>/assets/.
const SPAS = ["gallery", "admin"] as const;

await rm("dist", { recursive: true, force: true });

for (const spa of SPAS) {
  const result = await Bun.build({
    entrypoints: [`./src/web/${spa}/index.html`],
    outdir: `dist/${spa}`,
    publicPath: "/",
    minify: true,
    sourcemap: "none",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    naming: {
      entry: "[name].[ext]",
      chunk: "assets/[name]-[hash].[ext]",
      asset: "assets/[name]-[hash].[ext]",
    },
  });

  if (!result.success) {
    for (const message of result.logs) console.error(message);
    process.exit(1);
  }
  for (const output of result.outputs) {
    console.log(`${spa}: ${output.path.replace(process.cwd(), ".")}  ${(output.size / 1024).toFixed(1)} KiB`);
  }
}
