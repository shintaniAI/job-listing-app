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
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

const MAX_CONTEXT_CHARS = 24000;

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
    const html = (await res.text()).slice(0, 1_500_000);
    const $ = cheerio.load(html);
    $("script, style, nav, footer, header, iframe, noscript, svg, form, button, aside").remove();

    // Prefer main / article / role=main if available; fall back to body.
    const candidates = ["main", "article", "[role=main]", "#main", "#content", ".content", ".main"];
    let primary = "";
    for (const sel of candidates) {
      const t = $(sel).first().text();
      if (t && t.length > primary.length) primary = t;
    }
    const bodyText = $("body").text();
    // Use whichever is longer / richer
    let text = primary && primary.length > 800 ? primary : bodyText;

    // Extract definition lists / tables structure hints (label: value pairs commonly used in job pages)
    const pairs: string[] = [];
    $("dl").each((_, dl) => {
      $(dl)
        .find("dt")
        .each((__, dt) => {
          const k = $(dt).text().trim().replace(/\s+/g, " ");
          const v = $(dt).next("dd").text().trim().replace(/\s+/g, " ");
          if (k && v) pairs.push(`${k}: ${v}`);
        });
    });
    $("table").each((_, tbl) => {
      $(tbl)
        .find("tr")
        .each((__, tr) => {
          const cells = $(tr).find("th,td");
          if (cells.length === 2) {
            const k = $(cells[0]).text().trim().replace(/\s+/g, " ");
            const v = $(cells[1]).text().trim().replace(/\s+/g, " ");
            if (k && v) pairs.push(`${k}: ${v}`);
          }
        });
    });

    text = text.replace(/[\t\r ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    const structured = pairs.length ? `\n\n[構造化された項目候補]\n${pairs.join("\n")}` : "";
    const combined = (text + structured).slice(0, MAX_CONTEXT_CHARS);
    return combined;
  } catch {
    return "";
  }
}

async function searchWeb(
  query: string
): Promise<{ text: string; urls: string[] }> {
  const serpApiKey = process.env.SERPAPI_KEY;
  if (!serpApiKey) return { text: "", urls: [] };
  try {
    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(
      query + " 求人"
    )}&hl=ja&gl=jp&api_key=${serpApiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    const results = (data.organic_results || []).slice(0, 5);
    const text = results
      .map((r: any) => `${r.title}\n${r.snippet}\n${r.link}`)
      .join("\n\n");
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
    return NextResponse.json(
      { error: "リクエストボディが不正なJSONです" },
      { status: 400 }
    );
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "リクエストボディが不正です" },
      { status: 400 }
    );
  }
  const cap = (v: any, n = 500) => (typeof v === "string" ? v.slice(0, n) : "");
  try {
    const openai = getOpenAI();
    const companyName: string = cap(body.companyName).trim();
    const companyUrl: string = cap(body.companyUrl, 2000).trim();
    const jobTitle: string = cap(body.jobTitle).trim();
    const salary: string = cap(body.salary).trim();

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
      context = "外部ソース情報なし";
    }

    const systemPrompt = `あなたは求人票作成の専門家です。与えられた外部情報から、求人に関わる情報を**漏らさず全て**抽出し、以下のJSON形式で日本語の求人票データを生成してください。

【最重要 / 抽出方針】
- 外部ソースに記載のある求人関連情報は、たとえ細かい数字・福利厚生の一項目・選考フローの一行であっても**全て**拾うこと。情報を捨てない。
- 標準カテゴリ（overview / jobContent / requirements / environment）に当てはまらない情報があれば、必ず "extra" セクションに「項目名: 値」形式で記録すること。例: 「設立年」「資本金」「従業員数」「事業内容」「平均年齢」「育休取得率」「研修内容」「使用言語」「服装規定」「試用期間」など何でも。
- セクション内のキーは固定ではなく、ソースに合わせて自由に追加してよい（"残業時間" "通勤手当" "託児所" "退職金" 等）。
- ただし**ソースに明示されていない情報を創作してはならない**（ハルシネーション禁止）。不明な項目は値に "情報なし" と入れる、もしくはキー自体を出さない。
- 「〜程度」「〜くらい」「応相談」のようなぼかしで埋めない。ソースの記載をそのまま簡潔に転写する。
- 外部ソースが "外部ソース情報なし" の場合、companyName / jobTitle / summary 以外はすべて "情報なし" にする。

【出力JSON形式】（各セクションのキーは追加・省略・改名OK）
{
  "companyName": "会社名",
  "jobTitle": "職種名",
  "summary": "募集概要（1-2文）",
  "overview":     { "職種": "...", "給与": "...", "勤務地": "..." },
  "jobContent":   { "仕事内容": "...", "どんな会社？": "..." },
  "requirements": { "雇用形態": "...", "勤務時間": "...", "応募資格": "...", "選考プロセス": "..." },
  "environment":  { "給与・待遇": "...", "休日・休暇": "...", "福利厚生": "..." },
  "extra":        { "設立年": "...", "資本金": "...", "事業内容": "...", "その他ソースに書かれていた項目": "..." }
}

必ず日本語で出力し、JSON以外の説明文は一切含めないこと。`;

    const userPrompt = `会社名: ${companyName || "（未指定）"}
職種: ${jobTitle || "（未指定）"}
${salary ? `給与（そのまま overview.給与 に設定）: ${salary}` : ""}

外部ソースから収集した情報（最大${MAX_CONTEXT_CHARS}文字）:
${context}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error("AI応答が空です");

    const jobData = JSON.parse(content);
    if (companyName) jobData.companyName = companyName;
    if (jobTitle) jobData.jobTitle = jobTitle;
    jobData.companyName = jobData.companyName || "";
    jobData.jobTitle = jobData.jobTitle || "";
    if (salary) {
      jobData.overview = jobData.overview || {};
      jobData.overview["給与"] = salary;
    }
    // Normalize: ensure all sections exist as objects
    for (const sec of ["overview", "jobContent", "requirements", "environment", "extra"]) {
      if (!jobData[sec] || typeof jobData[sec] !== "object" || Array.isArray(jobData[sec])) {
        jobData[sec] = {};
      }
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
