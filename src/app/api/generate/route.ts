import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

export const runtime = "nodejs";
export const maxDuration = 60;

// 求人媒体（参照禁止リスト）
const BLOCKED_SITES = [
  "jp.indeed.com",
  "doda.jp",
  "next.rikunabi.com",
  "tenshoku.mynavi.jp",
  "employment.en-japan.com",
  "bizreach.jp",
  "type.jp",
  "townwork.net",
];

function getGenAI() {
  const apiKey =
    process.env.GEMINI_202_KYUJIN ||
    process.env.gemini_202_kyujin ||
    process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_202_KYUJIN が設定されていません");
  return new GoogleGenAI({ apiKey });
}

// Gemini呼び出し全体にタイムアウトを被せる (ハング時はエラーで返す)
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}タイムアウト(${ms}ms)`)), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }).catch((e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

// ---------- Jina Reader: URLからMarkdown全文取得 ----------
async function fetchJinaReader(url: string, timeoutMs = 20000): Promise<string> {
  const target = `https://r.jina.ai/${url}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(target, {
      method: "GET",
      headers: {
        Accept: "text/plain",
        "X-Return-Format": "markdown",
      },
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`Jina Reader取得失敗: ${res.status} ${res.statusText}`);
    }
    const text = await res.text();
    return text;
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`Jina Readerタイムアウト(${timeoutMs}ms): ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function isBlockedUrl(url: string): boolean {
  return BLOCKED_SITES.some((b) => url.includes(b));
}

// フォールバック: Groundingを使わず知識ベースでURL推測（高速）
async function guessUrlsWithoutGrounding(
  ai: GoogleGenAI,
  companyName: string
): Promise<{ urls: string[]; usage: any }> {
  const prompt = [
    `あなたの知識から「${companyName}」の公式採用ページURLを推測してください。`,
    "",
    "【候補パターン】",
    `- https://{domain}/careers/`,
    `- https://{domain}/recruit/`,
    `- https://open.talentio.com/r/1/c/{slug}/`,
    `- https://hrmos.co/pages/{slug}/jobs`,
    `- https://www.wantedly.com/companies/{slug}`,
    "",
    "【絶対禁止】以下の求人媒体は無視してください:",
    BLOCKED_SITES.map((s) => `  - ${s}`).join("\n"),
    "",
    "URLのみ1行ずつ、最大5件出力。説明文不要。知らない場合は空でOK。",
  ].join("\n");

  const result = await withTimeout(
    ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: { temperature: 0, maxOutputTokens: 500 },
    }),
    7000,
    "Gemini(URLフォールバック推測)"
  );
  const text = result.text || "";
  const urls = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\//.test(l))
    .filter((l) => !isBlockedUrl(l));
  return { urls: urls.slice(0, 5), usage: (result as any).usageMetadata || {} };
}

