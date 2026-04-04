# 求人票自動生成アプリ (Job Listing Generator)

会社名またはURLを入力すると、AIが求人情報を収集・整理し、きれいなPDFを自動生成するWebアプリです。

## 機能

- 🔍 会社名から求人情報をAI検索・収集
- 🌐 求人ページURLから直接スクレイピング
- 🤖 OpenAI GPT-4o-miniで情報を整理・補完
- 📄 テーブル形式のPDF求人票を自動生成

## セットアップ

```bash
# インストール
npm install

# 環境変数を設定
cp .env.example .env.local
# .env.local を編集してAPIキーを設定

# 開発サーバー起動
npm run dev
```

## 環境変数

| 変数 | 必須 | 説明 |
|------|------|------|
| `OPENAI_API_KEY` | ✅ | OpenAI APIキー |
| `SERPAPI_KEY` | ❌ | SerpAPI キー（Web検索精度向上） |

## 使い方

1. http://localhost:3000 を開く
2. 会社名（例: `〇〇クリニック`）またはURLを入力
3. 「生成」ボタンをクリック
4. AIが求人情報を収集・整理（10-30秒）
5. プレビューを確認
6. 「PDFダウンロード」でPDFを保存

## 技術スタック

- **Next.js 15** (App Router)
- **TypeScript**
- **Tailwind CSS**
- **OpenAI API** (GPT-4o-mini)
- **@react-pdf/renderer** (PDF生成)
- **cheerio** (HTMLスクレイピング)
- **SerpAPI** (Web検索、オプション)

## デプロイ

```bash
# Vercelにデプロイ
npx vercel
```

Vercelダッシュボードで環境変数 `OPENAI_API_KEY` を設定してください。

## 求人票フォーマット

| セクション | 項目 |
|-----------|------|
| 募集概要 | 職種、給与、勤務地 |
| 仕事内容 | 業務内容、クリニック紹介 |
| 募集要項 | 雇用形態、勤務時間、応募資格 |
| 仕事環境 | 給与・待遇、休日・休暇、福利厚生 |
