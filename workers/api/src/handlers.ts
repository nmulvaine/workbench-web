import { validateEnvelope } from "../../../packages/sync-contracts/src/envelope.js";

type WorkerRequestHandler = (req: Request, env?: unknown, ctx?: unknown) => Response | Promise<Response>;

export function authMiddleware(req: Request): boolean {
  const header = req.headers.get("Authorization");
  return !!header && header.startsWith("Bearer ");
}

export async function handleSyncPost(req: Request): Promise<Response> {
  if (!authMiddleware(req)) return new Response("Unauthorized", { status: 401 });
  try {
    const body = await req.json();
    validateEnvelope(body);
    return new Response(
      JSON.stringify({
        status: "ok",
        received: true,
        records: body.records.length,
        assets: body.assets.length,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    return new Response(String(error instanceof Error ? error.message : error), {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

export const onRequestPost: WorkerRequestHandler = async (req) => handleSyncPost(req);
