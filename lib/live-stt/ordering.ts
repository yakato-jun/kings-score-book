// Live 文字起こしの item 整列(純ロジック)。
// 途中テキスト(delta)は item_id 単位で届き、確定(completed)の到着順は item 間で保証されない。
// 「ノートへの挿入順=発話順」を守るため、item を初出順に並べ、先頭から連続して確定した分だけを放出する。

interface LiveOrdering {
  delta(itemId: string, text: string): void;
  /** 確定。発話順で放出可能になった確定テキスト(空は除く)を返す */
  completed(itemId: string, transcript: string): string[];
  /** 失敗した item を捨てる(後続の放出を塞がない)。放出可能になった確定テキストを返す */
  failed(itemId: string): string[];
  /** 未確定 item の途中テキストを発話順に連結したもの(表示用) */
  partial(): string;
  /** 未放出の item が残っているか */
  pending(): boolean;
}

export function createLiveOrdering(): LiveOrdering {
  type Item = { id: string; text: string; final: string | null; dropped: boolean };
  const items: Item[] = [];
  const get = (id: string): Item => {
    let it = items.find((x) => x.id === id);
    if (!it) { it = { id, text: "", final: null, dropped: false }; items.push(it); }
    return it;
  };
  const drain = (): string[] => {
    const out: string[] = [];
    while (items.length > 0 && (items[0].final !== null || items[0].dropped)) {
      const it = items.shift()!;
      const t = (it.final ?? "").trim();
      if (t) out.push(t);
    }
    return out;
  };
  return {
    delta(id, text) { get(id).text += text; },
    completed(id, transcript) { get(id).final = transcript; return drain(); },
    failed(id) { get(id).dropped = true; return drain(); },
    partial() {
      return items.filter((x) => !x.dropped).map((x) => (x.final ?? x.text).trim()).filter(Boolean).join(" ");
    },
    pending() { return items.length > 0; },
  };
}
