/**
 * [§9.3 二軸 side モデル] side（自軍kings / 相手opponent）は
 *   half(表/裏) × スロット役割(攻撃側/守備側)
 * の二軸で決める。攻撃側スロット(打者・走者)=そのhalfの攻撃チーム、
 * 守備側スロット(投手・捕手・責任投手・守備位置)=その逆チーム。
 * 打者IDの接頭辞(P/G/O)は一切見ない＝接頭辞ハック(sideHalf の /^O\d/ 等)の置換。
 *
 * ★なぜ二軸か: 相手攻撃half(=自軍守備)の打席行に自軍の投手/捕手/責任投手が乗る(実データ390件)。
 *   「half=相手側」と単軸判定すると自軍の正本参照を相手側に誤分類し、参加者必須/置換/帰属から漏れる。
 *
 * ※ home_away→攻撃half の対応は gamestate.kingsBatHalf と同一だが、agg↔gamestate の循環依存を避けるため
 *   ここは型のみ依存で自足させる。将来 gamestate 側をこの実装へ寄せて一元化する(§9.9 のクリーンアップ)。
 */
import type { GameDoc, PlateAppearance, Half } from "@/lib/types/v2";

export type Team = "kings" | "opponent";

/** 自軍が攻撃する half（away=先攻=top / home=後攻=bottom）。home_away不明は top 扱い。 */
export function kingsBattingHalf(doc: GameDoc): Half {
  return doc.game.home_away === "home" ? "bottom" : "top";
}

/** その half で攻撃しているチーム（=その half の打者/走者の所属）。 */
export function battingTeam(doc: GameDoc, half: Half): Team {
  return half === kingsBattingHalf(doc) ? "kings" : "opponent";
}

/** その half で守備しているチーム（=投手/捕手/責任投手/守備位置の所属）。攻撃チームの逆。 */
export function fieldingTeam(doc: GameDoc, half: Half): Team {
  return battingTeam(doc, half) === "kings" ? "opponent" : "kings";
}

/**
 * [§9.5 共有列挙関数] 打席内の「自軍(kings)側」ID参照を二軸で列挙する。
 *  - 自軍攻撃half: 打者・全走者(runs/baserunning/守備アウトで除去された走者/代走) が自軍。
 *  - 自軍守備half: 責任投手(responsible_pitcher_id) が自軍。攻撃側(相手打者/走者)は対象外。
 * ※ pitcher_id/catcher_id は廃止方針(スナップ解決一本 §9.2)のため列挙しない。
 * 収集・置換・V-A・R2/R3・突合はすべてこの関数を通す（唯一の側オラクル）。
 */
export function ownSidePaIds(doc: GameDoc, pa: PlateAppearance): string[] {
  const ids: string[] = [];
  const push = (v?: string | null) => {
    if (v) ids.push(v);
  };
  if (battingTeam(doc, pa.half) === "kings") {
    // 攻撃側スロット = 自軍
    push(pa.batter_id);
    for (const r of pa.runs ?? []) push(r.runner_id);
    for (const ev of pa.baserunning_during ?? []) {
      for (const m of ev.runners ?? []) push(m.runner_id);
      for (const o of ev.fielding?.outs ?? []) push(o.runner_id);
    }
    for (const m of pa.baserunning_after ?? []) push(m.runner_id);
    for (const o of pa.fielding?.outs ?? []) push(o.runner_id);
    push(pa.pinch_runner?.runner_id);
  } else {
    // 守備側スロット = 自軍（相手攻撃halfに乗る自軍守備参照）。責任投手のみPA保存ID(投捕はスナップ解決)。
    // [§10.6] 責任投手は runs[](auto・移行後は空) と doc.run_overrides(manual=人の明示) の双方から集める
    //   (手動上書きの未登録IDも V-A/R2 で検出・削除ガードで参照される)。
    for (const r of pa.runs ?? []) push(r.responsible_pitcher_id);
    if (pa.id) for (const ov of doc.run_overrides ?? []) if (ov.pa_id === pa.id) push(ov.responsible_pitcher_id);
  }
  return [...new Set(ids)];
}
