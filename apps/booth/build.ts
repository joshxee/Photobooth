import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

await rm("dist", { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["./index.html"],
  outdir: "dist",
  minify: true,
  sourcemap: "linked",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// Bun inlines small assets into the CSS as data: URIs, but the app's CSP
// (`default-src 'self'`) forbids data: fonts. Move any inlined font back out into a real file.
const fontsDir = join("dist", "fonts");
const inlined = /url\(["']?data:font\/(?:ttf|woff2?|otf);base64,([A-Za-z0-9+/=]+)["']?\)/g;
for (const name of (await readdir("dist")).filter((f) => f.endsWith(".css"))) {
  const path = join("dist", name);
  const css = await readFile(path, "utf8");
  const files: [string, Buffer][] = [];
  const rewritten = css.replace(inlined, (_match, base64: string) => {
    const bytes = Buffer.from(base64, "base64");
    const hash = createHash("sha1").update(bytes).digest("hex").slice(0, 10);
    const file = `font-${hash}.ttf`;
    files.push([file, bytes]);
    return `url(./fonts/${file})`;
  });
  if (files.length > 0) {
    await mkdir(fontsDir, { recursive: true });
    for (const [file, bytes] of files) await writeFile(join(fontsDir, file), bytes);
    await writeFile(path, rewritten);
  }
  if (/url\(["']?data:/.test(rewritten)) {
    console.error(`${name} still contains a data: URI, which the CSP forbids`);
    process.exit(1);
  }
}

for (const output of result.outputs) {
  console.log(`${output.path}  ${(output.size / 1024).toFixed(1)} KiB`);
}
