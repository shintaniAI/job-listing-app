import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";
export const maxDuration = 60;

function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY が設定されていません");
  return new OpenAI({ apiKey });
}

const TARGET_MEDIA: { id: string; name: string; domain: string }[] = [
  { id: "indeed", name: "Indeed", domain: "jp.indeed.com" },
  { id: "doda", name: "doda", domain: "doda.jp" },
  { id: "mynavi", name: "マイナビ転職", domain: "tenshoku.mynavi.jp" },
  { id: "rikunabi", name: "リクナビNEXT", domain: "next.rikunabi.com" },
  { id: "en", name: "エン転職", domain: "employment.en-japan.com" },
];

type Listing = { title: string; url: string; rawText: string };
type Source = {
  id: string;
  media: string;
  domain: string;
  searchUrl: string;
  listings: Listing[];
  note?: string;
};

function extractJson(text: string): any | null {
  if (!text) return null;
  // Strip markdown code fences if present
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  // Direct parse
  try {
    return JSON.parse(t);
  } catch {}
  // Find first { and try progressively shrinking tail
  const start = t.indexOf("{");
  if (start < 0) return null;
  const body = t.slice(start);
  for (let end = body.length; end > 0; end--) {
    const candidate = body.slice(0, end);
    if (!candidate.endsWith("}") && !candidate.endsWith("]")) continue;
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return null;
}

function normalizeSources(raw: any): Source[] {
  const out: Source[] = [];
  const arr: any[] = Array.isArray(raw?.sources) ? raw.sources : [];
  for (const m of TARGET_MEDIA) {
    const match = arr.find((s: any) => {
      const name = String(s?.media || "").toLowerCase();
      return (
        name === m.id ||
        name === m.name.toLowerCase() ||
        name.includes(m.id) ||
        name.includes(m.name.toLowerCase()) ||
        (typeof s?.domain === "string" && s.domain.includes(m.domain))
      );
    });
    const listings: Listing[] = [];
    const rawListings: any[] = Array.isArray(match?.listings) ? match.listings : [];
    for (const l of rawListings) {
      if (!l || typeof l !== "object") continue;
      const title = typeof l.title === "string" ? l.title : "";
      const url = typeof l.url === "string" ? l.url : "";
      const rawText = typeof l.rawText === "string" ? l.rawText : "";
      if (!title && !url && !rawText) continue;
      listings.push({
        title: title.slice(0, 500),
        url: url.slice(0, 2000),
        rawText: rawText.slice(0, 12000),
      });
    }
    const searchUrl =
      typeof match?.searchUrl === "string" && /^https?:\/\//.test(match.searchUrl)
        ? match.searchUrl
        : "";
    const note = typeof match?.note === "string" ? match.note.slice(0, 500) : undefined;
    out.push({
      id: m.id,
      media: m.name,
      domain: m.domain,
      searchUrl,
      listings,
      note,
    });
  }
  return out;
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "リクエストボディが不正なJSONです" },
      { status: 400 }
    );
  }
  const companyName: string =
    typeof body?.companyName === "string" ? body.companyName.trim().slice(0, 200) : "";
  if (!companyName) {
    return NextResponse.json(
      { error: "会社名を入力してください" },
      { status: 400 }
    );
  }

  try {
    const openai = getOpenAI();

    const mediaLines = TARGET_MEDIA.map(
      (m, i) => `${i + 1}) ${m.name} — site:${m.domain}`
    ).join("\n");

    const prompt = [
      `あなたは日本の求人媒体を横断調査するリサーチアシスタントです。会社名「${companyName}」について、下記の日本の主要求人媒体それぞれで web_search ツールを使い、同社の求人を検索してください。検索結果から実際の求人詳細ページにアクセスし、ページに書かれている本文テキストを rawText にそのまま転記してください。`,
      "",
      "【厳守ルール】",
      "- ページに書かれていない情報を創作しない（ハルシネーション絶対禁止）。",
      "- rawText は要約・言い換え・整形をせず、原文の文章をそのまま書き写す。改行もそのまま保持する。",
      "- rawText は「職種名 / 仕事内容 / 応募条件 / 給与 / 勤務地 / 勤務時間 / 休日・休暇 / 福利厚生 / 選考プロセス」など、ページにある求人情報をできる限り広く含める。最低でも 500 文字以上、可能なら 1500〜5000 文字程度を目安に長めに転記する。抜粋ではなく、求人ページの主要本文をまるごと取る意識で。",
      "- 各媒体 最大 2 件まで。見つからない／アクセスできない場合は listings を空配列にし、note に理由（例: 『掲載なし』『会社ページは存在するが掲載求人なし』『アクセス不可』『同名別企業のためスキップ』）を日本語で記載。",
      "- listings[].url には実際の求人詳細ページの https:// から始まる URL を入れる。検索結果ページの URL ではなく、個別求人ページの URL にすること。リダイレクタ URL（例: jp.indeed.com/rc/clk）は避け、なるべく最終到達 URL を入れる。",
      "- searchUrl には、その媒体でその会社を検索した結果ページもしくは企業ページの実 URL (https://〜) を入れる。",
      "- 会社名が曖昧な場合は、最も有力と思われる企業（グループ持株会社／メインの事業会社）を採用し、note にその旨記載する。",
      "- rawText は 1 件あたり最大 6000 文字まで。それ以上は末尾を切る。",
      "",
      "【対象媒体】",
      mediaLines,
      "",
      "【出力フォーマット】",
      "純粋な JSON のみ出力すること。コードフェンス禁止。前後の説明文禁止。",
      "",
      `{
  "sources": [
    {
      "media": "Indeed",
      "domain": "jp.indeed.com",
      "searchUrl": "https://...",
      "listings": [
        {"title": "...", "url": "https://...", "rawText": "..."}
      ],
      "note": ""
    }
  ]
}`,
    ].join("\n");

    const r = await openai.responses.create({
      model: "gpt-4o",
      tools: [{ type: "web_search", search_context_size: "high" } as any],
      input: prompt,
    });

    const text = r.output_text || "";
    const parsed = extractJson(text);
    if (!parsed) {
      return NextResponse.json(
        {
          error:
            "検索結果のJSONパースに失敗しました。時間をおいて再試行してください。",
          debug: text.slice(0, 2000),
        },
        { status: 502 }
      );
    }
    const sources = normalizeSources(parsed);

    return NextResponse.json({
      companyName,
      generatedAt: new Date().toISOString(),
      sources,
    });
  } catch (err: any) {
    console.error("search error:", err);
    return NextResponse.json(
      { error: err?.message || "求人検索に失敗しました" },
      { status: 500 }
    );
  }
}
