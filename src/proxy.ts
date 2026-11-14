// Optimistic check only: no session cookie → go to the sign-in page. The real check (valid session,
// approved account, role allowed) happens in every API call, so a forged cookie gets nothing.
// While sign-in is off (development) there is no sign-in page: every page opens, and /login goes to the
// start page (the API acts as the default Velza Admin, see devDefaultUserId).

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/sessionCookie";
import { signInRequired } from "@/lib/signInMode";

export function proxy(req: NextRequest) {
  const isLogin = req.nextUrl.pathname === "/login";
  // The sign-up page is for shops that have no account yet: always open.
  const isSignup = req.nextUrl.pathname === "/signup";
  if (!signInRequired()) return isLogin ? NextResponse.redirect(new URL("/", req.url)) : NextResponse.next();
  if (isLogin || isSignup || req.cookies.has(SESSION_COOKIE)) return NextResponse.next();
  const url = new URL("/login", req.url);
  const back = req.nextUrl.pathname + req.nextUrl.search;
  if (back !== "/") url.searchParams.set("next", back);
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except the API, Next assets and the public QR page /t/<code>.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|t/).*)"],
};
