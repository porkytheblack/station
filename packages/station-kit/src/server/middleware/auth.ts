import { createMiddleware } from "hono/factory";
import type { KeyStore } from "../auth/keys.js";
import { verifySessionToken, type SessionConfig } from "../auth/session.js";

export interface AuthDeps {
  keyStore?: KeyStore;
  sessionConfig?: SessionConfig;
}

/** Sets c.get("authType"), c.get("apiKeyId"), c.get("scopes") */
export function authResolver(deps: AuthDeps) {
  return createMiddleware(async (c, next) => {
    // Check for API key in Authorization header
    const authHeader = c.req.header("authorization");
    if (authHeader?.startsWith("Bearer ") && deps.keyStore) {
      const token = authHeader.slice(7);
      if (token.startsWith("sk_")) {
        const key = deps.keyStore.verify(token);
        if (key) {
          c.set("authType", "api-key");
          c.set("apiKeyId", key.id);
          c.set("scopes", key.scopes);
          return next();
        }
        return c.json({ error: "unauthorized", message: "Invalid or revoked API key." }, 401);
      }
    }

    // Check for session cookie
    const cookie = c.req.header("cookie");
    if (cookie && deps.sessionConfig) {
      const match = cookie.match(/station_session=([^;]+)/);
      if (match) {
        const valid = verifySessionToken(match[1], deps.sessionConfig);
        if (valid) {
          c.set("authType", "session");
          c.set("apiKeyId", undefined);
          c.set("scopes", ["trigger", "read", "cancel", "admin"]);
          return next();
        }
      }
    }

    // No auth
    c.set("authType", "none");
    c.set("apiKeyId", undefined);
    c.set("scopes", []);
    return next();
  });
}