// ---------- Gemini + Google Search で公式採用URLを探す ----------
async function findOfficialUrlWithGemini(
  ai: GoogleGenAI,
  companyName: string,
  jobTitle: string
): Promise<{ urls: string[]; usage: any }> {
  const prompt = [
    `「${companyName}」の公式採用ページURLを見つけてください。`,
    jobTitle ? `職種: ${jobTitle}` : "",
    "",
    "【検索優先順位】",
    `1. site:open.talentio.com "${companyName}"`,
    `2. site:talentio.com "${companyName}"`,
    `3. site:wantedly.com "${companyName}"`,
    `4. site:hrmos.co "${companyName}"`,
    `5. "${companyName}" 採用サイト`,
    "",
    "【絶対禁止】以下の求人媒体は無視してください:",
    BLOCKED_SITES.map((s) => `  - ${s}`).join("\n"),
    "",
    "見つけたURLを **URLだけ1行ずつ**、複数候補 (最大5件) を出力してください。説明文・番号・マークダウンは不要。",
  ]
    .filter(Boolean)
    .join("\n");

  // Grounded検索 (最大18秒、タイムアウト時はフォールバックへ)
  let result: any;
  try {
    result = await withTimeout(
      ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
          temperature: 0,
        },
      }),
      18000,
      "Gemini(URL検索)"
    );
  } catch (e: any) {
    console.log(`[search] grounding失敗 (${e.message}), フォールバックへ`);
    const fb = await guessUrlsWithoutGrounding(ai, companyName).catch(() => ({
      urls: [] as string[],
      usage: {},
    }));
    return fb;
  }

  const text = result.text || "";
  const urls = text
    .split(/\r?\n/)
    .map((l: string) => l.trim())
    .filter((l: string) => /^https?:\/\//.test(l))
    .filter((l: string) => !isBlockedUrl(l));

  // grounding metadata からも取る
  const grounded: string[] = [];
  try {
    const candidates: any[] = (result as any).candidates || [];
    for (const c of candidates) {
      const chunks = c?.groundingMetadata?.groundingChunks || [];
      for (const ch of chunks) {
        const u = ch?.web?.uri;
        if (u && /^https?:\/\//.test(u) && !isBlockedUrl(u)) grounded.push(u);
      }
    }
  } catch {}

  const merged = Array.from(new Set([...urls, ...grounded]));
  const usage = (result as any).usageMetadata || {};
  return { urls: merged.slice(0, 5), usage };
}

// ---------- 収集情報を8セクションJSONに整形 ----------
// 複数ポジション検出: ページテキストから複数の職種が募集されているか判定する
async function detectPositionsWithGemini(
  ai: GoogleGenAI,
  sourceText: string
): Promise<string[]> {
  const prompt = [
    "以下の採用ページテキストから、募集されている職種名を全て抽出してください。",
    "",
    "【ルール】",
    "- 同一ポジションの別名表記は統合（例: 「営業」と「ソリューション営業」が同一なら1つ）",
    "- 職種名は原文にあるものをそのまま使う",
    "- 該当が1つしか無い場合は1つだけ返す",
    "- 最大10件",
    "",
    "【出力形式（JSONのみ）】",
    '{"positions": ["職種1", "職種2", ...]}',
    "",
    "【採用ページ全文】",
    sourceText.slice(0, 15000),
  ].join("\n");

  const result = await withTimeout(
    ai.models.generateContent({
      // 検出は軽いタスクなので最速モデル
      model: "gemini-2.5-flash-lite",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        temperature: 0,
        maxOutputTokens: 800,
        thinkingConfig: { thinkingBudget: 0 },
      } as any,
    }),
    8000,
    "Gemini(ポジション検出)"
  );

  try {
    const parsed = JSON.parse(result.text || "{}");
    const arr = Array.isArray(parsed.positions) ? parsed.positions : [];
    return arr.filter((s: any) => typeof s === "string" && s.trim().length > 0).slice(0, 10);
  } catch {
    return [];
  }
}

// 共通ルール（両パート共通）
const COMMON_RULES = `【絶対ルール】
- 原文に書かれている情報は**一切省略せず全て**JSONに反映する
- 箇条書き項目は全て転記する（「など」で端折らない）
- 数値・固有名詞・制度名は原文通りに転記する
- 情報がない項目は値を "情報なし" にする
- 雛形にないキーは自由に追加してよい
- 値は必ず「文字列」で返す（配列・ネストオブジェクト禁止）
- 複数項目がある場合は個別キー（"主な業務内容1","主な業務内容2"...）に分ける
- 推測・創作・要約禁止。原文にないことは書かない`;

// パートA: 企業全体情報 (basicInfo / companyInfo / holidays / benefits / summary)
const PROMPT_COMPANY_PART = `あなたは求人票作成の専門家です。与えられた採用ページ全文から、**企業全体に関する情報**のみをJSONで出力してください。

${COMMON_RULES}

【出力セクション & 最低項目数（talentio水準）】
- summary: 2〜3文の求人概要
- basicInfo: 5項目以上 (企業名/募集職種/雇用形態/募集人数/勤務開始日等)
- companyInfo: **12項目以上** (事業内容1〜N/ミッション/ビジョン/バリュー/特徴/強み/設立/従業員数/資本金/本社/代表メッセージ/カルチャー)
- holidays: 7項目以上 (年間休日数/週休/有給/特別休暇1〜N/長期休暇/育児休暇)
- benefits: **15項目以上** (社会保険/退職金/健康/ジム/食事/在宅/通勤/住宅/育児/介護/スキル/書籍/研修/独自制度1〜N)

【出力形式（JSONのみ）】
{
  "summary": "...",
  "basicInfo": { "企業名":"", ... },
  "companyInfo": { "事業内容1":"", "ミッション":"", ... },
  "holidays": { "年間休日数":"", ... },
  "benefits": { "社会保険":"", ... }
}`;

