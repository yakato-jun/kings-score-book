// 音声入力の「発話区切り」状態機械(純ロジック・ブラウザAPI非依存)。
// 録音セッション中、~100ms間隔で音量(RMS)を受け取り、「ここまでを1チャンクとして確定してよい」
// タイミング(cut)を判定する。切り出した理由: AnalyserNode/MediaRecorder と切り離すことで
// 閾値・時間条件の振る舞いを vitest で直接検証できる(実マイクなしでテスト可能)。

export interface SegmenterOpts {
  /** これ以上のRMSを「有声」とみなす閾値(0..1)。環境ノイズで揺れるので将来調整前提 */
  threshold: number;
  /** 発話の区切りとみなす無音の連続時間。短いと文中の間で切れ、長いと体感が遅くなる */
  silenceMs: number;
  /** これ未満の有声しかないセグメントは「物音」扱い=cutしない(STTに投げる価値がない) */
  minVoiceMs: number;
  /** セグメントの上限。これを超えたら次の短い息継ぎで切る(1チャンクが肥大してSTTが遅く/重くなるのを防ぐ) */
  hardCapMs: number;
  /** hardCap超過後に適用する緩い無音条件。通常のsilenceMsを待たず、息継ぎ程度の間で切る */
  relaxedSilenceMs: number;
}

// 既定値。閾値・時間はいずれも実地の使用感で調整する前提の名前付き定数(マジックナンバーにしない)。
export const DEFAULT_SEGMENTER_OPTS: SegmenterOpts = {
  threshold: 0.03, // 静かな室内のノイズフロア(~0.01)より上、小声(~0.05)より下を狙った初期値
  silenceMs: 1800, // 「言い終えた」と判断する間。文中の息継ぎ(<1秒)では切らない長さ
  minVoiceMs: 300, // 咳・物がぶつかる音など瞬間的なノイズを発話と誤認しない下限
  hardCapMs: 60_000, // 1分を超える長話は次の息継ぎで分割(アップロードサイズとSTT遅延の抑制)
  relaxedSilenceMs: 800, // hardCap超過後の「息継ぎ」判定。話の勢いを止めずに切れる短さ
};

export type SegmenterResult = "none" | "cut";

export interface Segmenter {
  /** ~100ms間隔で呼ぶ。rms=直近の音量(0..1)、dtMs=前回pushからの経過ms。"cut"=ここでセグメント確定 */
  push(rms: number, dtMs: number): SegmenterResult;
  /** 現セグメントに minVoiceMs 以上の有声があったか(=STTに投げる価値があるか)。停止時の最終セグメント判定用 */
  hadVoice(): boolean;
  /** 内部状態を初期化(セッション開始時・セグメント切替時)。cut を返した時は内部で自動リセット済み */
  reset(): void;
}

export function createSegmenter(opts?: Partial<SegmenterOpts>): Segmenter {
  const o: SegmenterOpts = { ...DEFAULT_SEGMENTER_OPTS, ...opts };
  let voiceMs = 0; // 現セグメントの有声累計(連続でなくてよい: 途切れ途切れの発話も合算)
  let silenceRunMs = 0; // 無音の「連続」時間。有声が来たら0に戻る=文中の谷では切らない
  let elapsedMs = 0; // 現セグメントの経過時間(hardCap判定用)

  function reset() {
    voiceMs = 0;
    silenceRunMs = 0;
    elapsedMs = 0;
  }

  function hadVoice(): boolean {
    // 「有声あり」= minVoiceMs 以上。瞬間ノイズだけのセグメントをSTTへ投げない基準と同一にする
    return voiceMs >= o.minVoiceMs;
  }

  function push(rms: number, dtMs: number): SegmenterResult {
    elapsedMs += dtMs;
    if (rms >= o.threshold) {
      // 有声: 累計を進め、無音連続をリセット(発話の谷=息継ぎでは切らないための核)
      voiceMs += dtMs;
      silenceRunMs = 0;
      return "none";
    }
    silenceRunMs += dtMs;
    // hardCap超過後は緩い無音条件に切り替える(長話でも次の息継ぎで確定させる)。
    // 通常は silenceMs=「言い終えた」間を待つ。
    const neededSilence = elapsedMs >= o.hardCapMs ? o.relaxedSilenceMs : o.silenceMs;
    // cut条件: 発話が実在した(minVoiceMs以上)+ 無音が十分続いた。
    // 無声のみのセグメントでは voiceMs が積まれないため、何分無音が続いても決して cut しない。
    if (voiceMs >= o.minVoiceMs && silenceRunMs >= neededSilence) {
      reset(); // 呼び出し側が新セグメントを開始する前提で、次の判定に前セグメントの状態を持ち越さない
      return "cut";
    }
    return "none";
  }

  return { push, hadVoice, reset };
}
