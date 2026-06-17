/** 入力ノートの自動保存(途中ロスト防止・共有)。AIは呼ばない。 */
import { NextResponse } from "next/server";
import { saveNote } from "@/lib/db/notes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { gameId, text } = (await req.json()) as { gameId?: string; text?: string };
    if (!gameId) return NextResponse.json({ error: "gameId が必要です" }, { status: 400 });
    await saveNote(gameId, text ?? "", new Date().toISOString());
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
