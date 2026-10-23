import { createHash } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
  await unInlineFonts(join("dist", spa, "assets"));
  for (const output of result.outputs) {
    console.log(`${spa}: ${output.path.replace(process.cwd(), ".")}  ${(output.size / 1024).toFixed(1)} KiB`);
  }
}

// Bun inlines fonts into the CSS as data: URIs, which the CSP (`default-src 'self'`) blocks (the
// booth's build.ts does the same). Move each back out to a hashed file beside the stylesheet.
async function unInlineFonts(dir: string): Promise<void> {
  const inlined = /url\(["']?data:font\/(?:ttf|woff2?|otf);base64,([A-Za-z0-9+/=]+)["']?\)/g;
  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith(".css"));
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    const css = await readFile(path, "utf8");
    const files: [string, Buffer][] = [];
    const rewritten = css.replace(inlined, (_match, base64: string) => {
      const bytes = Buffer.from(base64, "base64");
      const file = `font-${createHash("sha1").update(bytes).digest("hex").slice(0, 10)}.ttf`;
      files.push([file, bytes]);
      return `url(./${file})`;
    });
    for (const [file, bytes] of files) await writeFile(join(dir, file), bytes);
    await writeFile(path, rewritten);
    if (/url\(["']?data:/.test(rewritten)) {
      console.error(`${path} still contains a data: URI, which the CSP blocks`);
      process.exit(1);
    }
  }
}
