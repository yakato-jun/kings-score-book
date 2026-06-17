/** AI修正(差分): 1打席を自然言語の指示で直す。整合性は取らず下書きに反映→ユーザーがプレビューで確認・確定。同期。 */
import { NextResponse } from "next/server";
import { editPA } from "@/lib/ai/agent";
import type { Half } from "@/lib/types/v2";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = "claude-sonnet-4-6";

export async function POST(req: Request) {
  try {
    const { gameId, inning, half, order, instruction } = (await req.json()) as {
      gameId?: string; inning?: number; half?: Half; order?: number; instruction?: string;
    };
    if (!gameId || !inning || (half !== "top" && half !== "bottom") || !order) {
      return NextResponse.json({ error: "対象の打席が指定されていません" }, { status: 400 });
    }
    if (!instruction?.trim()) return NextResponse.json({ error: "修正内容を入力してください" }, { status: 400 });
    const r = await editPA(gameId, inning, half, order, instruction, MODEL);
    return r.ok ? NextResponse.json({ ok: true, message: r.message }) : NextResponse.json({ error: r.message });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
