import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ADPOP 管理画面",
  description: "LP に script を1行貼るだけの離脱ポップ — 管理画面",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className="bg-paper font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
