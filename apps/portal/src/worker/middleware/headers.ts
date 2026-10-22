import { createMiddleware } from "hono/factory";

// DESIGN §13, "Browser injection". Applied to every response, including errors and static assets.
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' blob: data:; frame-ancestors 'none'",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export const securityHeaders = () =>
  createMiddleware(async (c, next) => {
    await next();
    // Responses from the assets binding or a redirect have immutable headers, so rebuild first.
    c.res = new Response(c.res.body, c.res);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(name, value);
  });
