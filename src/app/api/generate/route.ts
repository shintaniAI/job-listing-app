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

const MAX_CONTEXT_CHARS = 32000;

// 優先採用サイトの判定
function isPriorityRecruitmentSite(url: string): { priority: number, type: string } {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    
    // 最優先：公式採用プラットフォーム
    if (hostname.includes('talentio.com')) return { priority: 100, type: 'Talentio' };
    if (hostname.includes('wantedly.com')) return { priority: 95, type: 'Wantedly' };
    if (hostname.includes('hrmos.co')) return { priority: 90, type: 'HRMOS' };
    if (hostname.includes('recruit-app.jp')) return { priority: 85, type: 'リクルートアプリ' };
    
    // 高優先：企業公式サイト（採用・キャリア関連）
    if (url.includes('/recruit') || url.includes('/career') || url.includes('/jobs') || url.includes('/採用')) {
      return { priority: 80, type: '企業公式採用ページ' };
    }
    
    // 中優先：企業公式サイト（一般）
    if (!hostname.includes('indeed') && !hostname.includes('doda') && !hostname.includes('rikunabi') && 
        !hostname.includes('mynavi') && !hostname.includes('en-japan') && !hostname.includes('bizreach')) {
      return { priority: 60, type: '企業サイト' };
    }
    
    // 低優先：求人媒体（補完用）
    if (hostname.includes('indeed')) return { priority: 20, type: 'Indeed' };
    if (hostname.includes('doda')) return { priority: 20, type: 'doda' };
    if (hostname.includes('rikunabi')) return { priority: 15, type: 'リクナビ' };
    if (hostname.includes('mynavi')) return { priority: 15, type: 'マイナビ' };
    if (hostname.includes('en-japan')) return { priority: 10, type: 'エン転職' };
    
    return { priority: 5, type: 'その他' };
  } catch {
    return { priority: 0, type: 'Invalid URL' };
  }
}