// パートB: ポジション固有情報 (jobContent / requirements / salary / workConditions)
const PROMPT_POSITION_PART = `あなたは求人票作成の専門家です。与えられた採用ページ全文から、**ポジションの業務/応募条件**に関する情報のみをJSONで出力してください。

${COMMON_RULES}

【出力セクション & 最低項目数（talentio水準）】
- jobContent: **業務内容10〜20項目** ("主な業務内容1"〜"主な業務内容N") + 業務の流れ/チーム構成/配属/キャリアパス/将来性/技術スタック/使用ツール
- requirements: 必須5項目 + 歓迎5項目 + 求める人物像 + 年齢 + 学歴（最低10項目）
- salary: **10項目以上** (基本給/想定年収/年俸月額/固定時間外手当/固定深夜手当/昇給/賞与/諸手当1〜N/給与モデル例)
- workConditions: **10項目以上** (勤務地/住所/アクセス/勤務時間/コアタイム/リモート/頻度/残業/試用期間/転勤/服装)

【出力形式（JSONのみ）】
{
  "jobContent": { "主な業務内容1":"", ... },
  "requirements": { "必須要件1":"", ... },
  "salary": { "基本給":"", ... },
  "workConditions": { "勤務地":"", ... }
}`;

async function generateCompanyPart(
  ai: GoogleGenAI,
  companyName: string,
  sourceText: string
): Promise<{ data: any; usage: any }> {
  const prompt = [
    PROMPT_COMPANY_PART,
    "",
    `会社名(ユーザー入力): ${companyName || "（未指定）"}`,
    "",
    "【採用ページ全文テキスト】",
    sourceText,
    "",
    "上記から企業全体の情報だけをJSONで返してください。",
  ].join("\n");

  const result = await withTimeout(
    ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        temperature: 0.2,
        maxOutputTokens: 8000,
        // thinkingを無効化して高速化
        thinkingConfig: { thinkingBudget: 0 },
      } as any,
    }),
    28000,
    "Gemini(企業パート生成)"
  );

  const text = result.text || "";
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("企業パートのパース失敗");
    data = JSON.parse(m[0]);
  }
  return { data, usage: (result as any).usageMetadata || {} };
}

async function generatePositionPart(
  ai: GoogleGenAI,
  companyName: string,
  jobTitle: string,
  salary: string,
  sourceText: string,
  focusHint?: string
): Promise<{ data: any; usage: any }> {
  const prompt = [
    PROMPT_POSITION_PART,
    "",
    `会社名(ユーザー入力): ${companyName || "（未指定）"}`,
    `職種(ユーザー入力): ${jobTitle || "（未指定）"}`,
    `給与(ユーザー入力): ${salary || "（未指定）"}`,
    focusHint ? `\n【重要】「${focusHint}」というポジション専用の情報に絞ってください。` : "",
    "",
    "【採用ページ全文テキスト】",
    sourceText,
    "",
    "上記からポジション固有の情報だけをJSONで返してください。",
  ].join("\n");

  const result = await withTimeout(
    ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        temperature: 0.2,
        maxOutputTokens: 8000,
        thinkingConfig: { thinkingBudget: 0 },
      } as any,
    }),
    28000,
    "Gemini(ポジションパート生成)"
  );

  const text = result.text || "";
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("ポジションパートのパース失敗");
    data = JSON.parse(m[0]);
  }
  return { data, usage: (result as any).usageMetadata || {} };
}

