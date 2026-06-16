import { NextResponse } from "next/server";
import { runAgent, type Scene } from "@/lib/ai/agent";
import type Anthropic from "@anthropic-ai/sdk";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  try {
    const { messages, scene } = (await req.json()) as { messages: Anthropic.MessageParam[]; scene?: Scene };
    const r = await runAgent(messages ?? [], scene);
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
