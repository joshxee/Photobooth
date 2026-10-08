import index from "./index.html";

// Bun serves index.html with HMR. `console: true` streams the WebView's console.log to this
// terminal, which is the easiest way to debug on the tablet. TAURI_DEV_HOST is set by
// `tauri android dev --host` so the device can reach this machine.
const server = Bun.serve({
  routes: { "/*": index },
  hostname: process.env.TAURI_DEV_HOST ?? "localhost",
  port: 1420,
  development: { hmr: true, console: true },
});

console.log(`booth dev server on ${server.url}`);
