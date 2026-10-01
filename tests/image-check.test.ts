// @vitest-environment node
//
// 画像の判定(src/lib/storage/image.ts)。中身で決める / SVG を受けない / JPEG の APP1 を落とす(監査 L1)。
import { describe, expect, it } from "vitest";
import { checkImage, GIF_LIMIT_BYTES, IMAGE_LIMIT_BYTES, sniffImageType, stripJpegApp1 } from "../src/lib/storage/image";

const SOI = [0xff, 0xd8];
const SOS_TO_EOI = [0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9];
const APP0 = [0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46];
const APP1_EXIF = [0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
const APP1_XMP = [0xff, 0xe1, 0x00, 0x05, 0x68, 0x74, 0x74];

describe("形式の判定", () => {
  it.each([
    ["PNG", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0], "image/png"],
    ["JPEG", [...SOI, 0xff, 0xe0], "image/jpeg"],
    ["GIF89a", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], "image/gif"],
    ["WebP", [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], "image/webp"],
  ])("✅ %s", (_label, bytes, mime) => {
    expect(sniffImageType(Uint8Array.from(bytes))?.mime).toBe(mime);
  });
  it.each([
    ["SVG", new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")],
    ["HTML", new TextEncoder().encode("<!doctype html>")],
    ["空", new Uint8Array()],
  ])("🔴 %s は受けない", (_label, bytes) => {
    expect(checkImage(bytes).ok).toBe(false);
  });
  it("🔴 大きさ: GIF でないものは 2MB、GIF は 3MB まで", () => {
    const png = new Uint8Array(IMAGE_LIMIT_BYTES + 1);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(checkImage(png)).toEqual({ ok: false, reason: "size" });
    const gif = new Uint8Array(GIF_LIMIT_BYTES);
    gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(checkImage(gif).ok).toBe(true);
  });
});

describe("JPEG の APP1(Exif・XMP)を落とす", () => {
  it("🔴 APP1 を2つとも落とし、APP0 と画像データは残す", () => {
    const input = Uint8Array.from([...SOI, ...APP0, ...APP1_EXIF, ...APP1_XMP, ...SOS_TO_EOI]);
    expect(Array.from(stripJpegApp1(input)!)).toEqual([...SOI, ...APP0, ...SOS_TO_EOI]);
  });
  it("🔴 形が壊れていたら null(元のバイト列を黙って返さない)", () => {
    expect(stripJpegApp1(Uint8Array.from([...SOI, 0xff, 0xe1, 0x00, 0xff, 0x00]))).toBeNull();
    expect(stripJpegApp1(Uint8Array.from([...SOI, 0x00, 0x00]))).toBeNull();
    expect(checkImage(Uint8Array.from([...SOI, 0xff, 0xe1, 0x00, 0xff]))).toEqual({ ok: false, reason: "corrupt" });
  });
});
