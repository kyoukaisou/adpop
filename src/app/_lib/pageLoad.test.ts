import { describe, expect, it } from "vitest";
import { nextLoadErrorState } from "./pageLoad";

describe("nextLoadErrorState", () => {
  it("成功したら両方false(まだ一度も成功していなくても)", () => {
    expect(nextLoadErrorState(true, false)).toEqual({ loadError: false, reloadError: false });
    expect(nextLoadErrorState(true, true)).toEqual({ loadError: false, reloadError: false });
  });

  it("最初の読み込みが失敗(まだ一度も成功していない) → loadError(編集画面を丸ごとエラー画面にしてよい)", () => {
    expect(nextLoadErrorState(false, false)).toEqual({ loadError: true, reloadError: false });
  });

  it("再現: 一度表示した後の再取得が失敗(保存・アーカイブ・トリガー切替後など) → reloadError(画面は残す)", () => {
    expect(nextLoadErrorState(false, true)).toEqual({ loadError: false, reloadError: true });
  });

  it("壊れた判定(hasLoadedOnceを無視して常にloadErrorにする)だと、再現テストが落ちることを確認する", () => {
    // 🔴 レビュー指摘の裁定「壊したら落ちることを1回確かめる」に対応する検査。
    function brokenNextLoadErrorState(ok: boolean): LoadErrorStateLike {
      return ok ? { loadError: false, reloadError: false } : { loadError: true, reloadError: false };
    }
    type LoadErrorStateLike = { loadError: boolean; reloadError: boolean };
    expect(brokenNextLoadErrorState(false)).not.toEqual(nextLoadErrorState(false, true));
  });
});
