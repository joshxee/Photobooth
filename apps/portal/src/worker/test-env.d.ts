// Types `exports.default` in tests (`cloudflare:workers`) as this Worker's default export.
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index");
  }
}
