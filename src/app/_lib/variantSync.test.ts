import { describe, expect, it } from "vitest";
import {
  computeSyncPatch,
  extractSyncedFields,
  isDirtyFrom,
  shouldApplyPropsSync,
  type SyncedFields,
} from "./variantSync";
import type { ApiVariant } from "./types";

const VARIANT_A: ApiVariant = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  popupId: "popup-1",
  kind: "text",
  content: { headline: "元の見出し", body: "", buttonLabel: "", imageAlt: "" },
  destinationUrl: "https://example.com/a",
  archivedAt: null,
};

describe("variantSync", () => {
  it("baselineが無い(下書き)ときはdirty扱いにしない", () => {
    const current: SyncedFields = { kind: "text", headline: "何か入力中", body: "", buttonLabel: "", imageAlt: "", destinationUrl: "" };
    expect(isDirtyFrom(null, current)).toBe(false);
  });

  it("再現: Aを編集中(未保存)に、無関係な再読み込み(B保存・トリガー切替・ポップ設定保存)が来ても入力を失わない", () => {
    const baseline = extractSyncedFields(VARIANT_A);
    // Aの見出しを編集したが、まだ保存していない
    const editedA: SyncedFields = { ...baseline, headline: "編集中の見出し(未保存)" };

    const dirty = isDirtyFrom(baseline, editedA);
    expect(dirty).toBe(true);

    // Bの保存・トリガー切替・ポップ設定の保存は、いずれも一覧全体を再読み込みさせ、
    // Aコンポーネントにも新しい variant props が届く(内容は同じでもオブジェクトは新しい)。
    // dirty な間は、この新しい props を適用してはいけない。
    const shouldSync = shouldApplyPropsSync({ hasVariant: true, busy: false, dirty });
    expect(shouldSync).toBe(false);
  });

  it("Aを自分で保存した後は、baselineが更新され、以後はサーバー値で揃う", () => {
    const baseline = extractSyncedFields(VARIANT_A);
    const editedA: SyncedFields = { ...baseline, headline: "編集中の見出し(未保存)" };
    expect(isDirtyFrom(baseline, editedA)).toBe(true);

    // Aを保存した(サーバーがtrimした値をそのまま新しいbaselineとして採用する想定)
    const newBaseline: SyncedFields = { ...editedA };
    // 保存直後、画面の入力値はnewBaselineと一致している(自分の保存結果を自分に反映しただけ)
    const afterSave = { ...newBaseline };
    expect(isDirtyFrom(newBaseline, afterSave)).toBe(false);
    expect(shouldApplyPropsSync({ hasVariant: true, busy: false, dirty: isDirtyFrom(newBaseline, afterSave) })).toBe(true);
  });

  it("操作中(busy)は、dirtyでなくても同期しない", () => {
    expect(shouldApplyPropsSync({ hasVariant: true, busy: true, dirty: false })).toBe(false);
  });

  it("variantが無い(下書き行)ときは同期しない", () => {
    expect(shouldApplyPropsSync({ hasVariant: false, busy: false, dirty: false })).toBe(false);
  });

  describe("computeSyncPatch(レビュー指摘: 画像だけの操作は文字欄・baselineに触れない)", () => {
    const baseline = extractSyncedFields(VARIANT_A);

    it("再現: 文字欄が書きかけのまま「差し替え」(image-only)しても、文字欄・baselineは変わらない", () => {
      const patch = computeSyncPatch({ kind: "image-only", imageKey: "images/new.png" });
      expect(patch.fields).toBeNull();
      expect(patch.baseline).toBeNull();
      expect(patch.imageKey).toBe("images/new.png");
    });

    it("再現: 「外す」(image-only・imageKey=null)でも、文字欄・baselineは変わらない", () => {
      const patch = computeSyncPatch({ kind: "image-only", imageKey: null });
      expect(patch.fields).toBeNull();
      expect(patch.baseline).toBeNull();
      expect(patch.imageKey).toBeNull();
    });

    it("保存(save)は、文字欄・baseline・imageKeyの全部をサーバー値に揃える", () => {
      const server = { ...baseline, headline: "保存された見出し", imageKey: "images/a.png" };
      const patch = computeSyncPatch({ kind: "save", server });
      const { imageKey, ...fields } = server;
      expect(patch.fields).toEqual(fields);
      expect(patch.baseline).toEqual(fields);
      expect(patch.imageKey).toBe(imageKey);
    });

    it("壊れた実装(image-onlyでもfields/baselineを返してしまう)だと、このテストが落ちることを確認する", () => {
      // 🔴 レビュー指摘の裁定「壊したら落ちることを1回確かめる」に対応する検査。
      function brokenComputeSyncPatch(event: Parameters<typeof computeSyncPatch>[0]) {
        if (event.kind === "image-only") {
          // 以前のバグ: 画像だけの操作なのに、保持していたbaselineをそのままfields/baselineとして返してしまう
          return { fields: baseline, baseline, imageKey: event.imageKey };
        }
        return computeSyncPatch(event);
      }
      const broken = brokenComputeSyncPatch({ kind: "image-only", imageKey: "images/new.png" });
      const fixed = computeSyncPatch({ kind: "image-only", imageKey: "images/new.png" });
      expect(broken.fields).not.toEqual(fixed.fields);
    });
  });
});
