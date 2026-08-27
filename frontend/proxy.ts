import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const MAINTENANCE_PATH = "/maintenance";

function isMaintenanceMode() {
  return process.env.NEXT_PUBLIC_IS_ONLINE?.toLowerCase() === "false";
}

function isAllowedWhenOffline(pathname: string) {
  return pathname === "/" || pathname.startsWith("/docs") || pathname === MAINTENANCE_PATH;
}

function isBypassedPath(pathname: string) {
  if (pathname.startsWith("/_next") || pathname.startsWith("/api")) {
    return true;
  }

  // Skip files under /public and file-based routes (favicon, icons, etc.)
  return /\.[^/]+$/.test(pathname);
}

export function proxy(request: NextRequest) {
  if (!isMaintenanceMode()) {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;

  if (isAllowedWhenOffline(pathname) || isBypassedPath(pathname)) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  url.pathname = MAINTENANCE_PATH;
  url.search = "";

  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};