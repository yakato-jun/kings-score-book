/**
 * Live 文字起こし(ストリーミングSTT)のプロバイダ非依存の契約。
 * サーバ(/api/voice/live-session)が provider 別の接続情報を返し、クライアントは createLiveTranscriber で実装を選ぶ。
 * 現在の実装は OpenAI(gpt-live-transcribe) のみ。他プロバイダ(例: Gemini Live)は LiveSessionInfo に variant を足し、
 * 同じ LiveTranscriber を実装すれば UI(NoteClient)は変更不要。
 */

/** サーバが発行する接続情報(provider で判別)。秘密は短命トークンのみ(APIキーはブラウザへ出さない) */
export type LiveSessionInfo = {
  provider: "openai";
  /** 一時クライアントシークレット(ek_...) */
  token: string;
  /** WebSocket 接続先 */
  url: string;
  /** 送るPCMのサンプルレート */
  sampleRate: number;
  model: string;
};

export interface LiveTranscriberEvents {
  /** 確定前の途中テキスト(発話順に並んだ未確定item全体)。表示専用 */
  onPartial(text: string): void;
  /** 確定テキスト(発話順で1件ずつ)。空文字は来ない */
  onFinal(text: string): void;
  /** 回復不能なエラー(接続断・セッション拒否など)。以後イベントは来ない */
  onError(message: string): void;
}

export interface LiveTranscriber {
  /** 接続を開く(解決=送信可能) */
  connect(): Promise<void>;
  /** マイク音声(AudioContext のレートの Float32 モノラル)を送る */
  pushAudio(samples: Float32Array, inputRate: number): void;
  /** 発話の区切り(ここまでの音声を1件として確定させる)。有声が無い区間で呼ばない(空commitはエラー) */
  commit(): void;
  /** 未確定分の確定を待って閉じる(timeoutMs で打ち切り) */
  close(timeoutMs?: number): Promise<void>;
  /** 即時に閉じる(アンマウント時。以後イベントを出さない) */
  abort(): void;
}
