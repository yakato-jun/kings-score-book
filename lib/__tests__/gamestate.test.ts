import { describe, it, expect } from "vitest";
import { foldRunners, deriveNextPA, gameState, kingsBatHalf, lineupSlots, resolvePATarget, derivePAStates, deriveScorers, resolveBaserunningIds, deriveRuns } from "../ops/gamestate";
import { doc, pa, snap, LINEUP } from "./fixtures";
import type { Runners, BaserunMove } from "../types/v2";

const EMPTY: Runners = { first: null, second: null, third: null };

describe("resolveBaserunningIds: runner_id 省略時は from塁の走者で確定(AIはfrom/toだけ渡せばよい)", () => {
  it("after の runner_id 省略 → from塁の在塁者で埋める(非強制の結果)", () => {
    // OUT(ゴロ)で走者が進む。強制進塁(applyForce)が走らないので from塁=元の走者。
    const start = { first: "P1", second: null, third: "P3" };
    const p = pa({ batter_id: "P2", result: "OUT", baserunning_after: [{ from: "1", to: "2" }, { from: "3", to: "home" }] as BaserunMove[] });
    const r = resolveBaserunningIds(start, p);
    expect(r.baserunning_after.map((m) => m.runner_id)).toEqual(["P1", "P3"]);
  });
  it("during(盗塁)の runner_id 省略 → from塁の在塁者で埋める", () => {
    const start = { first: "P1", second: null, third: null };
    const p = pa({ batter_id: "P2", result: "OUT", baserunning_during: [{ event: "SB", runners: [{ from: "1", to: "2" }] as BaserunMove[] }] });
    const r = resolveBaserunningIds(start, p);
    expect(r.baserunning_during?.[0].runners?.[0].runner_id).toBe("P1");
  });
});

describe("走塁記録の契約: null走者の防波堤と from の unknown/batter 正規化", () => {
  it("冗長な null 走者の after が打者を消さない(H2の打者はサーバ自動配置のまま)", () => {
    // AIが打者自身の出塁を runner_id無し・from:null で冗長に書くケース。
    // 修正前は applyMoves が bases["2"]=null を代入し、自動配置済みの打者を盤面から消していた。
    const p = pa({ batter_id: "P2", result: "H2", baserunning_after: [{ runner_id: null, from: null, to: "2" }] as unknown as BaserunMove[] });
    expect(foldRunners(EMPTY, p)).toEqual({ first: null, second: "P2", third: null });
  });
  it("E出塁の打者が次打席の盗塁(during)で同定される(盤面の連鎖が切れない)", () => {
    // E出塁=サーバが結果コードから自動配置。AIの冗長 null after 付き=修正前は打者が消え、次打席のSBが同定不能になる回帰ケース
    const board = foldRunners(EMPTY, pa({ batter_id: "A", result: "E", baserunning_after: [{ runner_id: null, from: null, to: "1" }] as unknown as BaserunMove[] }));
    expect(board).toEqual({ first: "A", second: null, third: null });
    const p = pa({ batter_id: "B", result: "OUT", baserunning_during: [{ event: "SB", runners: [{ from: "1", to: "2" }] as BaserunMove[] }] });
    const r = resolveBaserunningIds(board, p);
    expect(r.baserunning_during?.[0].runners?.[0].runner_id).toBe("A");
  });
  it("from:unknown は不明宣言=null に正規化して保存(解決不能なら捏造せず、実在走者も消さない)", () => {
    const start = { first: null, second: null, third: "X" };
    const p = pa({ batter_id: "B", result: "OUT", baserunning_after: [{ from: "unknown", to: "3" }] as BaserunMove[] });
    const fixed = resolveBaserunningIds(start, p);
    expect(fixed.baserunning_after[0].from).toBeNull(); // "unknown"→null 正規化
    expect(fixed.baserunning_after[0].runner_id ?? null).toBeNull(); // 解決不能=null/undefinedのまま(捏造しない)
    expect(foldRunners(start, fixed)).toEqual(start); // null走者の移動は盤面に適用しない=実在走者Xが残る
  });
  it("from:batter は打者IDに解決される(batterRef=結果を超える余分な進塁)", () => {
    // 二塁打の打者が送球間に三塁まで進むケースを from:"batter" で表す
    const p = pa({ batter_id: "P2", result: "H2", baserunning_after: [{ from: "batter", to: "3" }] as BaserunMove[] });
    const fixed = resolveBaserunningIds(EMPTY, p);
    expect(fixed.baserunning_after[0].runner_id).toBe("P2");
    expect(fixed.baserunning_after[0].from).toBeNull(); // batter参照は塁でない=from:null に正規化
    expect(foldRunners(EMPTY, fixed)).toEqual({ first: null, second: null, third: "P2" });
  });
});

