import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import * as cheerio from "cheerio";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function fetchUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; JobListingBot/1.0)" },
      signal: AbortSignal.timeout(10000),
    });
    const html = await res.text();
    const $ = cheerio.load(html);
    $("script, style, nav, footer, header, iframe, noscript").remove();
    return $("body").text().replace(/\s+/g, " ").trim().slice(0, 8000);
  } catch {
    return "";
  }
}

async function searchWeb(query: string): Promise<string> {
  // Use Google Custom Search or SerpAPI if available, fallback to direct scraping hints
  const serpApiKey = process.env.SERPAPI_KEY;
  if (serpApiKey) {
    try {
      const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query + " 求人")}&hl=ja&gl=jp&api_key=${serpApiKey}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const data = await res.json();
      const results = (data.organic_results || []).slice(0, 5);
      return results.map((r: any) => `${r.title}\n${r.snippet}\n${r.link}`).join("\n\n");
    } catch {
      return "";
    }
  }
  return "";
}

function isUrl(s: string): boolean {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  try {
    const { query } = await req.json();
    if (!query) return NextResponse.json({ error: "入力が必要です" }, { status: 400 });

    let context = "";

    if (isUrl(query)) {
      context = await fetchUrl(query);
      if (!context) {
        return NextResponse.json({ error: "URLからの情報取得に失敗しました" }, { status: 400 });
      }
    } else {
      // Search for job info
      const searchResults = await searchWeb(query);
      
      // Also try common job sites
      const sites = [
        `https://www.google.com/search?q=${encodeURIComponent(query + " 求人 募集要項")}`,
      ];
      
      context = searchResults || `会社名: ${query}\n（検索APIが設定されていないため、AIの知識ベースから生成します）`;
    }

    const systemPrompt = `あなたは求人票作成の専門家です。与えられた情報から、以下のJSON形式で求人票データを生成してください。
情報が不足している場合は、一般的な内容で補完してください。必ず日本語で出力してください。

出力JSON形式:
{
  "companyName": "会社名/クリニック名",
  "jobTitle": "職種名",
  "summary": "募集概要（1-2文）",
  "overview": {
    "職種": "...",
    "給与": "...",
    "勤務地": "住所 + 最寄り駅"
  },
  "jobContent": {
    "仕事内容": "主な業務内容の説明",
    "どんなクリニック？": "アピールポイント、特徴、雰囲気など"
  },
  "requirements": {
    "雇用形態": "...",
    "勤務時間": "...",
    "応募資格": "...",
    "選考プロセス": "..."
  },
  "environment": {
    "給与・待遇": "基本給、残業代、交通費、昇給、賞与などの詳細",
    "休日・休暇": "年間休日数、有給休暇、特別休暇など",
    "福利厚生": "社会保険、制服貸与、社員割引、研修制度など"
  }
}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `以下の情報から求人票を作成してください:\n\n${context}`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error("AI応答が空です");

    const jobData = JSON.parse(content);
    return NextResponse.json(jobData);
  } catch (err: any) {
    console.error("Generate error:", err);
    return NextResponse.json(
      { error: err.message || "求人票の生成に失敗しました" },
      { status: 500 }
    );
  }
}
