import { createHash, timingSafeEqual } from "node:crypto";
import { sharedDatabase } from "../../../rungs/demo";
import { cleanupSandboxes } from "../../../rungs/sandbox";
import { isPublicDemo } from "../../session";

export const dynamic = "force-dynamic";

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Vercel Cron calls this once a day and sends `Authorization: Bearer $CRON_SECRET`. */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = request.headers.get("authorization") ?? "";
  return timingSafeEqual(digest(given), digest(`Bearer ${secret}`));
}

export async function GET(request: Request): Promise<Response> {
  if (!isPublicDemo() || !authorized(request)) return new Response(null, { status: 404 });
  const result = await cleanupSandboxes(await sharedDatabase(), {
    olderThanHours: 24,
    limit: 500,
  });
  return Response.json(result);
}
