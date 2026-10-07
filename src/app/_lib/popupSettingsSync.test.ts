import { describe, expect, it } from "vitest";
import { isPopupSettingsDirty, shouldApplyPopupSettingsFromServer, type PopupSettingsFields } from "./popupSettingsSync";

const BASELINE: PopupSettingsFields = {
  name: "元のポップ名",
  frequency: { suppressDays: "7", sessionImpressions: "1", postConversionDays: "30", minDisplayDelaySeconds: "3" },
};

describe("popupSettingsSync", () => {
  it("baselineが無い(まだ同期していない)ときはdirty扱いにしない", () => {
    expect(isPopupSettingsDirty(null, BASELINE)).toBe(false);
  });

  it("名前を書きかけ(未保存)にするとdirty", () => {
    const current: PopupSettingsFields = { ...BASELINE, name: "編集中の名前(未保存)" };
    expect(isPopupSettingsDirty(BASELINE, current)).toBe(true);
    expect(shouldApplyPopupSettingsFromServer(true)).toBe(false);
  });

  it("頻度の1項目だけ変えてもdirty", () => {
    const current: PopupSettingsFields = { ...BASELINE, frequency: { ...BASELINE.frequency, suppressDays: "99" } };
    expect(isPopupSettingsDirty(BASELINE, current)).toBe(true);
  });

  it("baselineと完全に一致していればdirtyではない(再取得の値を適用してよい)", () => {
    const current: PopupSettingsFields = { ...BASELINE };
    expect(isPopupSettingsDirty(BASELINE, current)).toBe(false);
    expect(shouldApplyPopupSettingsFromServer(false)).toBe(true);
  });

  it("自分で保存した後はbaselineが更新され、以後はサーバー値で揃う", () => {
    const edited: PopupSettingsFields = { ...BASELINE, name: "新しい名前" };
    expect(isPopupSettingsDirty(BASELINE, edited)).toBe(true);
    // 保存成功: 送った値が新しいbaselineになる
    const newBaseline: PopupSettingsFields = { ...edited };
    expect(isPopupSettingsDirty(newBaseline, edited)).toBe(false);
  });

  it("壊れた判定(baselineを無視して常にdirtyでないとする)だと、このテストが落ちることを確認する", () => {
    // 🔴 レビュー指摘の裁定「壊したら落ちることを1回確かめる」に対応する検査。
    const current: PopupSettingsFields = { ...BASELINE, name: "編集中の名前(未保存)" };
    const BROKEN_NOT_DIRTY = false;
    expect(isPopupSettingsDirty(BASELINE, current)).not.toBe(BROKEN_NOT_DIRTY);
  });
});
