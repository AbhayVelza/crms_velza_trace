// Optimistic check only: no session cookie → go to the sign-in page. The real check (valid session,
// approved account, role allowed) happens in every API call, so a forged cookie gets nothing.

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/sessionCookie";

export function proxy(req: NextRequest) {
  if (req.cookies.has(SESSION_COOKIE)) return NextResponse.next();
  const url = new URL("/login", req.url);
  const back = req.nextUrl.pathname + req.nextUrl.search;
  if (back !== "/") url.searchParams.set("next", back);
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except the API, Next assets, the sign-in page and the public QR page /t/<code>.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|login|t/).*)"],
};
