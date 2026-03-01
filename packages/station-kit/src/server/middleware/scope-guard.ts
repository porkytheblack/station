import { createMiddleware } from "hono/factory";

/** Require at least one of the specified scopes. */
export function requireScope(...requiredScopes: string[]) {
  return createMiddleware(async (c, next) => {
    const authType = c.get("authType") as string | undefined;
    if (!authType || authType === "none") {
      return c.json({ error: "unauthorized", message: "Authentication required." }, 401);
    }
    const scopes = (c.get("scopes") as string[]) ?? [];
    const hasScope = requiredScopes.some((s) => scopes.includes(s));
    if (!hasScope) {
      return c.json(
        { error: "forbidden", message: `Required scope: ${requiredScopes.join(" or ")}.` },
        403,
      );
    }
    return next();
  });
}