describe("★物理順(2026-08): 先行走者のafter → 打者の自動配置 → 打者自身のafter", () => {
  // 打者を先に置くと、打者の到達塁(H2の二塁等)に居る先行走者を上書きで消していた回帰群。
  // 野球の物理は「先行走者が先に進み、打者走者は後から塁に収まる」＝適用順序をこれに合わせる。
  it("回帰(試合556b5597be型): 牽制挟殺で二塁へ→打者ツーベース→二塁走者生還(R1誤発火・走者消失の解消)", () => {
    const start = { first: "A", second: null, third: null };
    const p = pa({
      batter_id: "B", result: "H2",
      baserunning_during: [{ event: "PO", runners: [{ from: "1", to: "2" }] as BaserunMove[] }],
      baserunning_after: [{ from: "2", to: "home" }] as BaserunMove[],
    });
    const fixed = resolveBaserunningIds(start, p);
    expect(fixed.baserunning_after[0].runner_id).toBe("A"); // 打者Bを誤って掴まない(参照フレームずれの解消)
    expect(foldRunners(start, fixed)).toEqual({ first: null, second: "B", third: null }); // 終了盤面はBのみ
    expect(deriveScorers(start, fixed)).toEqual(["A"]); // 生還者0人化しない
    expect(deriveRuns(start, fixed).map((x) => x.runner_id)).toEqual(["A"]); // 得点1件=A
  });
  it("二塁走者+二塁打: 打者の到達塁に居た走者が消えず生還する", () => {
    const start = { first: null, second: "A", third: null };
    const p = pa({ batter_id: "B", result: "H2", baserunning_after: [{ runner_id: "A", from: "2", to: "home" }] as BaserunMove[] });
    expect(deriveScorers(start, p)).toEqual(["A"]);
    expect(foldRunners(start, p)).toEqual({ first: null, second: "B", third: null });
  });
  it("三塁走者+三塁打: 同型(打者の到達塁=三塁が塞がっていても生還が消えない)", () => {
    const start = { first: null, second: null, third: "A" };
    const p = pa({ batter_id: "B", result: "H3", baserunning_after: [{ runner_id: "A", from: "3", to: "home" }] as BaserunMove[] });
    expect(deriveScorers(start, p)).toEqual(["A"]);
    expect(foldRunners(start, p)).toEqual({ first: null, second: null, third: "B" });
  });
  it("実戦例#5型: 一三塁+E(フォース)で三塁走者生還・一塁走者三塁へ(from:1 を打者に誤解決しない)", () => {
    const start = { first: "A", second: null, third: "C" };
    const p = pa({ batter_id: "B", result: "E", baserunning_after: [{ from: "3", to: "home" }, { from: "1", to: "3" }] as BaserunMove[] });
    const fixed = resolveBaserunningIds(start, p);
    expect(fixed.baserunning_after.map((m) => m.runner_id)).toEqual(["C", "A"]); // 修正前は from:"1" が打者Bに誤解決
    expect(foldRunners(start, fixed)).toEqual({ first: "B", second: null, third: "A" });
    expect(deriveScorers(start, fixed)).toEqual(["C"]);
  });
  it("打者自身の追加進塁(from:batter)は配置後に適用される(H2→三塁まで)", () => {
    const p = pa({ batter_id: "B", result: "H2", baserunning_after: [{ from: "batter", to: "3" }] as BaserunMove[] });
    const fixed = resolveBaserunningIds(EMPTY, p);
    expect(foldRunners(EMPTY, fixed)).toEqual({ first: null, second: null, third: "B" });
  });
  it("走者一掃: 一二塁+二塁打で2人生還・打者が二塁に収まる", () => {
    const start = { first: "A", second: "C", third: null };
    const p = pa({
      batter_id: "B", result: "H2",
      baserunning_after: [{ runner_id: "C", from: "2", to: "home" }, { runner_id: "A", from: "1", to: "home" }] as BaserunMove[],
    });
    expect(deriveScorers(start, p)).toEqual(["C", "A"]);
    expect(deriveRuns(start, p).map((x) => x.runner_id)).toEqual(["C", "A"]);
    expect(foldRunners(start, p)).toEqual({ first: null, second: "B", third: null });
  });
});

