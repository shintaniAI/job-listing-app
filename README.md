# 求人媒体 横断検索アプリ (Job Board Aggregator)

会社名を入力するだけで、日本の主要求人媒体（Indeed / doda / マイナビ転職 / リクナビNEXT / エン転職）を横断検索し、掲載があれば**掲載内容を原文のまま**媒体ごとに表示します。

## 機能

- 🔎 会社名1つで横断検索
- 📋 各媒体 最大2件の求人を原文のまま表示（コピペ用 `<textarea>`）
- 🧠 裏側は **OpenAI Responses API の `web_search` ツール**で取得（スクレイピング直叩きなし）
- 💾 最後の検索結果は localStorage に保存

## 対象媒体

| # | 媒体 | ドメイン |
|---|---|---|
| 1 | Indeed | jp.indeed.com |
| 2 | doda | doda.jp |
| 3 | マイナビ転職 | tenshoku.mynavi.jp |
| 4 | リクナビNEXT | next.rikunabi.com |
| 5 | エン転職 | employment.en-japan.com |

掲載が無い／到達できなかった媒体は「掲載なし」と表示されます。

## セットアップ

```bash
npm install
cp .env.example .env.local
# OPENAI_API_KEY を設定
npm run dev
```

## 環境変数

| 変数 | 必須 | 説明 |
|------|------|------|
| `OPENAI_API_KEY` | ✅ | OpenAI API キー（`web_search` ツール利用可能なアカウント） |

## 技術スタック

- Next.js 16 (App Router, `nodejs` runtime)
- TypeScript + Tailwind CSS v4
- openai SDK v6 (`responses.create` + `web_search` tool)

## API

### `POST /api/search`

```json
{ "companyName": "株式会社サイバーエージェント" }
```

レスポンス:

```json
{
  "companyName": "株式会社サイバーエージェント",
  "generatedAt": "2026-04-09T04:00:00.000Z",
  "sources": [
    {
      "id": "indeed",
      "media": "Indeed",
      "domain": "jp.indeed.com",
      "searchUrl": "https://jp.indeed.com/...",
      "listings": [
        { "title": "...", "url": "https://...", "rawText": "..." }
      ],
      "note": ""
    }
  ]
}
```

## 注意事項

- `rawText` は OpenAI の web_search が取得したページ内容をそのまま転記する設計ですが、LLM 経由のため完全な原文保証ではありません。最終確認は各媒体の元ページで行ってください。
- 各媒体の robots.txt / 利用規約を尊重してください。本アプリは検索結果の公開スニペット／公開求人ページの情報のみを扱います。
- Vercel Hobby の関数タイムアウト 60s に合わせて設定しています。
