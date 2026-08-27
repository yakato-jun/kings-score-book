import Link from "next/link";
import { draftBlockMsg } from "@/lib/draft-msg";

/**
 * 軸1(予防)の下書きブロック案内＝定型文＋「ノート入力へ」遷移ボタン。
 * 「破棄/確定してください」と言うだけでなく、実際に行ける導線を必ず添える。
 * server/client どちらのツリーからも使える（Link のみ）。
 */
export function DraftBlockNotice({ gameId, op }: { gameId: string; op: string }) {
  return (
    <p className="flagbar">
      {draftBlockMsg(op)}
      <Link className="db-act" href={`/admin/games/${gameId}/note`}>ノート入力へ</Link>
    </p>
  );
}
