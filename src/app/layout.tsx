import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "求人票自動生成アプリ",
  description: "会社名やURLから求人票PDFを自動生成",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className="min-h-screen bg-gray-50">{children}</body>
    </html>
  );
}
