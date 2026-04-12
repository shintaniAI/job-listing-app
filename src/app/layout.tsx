import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "求人媒体 横断検索",
  description: "会社名を入力するだけで、Indeed / doda / マイナビ転職 / リクナビNEXT / エン転職 の掲載求人を横断検索し、原文のまま表示します。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className="min-h-screen bg-gray-50">{children}</body>
    </html>
  );
}
