import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/session";
import { corpusStats } from "@/lib/tpuf";

export const dynamic = "force-dynamic";

/** Corpus sizes for the search page's corpus line and the sidebar footer, loaded after the page has rendered. */
export async function GET() {
  const user = await requireUserId();
  if (user instanceof Response) return user;
  try {
    return NextResponse.json(await corpusStats(), { headers: { "Cache-Control": "private, max-age=600" } });
  } catch (e) {
    return NextResponse.json({ error: `turbopuffer request failed: ${(e as Error).message}` }, { status: 502 });
  }
}
