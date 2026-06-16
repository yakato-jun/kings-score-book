import { NextResponse } from "next/server";
import { publishGame } from "@/lib/ops/games";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { gameId } = (await req.json()) as { gameId: string };
    await publishGame(gameId, { source: "ai" });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
