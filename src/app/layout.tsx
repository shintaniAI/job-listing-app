import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "求人票自動生成アプリ",
  description: "企業の公式採用ページを優先取得し、HP・求人媒体（Indeed / doda / マイナビ転職 / リクナビNEXT / エン転職 等）も追加情報として参照して求人票を自動生成します。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className="min-h-screen bg-gray-50">{children}</body>
    </html>
  );
}
