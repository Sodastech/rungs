import { type NextRequest, NextResponse } from "next/server";

const PAUSED_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Rungs demo</title>
<h1>The demo is paused</h1><p>Please try again later, or
<a href="https://github.com/Sodastech/rungs/tree/main/examples/nextjs-expense">run it locally</a>.</p></html>`;

/**
 * The online demo only: DEMO_PAUSED=1 switches it off without a deploy, and every page gets a
 * Content Security Policy with a fresh nonce, which Next.js adds to its own scripts.
 * `style-src` allows inline styles because `next/image` and the avatars set a `style` attribute.
 */
export function proxy(request: NextRequest): NextResponse {
  if (process.env.DEMO_PUBLIC !== "1") return NextResponse.next();
  if (process.env.DEMO_PAUSED === "1") {
    return new NextResponse(PAUSED_PAGE, {
      status: 503,
      headers: { "content-type": "text/html; charset=utf-8", "retry-after": "3600" },
    });
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const https = request.headers.get("x-forwarded-proto") === "https";
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|icon.svg|rungs-icon.svg).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
