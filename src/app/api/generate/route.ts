import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import * as cheerio from "cheerio";

export const runtime = "nodejs";
export const maxDuration = 60;

function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY が設定されていません");
  return new OpenAI({ apiKey });
}

function isSafePublicUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "0.0.0.0" ||
      host === "::1" ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^fc00:/i.test(host) ||
      /^fe80:/i.test(host)
    ) return false;
    return true;
  } catch { return false; }
}

async function fetchUrl(url: string): Promise<string> {
  if (!isSafePublicUrl(url)) return "";
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; JobListingBot/1.0)" },
      signal: AbortSignal.timeout(10000),
      redirect: "follow",
    });
    const ct = res.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml|text\/plain/i.test(ct)) return "";
    const html = (await res.text()).slice(0, 500_000);
    const $ = cheerio.load(html);
    $("script, style, nav, footer, header, iframe, noscript").remove();
    return $("body").text().replace(/\s+/g, " ").trim().slice(0, 8000);
  } catch {
    return "";
  }
}

async function searchWeb(query: string): Promise<{ text: string; urls: string[] }> {
  const serpApiKey = process.env.SERPAPI_KEY;
  if (!serpApiKey) return { text: "", urls: [] };
  try {
    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query + " 求人")}&hl=ja&gl=jp&api_key=${serpApiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    const results = (data.organic_results || []).slice(0, 5);
    const text = results.map((r: any) => `${r.title}\n${r.snippet}\n${r.link}`).join("\n\n");
    const urls = results.map((r: any) => r.link).filter(Boolean);
    return { text, urls };
  } catch {
    return { text: "", urls: [] };
  }
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストボディが不正なJSONです" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "リクエストボディが不正です" }, { status: 400 });
  }
  const cap = (v: any, n = 500) => (typeof v === "string" ? v.slice(0, n) : "");
  try {
    const openai = getOpenAI();
    const companyName: string = cap(body.companyName).trim();
    const companyUrl: string = cap(body.companyUrl, 2000).trim();
    const jobTitle: string = cap(body.jobTitle).trim();
    const salary: string = cap(body.salary).trim();

    // All fields are optional. If nothing is provided, generate a generic template.
    let context = "";
    const sources: string[] = [];

    if (companyUrl) {
      const scraped = await fetchUrl(companyUrl);
      if (scraped) {
        context = scraped;
        sources.push(companyUrl);
      }
    }

    if (!context && (companyName || jobTitle)) {
      const query = [companyName, jobTitle].filter(Boolean).join(" ");
      const { text, urls } = await searchWeb(query);
      if (text) {
        context = text;
        sources.push(...urls);
      }
    }

    if (!context) {
      context = "（外部ソース情報なし。入力情報と一般的な求人票テンプレートから生成してください。）";
    }

    const systemPrompt = `あなたは求人票作成の専門家です。与えられた外部情報を元に、以下のJSON形式で求人票データを生成してください。
情報が不足している部分は一般的な内容で補完してかまいません。会社名・職種が指定されていればそれを使い、未指定なら外部ソースから推定するか汎用的な内容にしてください。必ず日本語で出力してください。

出力JSON形式:
{
  "companyName": "会社名",
  "jobTitle": "職種名",
  "summary": "募集概要（1-2文）",
  "overview": {
    "職種": "...",
    "給与": "...",
    "勤務地": "住所 + 最寄り駅"
  },
  "jobContent": {
    "仕事内容": "主な業務内容の説明",
    "どんな会社？": "アピールポイント、特徴、雰囲気など"
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

    const userPrompt = `会社名: ${companyName || "（未指定）"}
職種: ${jobTitle || "（未指定）"}
${salary ? `給与（そのまま overview.給与 に設定）: ${salary}` : ""}

外部ソースから収集した情報:
${context}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error("AI応答が空です");

    const jobData = JSON.parse(content);
    // Enforce user-specified fields if provided
    if (companyName) jobData.companyName = companyName;
    if (jobTitle) jobData.jobTitle = jobTitle;
    jobData.companyName = jobData.companyName || "";
    jobData.jobTitle = jobData.jobTitle || "";
    if (salary) {
      jobData.overview = jobData.overview || {};
      jobData.overview["給与"] = salary;
    }
    jobData.sources = sources;
    return NextResponse.json(jobData);
  } catch (err: any) {
    console.error("Generate error:", err);
    return NextResponse.json(
      { error: err.message || "求人票の生成に失敗しました" },
      { status: 500 }
    );
  }
}
