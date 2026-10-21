/**
 * Sentry, loaded before anything else (first import of index.ts). Off without SENTRY_DSN (local
 * dev, tests). Reports uncaught errors, 5xx responses and every console.error (failed refunds,
 * settlements, draft credits…), without cookies, headers, bodies, query strings, user info or
 * local variables: requests carry access tokens and refresh cookies.
 */
import dotenv from "dotenv";
import * as Sentry from "@sentry/node";

dotenv.config();

const dsn = process.env.SENTRY_DSN;

/** Express layer types Sentry would otherwise open a span for (see expressIntegration below). */
export const EXPRESS_LAYER_TYPES: ("middleware" | "router" | "request_handler")[] = ["middleware", "router", "request_handler"];

const SENSITIVE_KEY = /^(body|password|passwordHash|token|accessToken|refreshToken|authorization|cookie|cookies|headers)$/i;

/** console.error arguments are sent whole: drop request bodies, tokens and headers nested in them. */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 8 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = SENSITIVE_KEY.test(key) ? "[Filtered]" : scrub(item, depth + 1);
  return out;
}

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.NODE_ENV ?? "development",
  tracesSampleRate: 0,
  beforeSend: (event) => ({ ...event, extra: event.extra && (scrub(event.extra) as typeof event.extra) }),
  // Console lines (any level) would ride along as breadcrumbs, unscrubbed
  beforeBreadcrumb: (breadcrumb) => (breadcrumb.category === "console" ? null : breadcrumb),
  integrations: [
    Sentry.captureConsoleIntegration({ levels: ["error"] }),
    // No per-layer spans: tracing is off (tracesSampleRate 0), and each span adds a
    // res.once("finish") listener. A request crosses every router mounted on /api (~25, see
    // index.ts) and those layers are open at the same time (each router calls next()
    // synchronously), so the response got ~30 listeners → MaxListenersExceededWarning in pm2.
    // Error capture and transaction names don't depend on these spans.
    Sentry.expressIntegration({ ignoreLayersType: EXPRESS_LAYER_TYPES }),
  ],
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    stackFrameVariables: false,
    databaseQueryData: false,
  },
});