// ２つのパートを並列実行して merge する（片方失敗しても片方は生きる）
async function generateJobJsonSplit(
  ai: GoogleGenAI,
  companyName: string,
  jobTitle: string,
  salary: string,
  sourceText: string,
  focusHint?: string
): Promise<{ jobData: any; usage: any }> {
  const [companyRes, positionRes] = await Promise.allSettled([
    generateCompanyPart(ai, companyName, sourceText),
    generatePositionPart(ai, companyName, jobTitle, salary, sourceText, focusHint),
  ]);

  const companyData = companyRes.status === "fulfilled" ? companyRes.value.data : {};
  const positionData = positionRes.status === "fulfilled" ? positionRes.value.data : {};

  if (companyRes.status === "rejected" && positionRes.status === "rejected") {
    throw new Error(
      `生成失敗: 企業=${(companyRes.reason as any)?.message}, ポジション=${(positionRes.reason as any)?.message}`
    );
  }

  const jobData = {
    companyName: companyName || "",
    jobTitle: jobTitle || "",
    summary: companyData.summary || "",
    basicInfo: companyData.basicInfo || {},
    companyInfo: companyData.companyInfo || {},
    jobContent: positionData.jobContent || {},
    requirements: positionData.requirements || {},
    salary: positionData.salary || {},
    workConditions: positionData.workConditions || {},
    holidays: companyData.holidays || {},
    benefits: companyData.benefits || {},
  };

  const usage = {
    promptTokenCount:
      (companyRes.status === "fulfilled" ? companyRes.value.usage.promptTokenCount || 0 : 0) +
      (positionRes.status === "fulfilled" ? positionRes.value.usage.promptTokenCount || 0 : 0),
    candidatesTokenCount:
      (companyRes.status === "fulfilled" ? companyRes.value.usage.candidatesTokenCount || 0 : 0) +
      (positionRes.status === "fulfilled" ? positionRes.value.usage.candidatesTokenCount || 0 : 0),
  };

  return { jobData, usage };
}