describe("kingsBatHalf / lineupSlots", () => {
  it("away=先攻=top, home=後攻=bottom, 不明=top", () => {
    expect(kingsBatHalf(doc({ home_away: "away" }))).toBe("top");
    expect(kingsBatHalf(doc({ home_away: "home" }))).toBe("bottom");
    expect(kingsBatHalf(doc({ home_away: null }))).toBe("top");
  });
  it("打順スロットは order!=null を昇順で(投手DHは除外)", () => {
    const slots = lineupSlots(doc({ home_away: "away" }));
    expect(slots.map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(slots.map((s) => s.player_id)).toEqual(["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"]);
  });
});

describe("foldRunners は結果から走者を導出(四球で打者が出る・押し出し)", () => {
  const bb = (id: string) => pa({ batter_id: id, result: "BB" });
  it("四球で打者が一塁に出る(afterが空でも)", () => {
    expect(foldRunners(EMPTY, bb("B1"))).toEqual({ first: "B1", second: null, third: null });
  });
  it("連続四球で前の走者が押し出される", () => {
    let r = foldRunners(EMPTY, bb("B1"));
    r = foldRunners(r, bb("B2"));
    expect(r).toEqual({ first: "B2", second: "B1", third: null });
    r = foldRunners(r, bb("B3"));
    expect(r).toEqual({ first: "B3", second: "B2", third: "B1" }); // 満塁
  });
  it("満塁四球は三塁走者が押し出されて生還(塁から消える)", () => {
    const loaded = { first: "B3", second: "B2", third: "B1" };
    expect(foldRunners(loaded, pa({ batter_id: "B4", result: "BB" }))).toEqual({ first: "B4", second: "B3", third: "B2" });
  });
  it("死球も同様に強制進塁", () => {
    expect(foldRunners({ first: "X", second: null, third: null }, pa({ batter_id: "Y", result: "HBP" }))).toEqual({ first: "Y", second: "X", third: null });
  });
  it("本塁打は全員生還(塁が空く)", () => {
    expect(foldRunners({ first: "X", second: "Z", third: null }, pa({ batter_id: "B", result: "HR" }))).toEqual(EMPTY);
  });
  it("凡退/三振は走者そのまま", () => {
    const r = { first: "X", second: null, third: null };
    expect(foldRunners(r, pa({ batter_id: "B", result: "OUT" }))).toEqual(r);
  });
});

describe("deriveScorers: 誰が還ったかをエンジンが導出(得点者の取り違え排除)", () => {
  const loaded = { first: "A", second: "B", third: "C" };
  it("満塁四球は三塁走者(C)が押し出されて生還", () => {
    expect(deriveScorers(loaded, pa({ batter_id: "D", result: "BB" }))).toEqual(["C"]);
  });
  it("満塁死球も三塁走者が生還", () => {
    expect(deriveScorers(loaded, pa({ batter_id: "D", result: "HBP" }))).toEqual(["C"]);
  });
  it("満塁でない四球は得点者なし(押し出されない)", () => {
    expect(deriveScorers({ first: "A", second: "B", third: null }, pa({ batter_id: "D", result: "BB" }))).toEqual([]);
  });
  it("本塁打は塁上＋打者が全員生還", () => {
    expect(deriveScorers({ first: "A", second: null, third: "C" }, pa({ batter_id: "D", result: "HR" }))).toEqual(["C", "A", "D"]);
  });
  it("パスボール(during)で本塁到達した走者", () => {
    const p = pa({ batter_id: "D", result: "BB", baserunning_during: [{ event: "PB", runners: [{ runner_id: "C", from: "3", to: "home" }] }] });
    expect(deriveScorers({ first: null, second: "B", third: "C" }, p)).toEqual(["C"]);
  });
  it("安打での明示生還(after)も拾う", () => {
    const p = pa({ batter_id: "D", result: "H1", baserunning_after: [{ runner_id: "C", from: "3", to: "home" }] });
    expect(deriveScorers({ first: null, second: null, third: "C" }, p)).toEqual(["C"]);
  });
});

describe("deriveRuns: runs[](得点・打点・自責)をエンジンが導出する(AIは出さない)", () => {
  it("安打での生還は rbi=true・cause=hit", () => {
    const r = deriveRuns({ first: null, second: null, third: "C" }, pa({ batter_id: "D", result: "H1", baserunning_after: [{ runner_id: "C", from: "3", to: "home" }] }));
    expect(r).toEqual([{ runner_id: "C", rbi: true, earned: true, cause: "hit", origin: "auto" }]);
  });
  it("本塁打は塁上＋打者が全員 rbi=true・cause=hr", () => {
    const r = deriveRuns({ first: "A", second: null, third: "C" }, pa({ batter_id: "D", result: "HR" }));
    expect(r.map((x) => x.runner_id)).toEqual(["C", "A", "D"]);
    expect(r.every((x) => x.rbi && x.cause === "hr")).toBe(true);
  });
  it("満塁四球の押し出しは rbi=true・cause=walk", () => {
    const r = deriveRuns({ first: "A", second: "B", third: "C" }, pa({ batter_id: "D", result: "BB" }));
    expect(r).toEqual([{ runner_id: "C", rbi: true, earned: true, cause: "walk", origin: "auto" }]);
  });
  it("エラーでの生還は rbi=false・earned=false・cause=error", () => {
    const r = deriveRuns({ first: null, second: null, third: "C" }, pa({ batter_id: "D", result: "E", baserunning_after: [{ runner_id: "C", from: "3", to: "home" }] }));
    expect(r).toEqual([{ runner_id: "C", rbi: false, earned: false, cause: "error", origin: "auto" }]);
  });
  it("暴投(during)での生還は rbi=false・cause=wp", () => {
    const r = deriveRuns({ first: null, second: null, third: "C" }, pa({ batter_id: "D", result: "K", baserunning_during: [{ event: "WP", runners: [{ runner_id: "C", from: "3", to: "home" }] }] }));
    expect(r).toEqual([{ runner_id: "C", rbi: false, earned: true, cause: "wp", origin: "auto" }]);
  });
  it("0点なら空", () => {
    expect(deriveRuns({ first: "A", second: null, third: null }, pa({ batter_id: "D", result: "OUT" }))).toEqual([]);
  });
  it("[§10.6 非対称onBoard] 明示 to:home は盤面に走者不在でも runs[] に保持する(非破壊fill)", () => {
    // 三塁に誰も居ない盤面で after で C の生還を明示 → 黙って落とさず1件(fill側=deriveRunsはonBoard撤去)
    const p = pa({ batter_id: "D", result: "H1", baserunning_after: [{ runner_id: "C", from: "3", to: "home" }] });
    const empty = { first: null, second: null, third: null };
    expect(deriveRuns(empty, p).map((x) => x.runner_id)).toEqual(["C"]);
    // check側 deriveScorers は onBoard 維持=盤面が支える生還のみ → 拾わない。この差を R1 が検出しflagできる。
    expect(deriveScorers(empty, p)).toEqual([]);
  });
  it("[§10.6] during(暴投)の明示 to:home も盤面不在で保持する(非破壊fill)", () => {
    const p = pa({ batter_id: "D", result: "K", baserunning_during: [{ event: "WP", runners: [{ runner_id: "C", from: "3", to: "home" }] }] });
    const empty = { first: null, second: null, third: null };
    expect(deriveRuns(empty, p).map((x) => x.runner_id)).toEqual(["C"]);
    expect(deriveScorers(empty, p)).toEqual([]);
  });
});

describe("[クラスタB1] 四死球でも明示 baserunning_after の生還(to:home)を落とさない", () => {
  it("四球+送球逸れで走者が生還(after to:home)→ runs[]に立つ・rbi=false・earned=null(自責不明)", () => {
    // 三塁に走者C(一二塁は空=非強制)。四球で打者Dは一塁へ、Cは送球逸れで生還(afterで明示)。
    const start = { first: null, second: null, third: "C" };
    const p = pa({ batter_id: "D", result: "BB", baserunning_after: [{ runner_id: "C", from: "3", to: "home" }] });
    expect(deriveRuns(start, p)).toEqual([{ runner_id: "C", rbi: false, earned: null, cause: "other", origin: "auto" }]);
    // 盤面にCが実在するので check側 deriveScorers も拾う=食い違い無し(R1は出ない=過剰タグ回避)
    expect(deriveScorers(start, p)).toEqual(["C"]);
    // foldRunners: Cは生還で盤面から消え、打者Dが一塁
    expect(foldRunners(start, p)).toEqual({ first: "D", second: null, third: null });
  });

  it("満塁四球の強制押し出し(rbi=true)と after の余分生還(rbi=false/earned=null)が二重計上されず共存", () => {
    const start = { first: "A", second: "B", third: "C" };
    // 満塁四球: Cが押し出しで生還(強制)。押し出しで三塁へ来たBが送球逸れで生還(after明示)。
    const p = pa({ batter_id: "D", result: "BB", baserunning_after: [{ runner_id: "B", from: "3", to: "home" }] });
    expect(deriveRuns(start, p)).toEqual([
      { runner_id: "C", rbi: true, earned: true, cause: "walk", origin: "auto" }, // 標準の押し出し得点
      { runner_id: "B", rbi: false, earned: null, cause: "other", origin: "auto" }, // 非強制の余分生還
    ]);
    expect(deriveScorers(start, p)).toEqual(["C", "B"]); // 二重計上なし
  });

  it("after の走者が既に強制で還った走者と同一なら二重計上しない(dedup)", () => {
    const start = { first: "A", second: "B", third: "C" };
    // 満塁四球でCが押し出し生還。afterに冗長にCの生還が書かれても1件のみ。
    const p = pa({ batter_id: "D", result: "BB", baserunning_after: [{ runner_id: "C", from: "3", to: "home" }] });
    expect(deriveRuns(start, p).map((x) => x.runner_id)).toEqual(["C"]);
    expect(deriveScorers(start, p)).toEqual(["C"]);
  });

  it("盤面矛盾(after to:home の走者が盤面不在)→ deriveRunsは保持(非破壊fill)・deriveScorersは拾わない=R1発火材料", () => {
    const empty = { first: null, second: null, third: null };
    const p = pa({ batter_id: "D", result: "BB", baserunning_after: [{ runner_id: "C", from: "3", to: "home" }] });
    expect(deriveRuns(empty, p).map((x) => x.runner_id)).toEqual(["C"]); // fill=落とさない
    expect(deriveScorers(empty, p)).toEqual([]); // onBoard維持=拾わない → 非対称で R1 が食い違いを検知
  });

  it("after の reason があれば cause に反映(earned/rbi は不明側=null/false のまま)", () => {
    const start = { first: null, second: null, third: "C" };
    const p = pa({ batter_id: "D", result: "HBP", baserunning_after: [{ runner_id: "C", from: "3", to: "home", reason: "WP" }] });
    expect(deriveRuns(start, p)).toEqual([{ runner_id: "C", rbi: false, earned: null, cause: "wp", origin: "auto" }]);
  });

  it("四球で after が空なら従来どおり(満塁押し出しのみ・after ループは無害)", () => {
    const loaded = { first: "A", second: "B", third: "C" };
    expect(deriveRuns(loaded, pa({ batter_id: "D", result: "BB" }))).toEqual([{ runner_id: "C", rbi: true, earned: true, cause: "walk", origin: "auto" }]);
    expect(deriveScorers(loaded, pa({ batter_id: "D", result: "BB" }))).toEqual(["C"]);
  });
});

describe("derivePAStates: 四球ラリーの開始時走者が正しい(保存値を使わない)", () => {
  it("四球→四球→凡退→四球 の各開始時走者", () => {
    const d = doc({
      home_away: "home",
      lineup_snapshots: [snap(LINEUP, { effective_from: { inning: 1, half: "bottom", before_order: null } })],
      plate_appearances: [
        // 保存値(outs/runners)はわざと壊しておく＝導出が無視することを確認
        pa({ inning: 1, half: "bottom", order: 1, batter_id: "P1", result: "BB", runners: { first: "ZZ", second: null, third: null } }),
        pa({ inning: 1, half: "bottom", order: 2, batter_id: "P2", result: "BB", runners: EMPTY }),
        pa({ inning: 1, half: "bottom", order: 3, batter_id: "P3", result: "OUT", runners: EMPTY }),
        pa({ inning: 1, half: "bottom", order: 4, batter_id: "P4", result: "BB", outs: 1, runners: EMPTY }),
      ],
    });
    const st = derivePAStates(d);
    const at = (o: number) => [...st.entries()].find(([p]) => p.order === o)![1];
    expect(at(1).runners).toEqual(EMPTY); // 先頭は走者なし
    expect(at(2).runners).toEqual({ first: "P1", second: null, third: null }); // P1が一塁(導出＝保存の壊れ値ZZを無視)
    expect(at(3).runners).toEqual({ first: "P2", second: "P1", third: null }); // 一二塁
    expect([at(3).outs, at(4).outs]).toEqual([0, 1]); // アウトは保存値(正)を表示
    expect(at(4).runners).toEqual({ first: "P2", second: "P1", third: null }); // 凡退では走者不変
  });
});

describe("foldRunners", () => {
  it("打球での走者移動(after)を反映", () => {
    const r = foldRunners(EMPTY, pa({ batter_id: "P1", result: "H1", baserunning_after: [{ runner_id: "P1", from: null, to: "1" }] }));
    expect(r).toEqual({ first: "P1", second: null, third: null });
  });
  it("一塁走者が二塁へ進む(from空ける)", () => {
    const r = foldRunners({ first: "P1", second: null, third: null }, pa({
      batter_id: "P2", result: "H1",
      baserunning_after: [{ runner_id: "P1", from: "1", to: "2" }, { runner_id: "P2", from: null, to: "1" }],
    }));
    expect(r).toEqual({ first: "P2", second: "P1", third: null });
  });
  it("生還(to:home)は塁に残さない", () => {
    const r = foldRunners({ first: null, second: null, third: "P1" }, pa({
      batter_id: "P2", result: "H1",
      runs: [{ runner_id: "P1", rbi: true, earned: true, cause: "hit" }],
      baserunning_after: [{ runner_id: "P1", from: "3", to: "home" }, { runner_id: "P2", from: null, to: "1" }],
    }));
    expect(r).toEqual({ first: "P2", second: null, third: null });
  });
  it("打席中の盗塁(during)も反映", () => {
    const r = foldRunners({ first: "P1", second: null, third: null }, pa({
      batter_id: "P2", result: "OUT",
      baserunning_during: [{ event: "SB", runners: [{ runner_id: "P1", from: "1", to: "2" }] }],
    }));
    expect(r).toEqual({ first: null, second: "P1", third: null });
  });
});

describe("deriveNextPA (away=自軍top)", () => {
  it("空のイニング先頭: order1・0アウト・走者なし・1番打者", () => {
    const d = deriveNextPA(doc({ home_away: "away" }), 1, "top");
    expect([d.order, d.outs]).toEqual([1, 0]);
    expect(d.runners).toEqual(EMPTY);
    expect([d.batting_slot, d.batter_id]).toEqual([1, "P1"]);
  });
  it("1人凡退後: order2・1アウト・2番打者", () => {
    const d = deriveNextPA(doc({
      home_away: "away",
      plate_appearances: [pa({ order: 1, batter_id: "P1", result: "OUT" })],
    }), 1, "top");
    expect([d.order, d.outs, d.batting_slot, d.batter_id]).toEqual([2, 1, 2, "P2"]);
  });
  it("先頭安打後: 走者一塁・order2・0アウト", () => {
    const d = deriveNextPA(doc({
      home_away: "away",
      plate_appearances: [pa({ order: 1, batter_id: "P1", result: "H1", baserunning_after: [{ runner_id: "P1", from: null, to: "1" }] })],
    }), 1, "top");
    expect([d.order, d.outs]).toEqual([2, 0]);
    expect(d.runners).toEqual({ first: "P1", second: null, third: null });
  });
  it("打順は一巡して先頭へ戻る(9打者後は1番)", () => {
    const pas = LINEUP.filter(([o]) => o != null).map(([o, , pid], i) =>
      pa({ order: i + 1, batter_id: pid, result: "H1", baserunning_after: [] })
    );
    const d = deriveNextPA(doc({ home_away: "away", plate_appearances: pas }), 1, "top");
    expect(d.batting_slot).toBe(1);
    expect(d.batter_id).toBe("P1");
  });
  it("相手の攻撃(bottom)は打順位置(opponent_slot)＋プレースホルダ(oN)を順繰りに", () => {
    const d0 = deriveNextPA(doc({ home_away: "away" }), 1, "bottom");
    expect([d0.batter_id, d0.batting_slot, d0.opponent_slot]).toEqual(["o1", null, 1]);
    const d1 = deriveNextPA(doc({
      home_away: "away",
      plate_appearances: [pa({ inning: 1, half: "bottom", order: 1, batter_id: "o1", opponent_slot: 1, result: "OUT" })],
    }), 1, "bottom");
    expect([d1.batter_id, d1.opponent_slot]).toEqual(["o2", 2]);
  });
});

describe("deriveNextPA (home=自軍bottom)", () => {
  it("home: 自軍はbottomで打順、topは相手の打順位置", () => {
    const s = snap(LINEUP, { effective_from: { inning: 1, half: "bottom", before_order: null } });
    const d = deriveNextPA(doc({ home_away: "home", lineup_snapshots: [s] }), 1, "bottom");
    expect([d.batting_slot, d.batter_id, d.opponent_slot]).toEqual([1, "P1", null]);
    const dt = deriveNextPA(doc({ home_away: "home", lineup_snapshots: [s] }), 1, "top");
    expect([dt.batter_id, dt.opponent_slot]).toEqual(["o1", 1]);
  });
});

describe("resolvePATarget (側で半イニングを決める・アウトでは切らない)", () => {
  // home=自軍bottom, 相手はtopで攻撃。
  const home = (pas: ReturnType<typeof pa>[]) => {
    const s = snap(LINEUP, { effective_from: { inning: 1, half: "bottom", before_order: null } });
    return doc({ home_away: "home", lineup_snapshots: [s], plate_appearances: pas });
  };
  const oppOut = (inning: number, order: number, n: number) =>
    pa({ inning, half: "top", order, batter_id: `o${n}`, opponent_slot: n, result: "OUT" });

  it("side=opponent なら half未指定でも相手側(top)に解決(§9: 側は呼び出し側がメンバーシップで判定)", () => {
    expect(resolvePATarget(home([]), { side: "opponent" })).toEqual({ inning: 1, half: "top" });
  });
  it("side=kings は自軍side(bottom)に解決", () => {
    expect(resolvePATarget(home([]), { side: "kings" })).toEqual({ inning: 1, half: "bottom" });
  });
  it("同じ側を続けるなら同じ回に積む(3アウトでも自動で切らない＝4アウト目も1回表)", () => {
    const d = home([oppOut(1, 1, 1), oppOut(1, 2, 2), oppOut(1, 3, 3)]);
    expect(resolvePATarget(d, { half: "top", side: "opponent" })).toEqual({ inning: 1, half: "top" });
    expect(deriveNextPA(d, 1, "top").outs).toBe(3); // 開始時すでに3アウトでも受け入れる
  });
  it("側が替わったら新しい半イニング: 表→裏→表 で 2回表になる", () => {
    const d = home([oppOut(1, 1, 1), pa({ inning: 1, half: "bottom", order: 1, batter_id: "P1", result: "OUT" })]);
    expect(resolvePATarget(d, { side: "opponent" })).toEqual({ inning: 2, half: "top" }); // 相手が再び＝2回表
    expect(resolvePATarget(d, { side: "kings" })).toEqual({ inning: 1, half: "bottom" }); // 自軍継続＝1回裏
  });
  it("明示 inning/half は最優先", () => {
    expect(resolvePATarget(home([]), { inning: 5, half: "bottom", side: "opponent" })).toEqual({ inning: 5, half: "bottom" });
  });
});

describe("gameState", () => {
  it("空の試合: 1回表・0アウト・0-0", () => {
    const st = gameState(doc({ home_away: "away" }));
    expect([st.inning, st.half, st.outs, st.kings_score, st.opp_score, st.pa_count]).toEqual([1, "top", 0, 0, 0, 0]);
  });
  it("3アウトでも自動で先送りしない(最後の半イニングをそのまま報告)", () => {
    const st = gameState(doc({
      home_away: "away",
      plate_appearances: [
        pa({ order: 1, batter_id: "P1", result: "OUT" }),
        pa({ order: 2, batter_id: "P2", result: "OUT" }),
        pa({ order: 3, batter_id: "P3", result: "OUT" }),
      ],
    }));
    expect([st.inning, st.half, st.outs]).toEqual([1, "top", 3]);
  });
  it("半イニング途中: アウト数と走者を保持", () => {
    const st = gameState(doc({
      home_away: "away",
      plate_appearances: [
        pa({ order: 1, batter_id: "P1", result: "OUT" }),
        pa({ order: 2, batter_id: "P2", result: "H1", baserunning_after: [{ runner_id: "P2", from: null, to: "1" }] }),
      ],
    }));
    expect([st.inning, st.half, st.outs]).toEqual([1, "top", 1]);
    expect(st.runners).toEqual({ first: "P2", second: null, third: null });
  });
  it("得点はruns[]の長さで自軍/相手に振り分け", () => {
    const st = gameState(doc({
      home_away: "away",
      plate_appearances: [
        pa({ inning: 1, half: "top", order: 1, batter_id: "P1", result: "HR", runs: [{ runner_id: "P1", rbi: true, earned: true, cause: "hr" }] }),
        pa({ inning: 1, half: "bottom", order: 1, batter_id: "O001", result: "HR", runs: [{ runner_id: "O001", rbi: true, earned: true, cause: "hr" }] }),
        pa({ inning: 1, half: "bottom", order: 2, batter_id: "O002", result: "HR", runs: [{ runner_id: "O002", rbi: true, earned: true, cause: "hr" }] }),
      ],
    }));
    expect([st.kings_score, st.opp_score]).toEqual([1, 2]);
  });
});
