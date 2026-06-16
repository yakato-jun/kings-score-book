import { NextResponse } from "next/server";
import { applyProposal } from "@/lib/ai/agent";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { tool, input } = (await req.json()) as { tool: string; input: Record<string, unknown> };
    const id = await applyProposal(tool, input);
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
