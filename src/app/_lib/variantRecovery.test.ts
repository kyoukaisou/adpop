import { describe, expect, it } from "vitest";
import { recoverFailedImageUpload } from "./variantRecovery";
import type { ApiVariant } from "./types";

const BASE: ApiVariant = {
  id: "11111111-1111-1111-1111-111111111111",
  popupId: "popup-1",
  kind: "image",
  content: { headline: "", body: "", buttonLabel: "", imageAlt: "alt", imageKey: null },
  destinationUrl: "https://example.com",
  archivedAt: null,
};

describe("recoverFailedImageUpload", () => {
  it("GETが通信失敗 → unknown(IDを手放さない。DELETEは試みない)", async () => {
    let deleteCalled = false;
    const outcome = await recoverFailedImageUpload(BASE.id, {
      getVariant: async () => ({ ok: false, status: 0, reason: "network" }),
      deleteVariant: async () => {
        deleteCalled = true;
        return { ok: true, data: null };
      },
    });
    expect(outcome.kind).toBe("unknown");
    expect(deleteCalled).toBe(false);
  });

  it("GETが404 → unknown(存在の有無が確定しないので安全側に倒す)", async () => {
    const outcome = await recoverFailedImageUpload(BASE.id, {
      getVariant: async () => ({ ok: false, status: 404, reason: "not_found" }),
      deleteVariant: async () => ({ ok: true, data: null }),
    });
    expect(outcome.kind).toBe("unknown");
  });

  it("GETでimageKeyが設定済み(応答だけ失われていた) → recovered", async () => {
    const saved: ApiVariant = { ...BASE, content: { ...BASE.content, imageKey: "images/aa.png" } };
    const outcome = await recoverFailedImageUpload(BASE.id, {
      getVariant: async () => ({ ok: true, data: saved }),
      deleteVariant: async () => {
        throw new Error("DELETEは呼ばれないはず");
      },
    });
    expect(outcome.kind).toBe("recovered");
    if (outcome.kind === "recovered") expect(outcome.variant.id).toBe(BASE.id);
  });

  it("imageKeyが無く、DELETEが成功 → reverted-to-draft", async () => {
    const outcome = await recoverFailedImageUpload(BASE.id, {
      getVariant: async () => ({ ok: true, data: BASE }),
      deleteVariant: async () => ({ ok: true, data: null }),
    });
    expect(outcome.kind).toBe("reverted-to-draft");
  });

  it("imageKeyが無く、DELETEが409(last_deliverable_variant)で断られる → kept-without-image(IDを手放さない)", async () => {
    const outcome = await recoverFailedImageUpload(BASE.id, {
      getVariant: async () => ({ ok: true, data: BASE }),
      deleteVariant: async () => ({ ok: false, status: 409, reason: "last_deliverable_variant", message: "…" }),
    });
    expect(outcome.kind).toBe("kept-without-image");
  });

  it("imageKeyが無く、DELETEが通信失敗 → kept-without-image(IDを手放さない)", async () => {
    const outcome = await recoverFailedImageUpload(BASE.id, {
      getVariant: async () => ({ ok: true, data: BASE }),
      deleteVariant: async () => ({ ok: false, status: 0, reason: "network" }),
    });
    expect(outcome.kind).toBe("kept-without-image");
  });

  it("imageKeyが無く、DELETEが404(既に無い) → kept-without-image(勝手に『消えた』扱いにしない)", async () => {
    const outcome = await recoverFailedImageUpload(BASE.id, {
      getVariant: async () => ({ ok: true, data: BASE }),
      deleteVariant: async () => ({ ok: false, status: 404, reason: "not_found" }),
    });
    expect(outcome.kind).toBe("kept-without-image");
  });
});
