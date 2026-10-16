const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

/**
 * The sync API intentionally fails closed until authentication, workspace/device
 * authorization, and transactional persistence are implemented and accepted.
 * In particular, this handler must not treat the presence of a Bearer header as
 * proof of identity or consume a client outbox while sync is unavailable.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname !== "/sync") {
      return Response.json({ error: "not_found" }, { status: 404, headers: jsonHeaders });
    }
    if (request.method !== "POST") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { ...jsonHeaders, Allow: "POST" } },
      );
    }
    return Response.json(
      { error: "sync_unavailable" },
      { status: 503, headers: { ...jsonHeaders, "Retry-After": "3600" } },
    );
  },
};
