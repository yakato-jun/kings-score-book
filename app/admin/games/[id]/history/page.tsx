/** 版履歴の確認(order5の核)。game_history の各版＝どの機能で・何を入力して作られたか＋過去版プレビュー＋過去ノート参照。 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { listVersions, loadWorking } from "@/lib/db/games";
import { RollbackButton } from "./RollbackButton";
import { RevertButton } from "./RevertButton";
import { DraftBlockNotice } from "@/components/DraftBlockNotice";

export const dynamic = "force-dynamic";

// edit_source を人間語に(内部値は出さない)
const SOURCE_LABEL: Record<string, string> = {
  ai_aggregate: "AI集計", ai_edit: "AI修正", manual: "手修正", publish: "公開", rollback: "ロールバック", revert: "取り消し",
};
const HALF: Record<string, string> = { top: "表", bottom: "裏" };

export default async function HistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [versions, work] = await Promise.all([listVersions(id), loadWorking(id)]);
  if (!work) notFound();
  const hasDraft = work.draft; // 下書き中はロールバック不可(手修正と同じ＝先に確定/破棄)
  const tipGen = work.gen; // 先端版にはロールバック不要

  return (
    <div>
      <p className="muted">各版は「どの機能で・何を入力して」作られたかを記録します。プレビューで過去版の内容を確認できます。「この版へ戻す」は過去版を最新として丸ごと積み直します（その版以降の変更も巻き戻り、公開版になります）。「この版を取り消す」はその版が加えた変更だけを取り消します（それ以降の他の変更は保持。AIが未確定の集計結果を作るのでプレビュー確認後に公開）。</p>
      {hasDraft && <DraftBlockNotice gameId={id} op="ロールバック・取り消し" />}

      {versions.length === 0 ? (
        <p>版がありません。</p>
      ) : (
        <div className="scrollx"><table className="histtable">
          <thead>
            <tr><th>版</th><th>状態</th><th>日時</th><th>機能</th><th>入力（正本）</th><th>プレビュー</th><th>操作</th></tr>
          </thead>
          <tbody>
            {versions.map((v) => {
              const inp = v.input;
              const inputText = !inp
                ? "—"
                : inp.kind === "instruction"
                  ? `AI修正指示${inp.target ? `（${inp.target.inning}回${HALF[inp.target.half] ?? ""} ${inp.target.order}番）` : ""}: ${inp.text}`
                  : inp.kind === "note"
                    ? `ノート: ${inp.text}`
                    : inp.text; // manual(手修正/ロールバック)は機能列が種別を示すので前置きしない
              return (
                <tr key={v.gen}>
                  <td>gen {v.gen}</td>
                  <td>{v.draft ? "未確定" : <b>公開</b>}</td>
                  <td className="muted">{v.updated_at.slice(0, 16).replace("T", " ")}</td>
                  <td>{SOURCE_LABEL[v.edit_source] ?? v.edit_source}</td>
                  <td className="histinput" style={{ whiteSpace: "pre-wrap" }}>{inputText}</td>
                  <td>
                    <Link href={`/games/${id}?gen=${v.gen}`}>ボックス</Link>{" / "}
                    <Link href={`/games/${id}/text?gen=${v.gen}`}>テキスト</Link>
                  </td>
                  <td className="histactions">
                    {v.gen !== tipGen && <RollbackButton gameId={id} gen={v.gen} disabled={hasDraft} />}
                    {!v.draft && <RevertButton gameId={id} gen={v.gen} disabled={hasDraft} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}
    </div>
  );
}
