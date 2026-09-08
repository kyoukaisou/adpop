import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "ADPOP",
  description: "LP に script を1行貼るだけの離脱ポップ",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
