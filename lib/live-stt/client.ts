// プロバイダ選択(ブラウザ側)。LiveSessionInfo.provider に応じて実装を返す。他プロバイダはここに分岐を足す。
import type { LiveSessionInfo, LiveTranscriber, LiveTranscriberEvents } from "./types";
import { createOpenAiTranscriber } from "./openai";

export function createLiveTranscriber(info: LiveSessionInfo, ev: LiveTranscriberEvents): LiveTranscriber {
  switch (info.provider) {
    case "openai": return createOpenAiTranscriber(info, ev);
  }
}