async function fetchUrl(url: string): Promise<string> {
  if (!isSafePublicUrl(url)) return "";
  try {
    const res = await fetch(url, {
      headers: { 
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "ja,en-US;q=0.9,en;q=0.8"
      },
      signal: AbortSignal.timeout(15000),
      redirect: "follow",
    });
    const ct = res.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml|text\/plain/i.test(ct)) return "";
    const html = (await res.text()).slice(0, 2_000_000);
    const $ = cheerio.load(html);
    
    // 不要要素を削除
    $("script, style, nav, footer, header, iframe, noscript, svg, form, button, aside, .ad, .advertisement, .sidebar").remove();

    // 優先的にコンテンツを抽出
    const candidates = [
      "main", "article", "[role=main]", "#main", "#content", ".content", ".main",
      ".job-content", ".job-detail", ".recruit-content", ".career-content",
      ".company-info", ".about-company", ".job-description"
    ];
    
    let primary = "";
    for (const sel of candidates) {
      const t = $(sel).first().text();
      if (t && t.length > primary.length) primary = t;
    }
    
    const bodyText = $("body").text();
    let text = primary && primary.length > 800 ? primary : bodyText;

    // 構造化データの抽出（求人情報に特化）
    const structuredData: string[] = [];
    
    // 定義リスト
    $("dl").each((_, dl) => {
      $(dl).find("dt").each((__, dt) => {
        const k = $(dt).text().trim().replace(/\s+/g, " ");
        const v = $(dt).next("dd").text().trim().replace(/\s+/g, " ");
        if (k && v && v.length < 500) structuredData.push(`${k}: ${v}`);
      });
    });
    
    // テーブル（2列のみ：ラベル-値ペア）
    $("table").each((_, tbl) => {
      $(tbl).find("tr").each((__, tr) => {
        const cells = $(tr).find("th,td");
        if (cells.length === 2) {
          const k = $(cells[0]).text().trim().replace(/\s+/g, " ");
          const v = $(cells[1]).text().trim().replace(/\s+/g, " ");
          if (k && v && v.length < 500) structuredData.push(`${k}: ${v}`);
        }
      });
    });

    // リスト項目（求人要項など）
    $("li").each((_, li) => {
      const liText = $(li).text().trim();
      if (liText.length > 10 && liText.length < 300 && liText.includes("：") || liText.includes(":")) {
        structuredData.push(liText);
      }
    });

    // テキストのクリーンアップ
    text = text.replace(/[\t\r ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    
    const structured = structuredData.length ? 
      `\n\n[構造化された求人情報]\n${structuredData.slice(0, 50).join("\n")}` : "";
    
    const combined = (text + structured).slice(0, MAX_CONTEXT_CHARS);
    return combined;
  } catch (error) {
    console.error(`Failed to fetch ${url}:`, error);
    return "";
  }
}

async function searchCompanyRecruitment(companyName: string): Promise<{ urls: { url: string, priority: number, type: string }[], searchResults: string }> {
  const serpApiKey = process.env.SERPAPI_KEY;
  if (!serpApiKey) return { urls: [], searchResults: "" };

  const searches = [
    `${companyName} 採用`,
    `${companyName} 求人 公式`,
    `${companyName} careers`,
    `${companyName} recruit site:talentio.com OR site:wantedly.com OR site:hrmos.co`,
  ];

  let allUrls: { url: string, priority: number, type: string }[] = [];
  let searchResults = "";

  try {
    for (const query of searches) {
      const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&hl=ja&gl=jp&num=10&api_key=${serpApiKey}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const data = await res.json();
      const results = (data.organic_results || []).slice(0, 10);
      
      searchResults += `\n[検索クエリ: ${query}]\n`;
      searchResults += results.map((r: any) => `${r.title}\n${r.snippet}\n${r.link}`).join("\n\n");
      
      for (const result of results) {
        if (result.link) {
          const priorityInfo = isPriorityRecruitmentSite(result.link);
          allUrls.push({
            url: result.link,
            priority: priorityInfo.priority,
            type: priorityInfo.type
          });
        }
      }
    }

    // 重複を除去し、優先度順にソート
    const uniqueUrls = Array.from(new Map(allUrls.map(item => [item.url, item])).values())
      .sort((a, b) => b.priority - a.priority);

    return { urls: uniqueUrls.slice(0, 8), searchResults };
  } catch (error) {
    console.error("Search error:", error);
    return { urls: [], searchResults: "" };
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

    let context = "";
    let sources: string[] = [];
    let searchResults = "";

    // 1. 会社URLが直接提供されている場合
    if (companyUrl) {
      console.log(`直接URL指定: ${companyUrl}`);
      const scraped = await fetchUrl(companyUrl);
      if (scraped) {
        context = scraped;
        sources.push(companyUrl);
      }
    }

    // 2. 会社名から公式採用ページを検索
    if (companyName) {
      console.log(`企業採用ページ検索開始: ${companyName}`);
      const { urls, searchResults: sr } = await searchCompanyRecruitment(companyName);
      searchResults = sr;

      // 優先度の高いサイトから順番にスクレイピング
      for (const urlInfo of urls.slice(0, 3)) { // 上位3サイトのみ
        console.log(`スクレイピング: ${urlInfo.url} (${urlInfo.type}, 優先度: ${urlInfo.priority})`);
        const scraped = await fetchUrl(urlInfo.url);
        if (scraped && scraped.length > 500) {
          context += `\n\n[${urlInfo.type}: ${urlInfo.url}]\n${scraped}`;
          sources.push(`${urlInfo.type}: ${urlInfo.url}`);
        }
      }
    }

    // 3. 情報が不足している場合は追加検索
    if (!context || context.length < 1000) {
      console.log("情報不足のため追加検索を実行");
      if (!searchResults) {
        context = "情報収集に失敗しました。外部ソースから十分な情報を取得できませんでした。";
        sources.push("検索結果なし");
      } else {
        context = `検索結果情報:\n${searchResults}`;
        sources.push("Web検索結果");
      }
    }

    // GPT-4で求人票生成（新しいプロンプト）
    const systemPrompt = `あなたは求人票作成の専門家です。企業の公式採用ページから収集した情報を基に、詳細で充実した求人票を作成してください。

【重要な改修要件】
- 出力は必ず8つのセクションに分ける（基本情報、企業情報、仕事内容、応募資格、給与・報酬、勤務条件、休日・休暇、福利厚生・待遇）
- 各セクションには最低3項目以上の具体的な情報を含める
- 「詳細は面接時」「要相談」のみの曖昧な記載は避け、具体的な数値・条件を記載する
- 企業の採用ページ、MVV、事業内容などの情報を優先的に活用する
- 求人媒体の情報は補完的に使用する

【出力JSON形式】
{
  "companyName": "企業名",
  "jobTitle": "募集職種",
  "summary": "求人の概要（2-3文）",
  "basicInfo": {
    "企業名": "",
    "募集職種": "",
    "雇用形態": "",
    "募集人数": "",
    "勤務開始日": ""
  },
  "companyInfo": {
    "事業内容": "",
    "企業理念・ミッション": "",
    "企業の特徴・強み": "",
    "設立": "",
    "従業員数": "",
    "資本金": "",
    "本社所在地": ""
  },
  "jobContent": {
    "主な業務内容1": "",
    "主な業務内容2": "",
    "主な業務内容3": "",
    "主な業務内容4": "",
    "主な業務内容5": "",
    "業務の流れ": "",
    "配属部署": "",
    "キャリアパス・昇進": "",
    "将来性・成長機会": ""
  },
  "requirements": {
    "必須要件1": "",
    "必須要件2": "",
    "必須要件3": "",
    "歓迎要件1": "",
    "歓迎要件2": "",
    "歓迎要件3": "",
    "求める人物像": "",
    "年齢": "",
    "学歴": ""
  },
  "salary": {
    "基本給": "",
    "想定年収": "",
    "給与内訳": "",
    "昇給": "",
    "賞与": "",
    "年収モデル例": "",
    "諸手当": "",
    "給与備考": ""
  },
  "workConditions": {
    "勤務地": "",
    "勤務先住所": "",
    "最寄駅・アクセス": "",
    "勤務時間": "",
    "リモートワーク可否": "",
    "残業時間": "",
    "試用期間": "",
    "転勤可能性": "",
    "服装・ドレスコード": ""
  },
  "holidays": {
    "年間休日数": "",
    "休日パターン": "",
    "有給休暇": "",
    "特別休暇": "",
    "長期休暇": "",
    "休暇制度の特徴": ""
  },
  "benefits": {
    "社会保険": "",
    "退職金制度": "",
    "健康関連": "",
    "住宅関連": "",
    "育児・介護支援": "",
    "スキルアップ支援": "",
    "福利厚生施設": "",
    "その他福利厚生": ""
  }
}

【品質基準】
- 外部ソースに記載されている情報は漏れなく活用する
- 情報がない項目は「詳細お問い合わせください」ではなく「情報なし」とする
- 具体的な数値がある場合は必ず記載する（年収400万～840万円、年間休日120日など）
- MVV（ミッション・ビジョン・バリュー）は企業情報セクションに含める
- 業務内容は5項目以上の具体的な内容を記載する

外部ソースに情報がない場合、その項目は「情報なし」として埋める。創作や推測は行わない。`;

    const userPrompt = `以下の情報から求人票を生成してください：

会社名: ${companyName || "（未指定）"}
職種: ${jobTitle || "（未指定）"}
給与: ${salary || "（未指定）"}

収集した企業・求人情報:
${context}

注意: 上記の外部ソースの情報を最大限活用し、8セクション構成で詳細な求人票を生成してください。`;

    console.log("GPT-4で求人票生成開始");
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 4000,
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error("AI応答が空です");

    const jobData = JSON.parse(content);
    
    // 入力値での上書き
    if (companyName) jobData.companyName = companyName;
    if (jobTitle) jobData.jobTitle = jobTitle;
    jobData.companyName = jobData.companyName || "";
    jobData.jobTitle = jobData.jobTitle || "";
    
    if (salary) {
      jobData.salary = jobData.salary || {};
      jobData.salary["基本給"] = salary;
    }

    // セクションの正規化
    const requiredSections = ["basicInfo", "companyInfo", "jobContent", "requirements", "salary", "workConditions", "holidays", "benefits"];
    for (const section of requiredSections) {
      if (!jobData[section] || typeof jobData[section] !== "object" || Array.isArray(jobData[section])) {
        jobData[section] = {};
      }
    }

    jobData.sources = sources;
    
    console.log("求人票生成完了");
    return NextResponse.json(jobData);
    
  } catch (err: any) {
    console.error("Generate error:", err);
    return NextResponse.json(
      { error: err.message || "求人票の生成に失敗しました" },
      { status: 500 }
    );
  }
}