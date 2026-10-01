/*
  Worker(配信・管理画面)が console に出すエラーの1行を**匿名化**する(Codex #4 Blocker 3・本部裁定)。
  🔴 訪問者に関わる値(IP アドレス・Origin・サイトキー・URL・イベントの中身)を**そのまま出さない**。
  ⚠ やっているのは「形で伏せる」ことだけ: IPv4 / IPv6 の形・URL・引用符の中・8桁以上の16進と数字を伏せ、長さを切る。
    **伏せ漏れが無いことは保証しない**(D1 の失敗の文言の形は D1 の実装で決まる)。
    だから**入力の値をこちらから文言に混ぜない**(出すのは「どこで・何の種類の失敗か」だけ)。
*/
const MAX_LENGTH = 160;

export function redact(message: string): string {
  return message
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "<quoted>")
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "<ip>")
    .replace(/\b[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}\b/gi, "<ip>")
    .replace(/\b[0-9a-f-]{8,}\b/gi, "<id>")
    .slice(0, MAX_LENGTH);
}

/** `[adpop] <どこで> failed: <種類>: <伏せた文言>` を1行出す。 */
export function logFailure(where: string, error: unknown): void {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[adpop] ${where} failed: ${name}: ${redact(message)}`);
}