// ---------- メイン ----------
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
  const companyName: string = cap(body.companyName).trim();
  const companyUrl: string = cap(body.companyUrl, 2000).trim();
  const jobTitle: string = cap(body.jobTitle).trim();
  const salary: string = cap(body.salary).trim();

  const startedAt = Date.now();

  try {
    const ai = getGenAI();

    // Step 1: 対象URLを確定
    let targetUrls: string[] = [];
    let searchUsage: any = null;

    if (companyUrl && /^https?:\/\//.test(companyUrl)) {
      if (isBlockedUrl(companyUrl)) {
        return NextResponse.json(
          { error: `指定URLは求人媒体のため利用できません: ${companyUrl}` },
          { status: 400 }
        );
      }
      targetUrls = [companyUrl];
    } else if (companyName) {
      console.log(`[search] Gemini+Search で公式URL探索: ${companyName}`);
      const r = await findOfficialUrlWithGemini(ai, companyName, jobTitle);
      targetUrls = r.urls;
      searchUsage = r.usage;
      if (targetUrls.length === 0) {
        throw new Error(
          "公式採用ページのURLが見つかりませんでした。採用ページURLを直接入力してください。"
        );
      }
      console.log(`[search] 候補URL: ${targetUrls.length}件`, targetUrls);
    } else {
      return NextResponse.json(
        { error: "会社名または採用ページURLを入力してください" },
        { status: 400 }
      );
    }

    // Step 2: Jina Reader で全文Markdown取得（並列で全URL同時取得、情報量最大化）
    const fetchCandidates = targetUrls.slice(0, 4);
    console.log(`[fetch] Jina Readerで並列取得: ${fetchCandidates.length}件`);
    const fetchResults = await Promise.allSettled(
      fetchCandidates.map((url) => fetchJinaReader(url, 11000).then((text) => ({ url, text })))
    );
    const contents: { url: string; text: string }[] = [];
    for (const r of fetchResults) {
      if (r.status === "fulfilled" && r.value.text && r.value.text.length > 200) {
        contents.push(r.value);
        console.log(`  ✓ ${r.value.url} (${r.value.text.length}文字)`);
      } else if (r.status === "rejected") {
        console.log(`  ✗ ${r.reason?.message || r.reason}`);
      }
    }

    if (contents.length === 0) {
      throw new Error(
        "採用ページのテキスト取得に失敗しました。URLを直接入力するか、別のページで試してください。"
      );
    }

    // Gemini入力は55000文字まで（並列取得なので複数ソースの情報を盛り込める）
    const MAX_CHARS = 55000;
    let merged = contents.map((c) => `=== ${c.url} ===\n${c.text}`).join("\n\n");
    if (merged.length > MAX_CHARS) merged = merged.slice(0, MAX_CHARS);

    // Step 2.5 & 3: 検出 と 2分割並列生成 を全て並列実行
    // [detection, companyPart, positionPart] 3並列 → max(3コール)
    const primaryPositionCandidate = jobTitle || "";
    console.log(`[parallel] 検出 + 企業パート + ポジションパート を3並列実行`);
    const [detectedPositions, primaryResult] = await Promise.all([
      detectPositionsWithGemini(ai, merged).catch((e) => {
        console.log(`[detect] 失敗: ${e.message}`);
        return [] as string[];
      }),
      generateJobJsonSplit(
        ai,
        companyName,
        primaryPositionCandidate,
        salary,
        merged,
        primaryPositionCandidate || undefined
      ),
    ]);
    const jobData = primaryResult.jobData;
    const formatUsage = primaryResult.usage;
    console.log(`[positions] 検出: ${JSON.stringify(detectedPositions)}`);

    // 実プライマリ（ユーザー指定優先）
    const primaryPosition = jobTitle || detectedPositions[0] || "";

    // サブポジションは jobTitle のみを配列化（詳細は後追いで別エンドポイントが担う想定）
    const subPositionUsages: any[] = [];
    const allPositions: any[] = [];

    const uniqueDetected = Array.from(
      new Set([primaryPosition, ...detectedPositions].filter((s) => s && s.trim()))
    );

    if (!jobTitle && uniqueDetected.length >= 2) {
      allPositions.push({
        jobTitle: primaryPosition,
        summary: jobData.summary || "",
        jobContent: jobData.jobContent || {},
        requirements: jobData.requirements || {},
        salary: jobData.salary || {},
        workConditions: jobData.workConditions || {},
      });
      for (const pos of uniqueDetected.slice(1, 8)) {
        allPositions.push({
          jobTitle: pos,
          summary: "",
          jobContent: {},
          requirements: {},
          salary: {},
          workConditions: {},
        });
      }
    }

    // "情報なし" 系の値は空文字に戻す（フロント表示対策）
    const EMPTY_SET = new Set(["情報なし", "なし", "未記載", "—", "-", "N/A", "n/a", "該当なし", "未定"]);
    const normalizeEmpty = (v: any): string => {
      if (v === null || v === undefined) return "";
      const s = String(v).trim();
      return EMPTY_SET.has(s) ? "" : s;
    };

    // ユーザー入力で上書き
    if (companyName) jobData.companyName = companyName;
    if (jobTitle) jobData.jobTitle = jobTitle;
    jobData.companyName = normalizeEmpty(jobData.companyName);
    jobData.jobTitle = normalizeEmpty(jobData.jobTitle);
    if (jobData.summary) jobData.summary = normalizeEmpty(jobData.summary);
    if (salary) {
      jobData.salary = jobData.salary || {};
      jobData.salary["基本給"] = salary;
    }

    const requiredSections = [
      "basicInfo",
      "companyInfo",
      "jobContent",
      "requirements",
      "salary",
      "workConditions",
      "holidays",
      "benefits",
    ];
    for (const s of requiredSections) {
      if (!jobData[s] || typeof jobData[s] !== "object" || Array.isArray(jobData[s])) {
        jobData[s] = {};
      }
    }

    // ネストしたオブジェクト/配列を flat な文字列に変換（フロントの textarea 表示前提）
    const flattenValue = (v: any, depth = 0): string => {
      if (v === null || v === undefined) return "";
      if (typeof v === "string") return v;
      if (typeof v === "number" || typeof v === "boolean") return String(v);
      if (Array.isArray(v)) {
        return v
          .map((item) => flattenValue(item, depth + 1))
          .filter((s) => s.trim().length > 0)
          .map((s) => (depth === 0 ? `・${s}` : s))
          .join("\n");
      }
      if (typeof v === "object") {
        return Object.entries(v)
          .map(([k, val]) => {
            const sub = flattenValue(val, depth + 1);
            return sub ? `${k}: ${sub}` : "";
          })
          .filter((s) => s.length > 0)
          .join("\n");
      }
      return String(v);
    };

    // 子キーを1段階にフラット化して追加キーとして展開する
    // 例: salary.給与内訳 = { 提示年俸総額内訳: "X", 月給換算額の定義: "Y" }
    //   → salary["給与内訳_提示年俸総額内訳"] = "X"
    //   → salary["給与内訳_月給換算額の定義"] = "Y"
    // かつ salary.給与内訳 自体も flat string として残す
    for (const sectionKey of requiredSections) {
      const section = jobData[sectionKey];
      const expanded: Record<string, string> = {};
      for (const [k, v] of Object.entries(section)) {
        // ネストオブジェクトは子キーも展開（情報密度を増やす）
        if (
          v &&
          typeof v === "object" &&
          !Array.isArray(v) &&
          Object.keys(v as any).length > 0
        ) {
          for (const [ck, cv] of Object.entries(v as any)) {
            expanded[`${k}｜${ck}`] = flattenValue(cv);
          }
        } else {
          expanded[k] = flattenValue(v);
        }
      }
      jobData[sectionKey] = expanded;
    }

    // トップレベルの文字列化
    if (typeof jobData.summary !== "string") jobData.summary = flattenValue(jobData.summary);
    if (typeof jobData.companyName !== "string")
      jobData.companyName = flattenValue(jobData.companyName);
    if (typeof jobData.jobTitle !== "string")
      jobData.jobTitle = flattenValue(jobData.jobTitle);

    jobData.sources = contents.map((c) => c.url);

    // 正規化: ポジション配列内のフィールドも flatten
    if (allPositions.length > 0) {
      jobData.positions = allPositions.map((p) => {
        const normalized: any = {
          jobTitle: typeof p.jobTitle === "string" ? p.jobTitle : String(p.jobTitle || ""),
          summary: typeof p.summary === "string" ? p.summary : String(p.summary || ""),
        };
        for (const key of ["jobContent", "requirements", "salary", "workConditions"]) {
          const section = p[key] || {};
          const expanded: Record<string, string> = {};
          for (const [k, v] of Object.entries(section)) {
            if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v as any).length > 0) {
              for (const [ck, cv] of Object.entries(v as any)) {
                expanded[`${k}｜${ck}`] = flattenValue(cv);
              }
            } else {
              expanded[k] = flattenValue(v);
            }
          }
          normalized[key] = expanded;
        }
        return normalized;
      });
    }

    // コスト算出 (Gemini 2.5 Flash 料金 / 2025年時点)
    // input: $0.30 / 1M tokens, output: $2.50 / 1M tokens
    // Google Search Grounding: $35 / 1000 request (無料枠500/日)
    const totalInputTokens =
      (searchUsage?.promptTokenCount || 0) +
      (formatUsage?.promptTokenCount || 0) +
      subPositionUsages.reduce((s, u) => s + (u?.promptTokenCount || 0), 0);
    const totalOutputTokens =
      (searchUsage?.candidatesTokenCount || 0) +
      (formatUsage?.candidatesTokenCount || 0) +
      subPositionUsages.reduce((s, u) => s + (u?.candidatesTokenCount || 0), 0);
    const inputCostUSD = (totalInputTokens / 1_000_000) * 0.3;
    const outputCostUSD = (totalOutputTokens / 1_000_000) * 2.5;
    const searchCostUSD = searchUsage ? 35 / 1000 : 0; // URL探索した場合のみ
    const totalUSD = inputCostUSD + outputCostUSD + searchCostUSD;
    const usdToJpy = 155;

    jobData._meta = {
      engine: "jina-reader + gemini-2.5-flash",
      elapsed_ms: Date.now() - startedAt,
      source_chars: merged.length,
      source_count: contents.length,
      detected_positions: detectedPositions,
      positions_generated: allPositions.length,
      tokens: {
        input: totalInputTokens,
        output: totalOutputTokens,
      },
      cost: {
        input_usd: +inputCostUSD.toFixed(6),
        output_usd: +outputCostUSD.toFixed(6),
        search_usd: +searchCostUSD.toFixed(6),
        total_usd: +totalUSD.toFixed(6),
        total_jpy_approx: +(totalUSD * usdToJpy).toFixed(3),
      },
    };

    console.log(
      `[done] ${Date.now() - startedAt}ms | $${totalUSD.toFixed(4)} (${(totalUSD * usdToJpy).toFixed(2)}円) | in:${totalInputTokens} out:${totalOutputTokens}`
    );
    return NextResponse.json(jobData);
  } catch (err: any) {
    console.error("Generate error:", err);
    return NextResponse.json(
      { error: err.message || "求人票の生成に失敗しました" },
      { status: 500 }
    );
  }
}
