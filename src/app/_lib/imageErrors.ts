/*
  画像アップロードのエラー文言(画面設計 §7-5 / screenshots/2026-10-04-adpop-image/html/07d-popup-edit-image-errors.html)。
  🔴 文言はコード側のエラー種別(src/lib/storage/image.ts の checkImage・src/admin/app.ts)にそのまま対応させる。
    謝辞・内部のエラーコード(image_size 等)は画面に出さない。
*/
export function imageErrorMessage(reason: string, serverMessage: string | undefined): string {
  switch (reason) {
    case "body_too_large":
    case "image_size":
      return "サイズが大きすぎます(画像は2MB、GIFは3MBまで)";
    case "image_type":
      return "この形式には対応していません(PNG・JPEG・GIF・WebPのみ)";
    case "image_dimensions":
      return serverMessage ?? "画像が大きすぎます(長い辺 2,400px まで)";
    case "image_corrupt":
    case "image_empty":
      return "画像を読み取れませんでした。別の画像をお試しください。";
    case "network":
      return "通信できませんでした。もう一度お試しください。";
    default:
      return "アップロードできませんでした。もう一度お試しください。";
  }
}
