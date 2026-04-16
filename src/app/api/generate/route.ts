import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

export const runtime = "nodejs";
export const maxDuration = 60;

// 求人媒体（参照禁止リスト）
const BLOCKED_SITES = [
  "jp.indeed.com",
  "indeed.com",
  "doda.jp",
  "next.rikunabi.com",
  "tenshoku.mynavi.jp",
  "employment.en-japan.com",
  "bizreach.jp",
  "type.jp",
  "townwork.net",
  "green-japan.com",
  "mynavi-agent.jp",
  "recruit-agent.co.jp",
];

// 優先的に掘りたい公式採用媒体ホスト
const PREFERRED_HOSTS = [
  "open.talentio.com",
  "talentio.com",
  "hrmos.co",
  "wantedly.com",
  "herp.careers",
  "careers",
  "recruit",
];

// 「求人詳細ページっぽい」URLパターン
const JOB_DETAIL_PATTERNS = [
  /open\.talentio\.com\/r\/[^/]+\/c\/[^/]+\/pages\/\d+/i,
  /talentio\.com\/[^/]+\/pages\/\d+/i,
  /hrmos\.co\/pages\/[^/]+\/jobs\/\d+/i,
  /wantedly\.com\/projects\/\d+/i,
  /herp\.careers\/v\d+\/[^/]+\/[^/]+/i,
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
  const lower = url.toLowerCase();
  return BLOCKED_SITES.some((b) => lower.includes(b));
}

function isJobDetailUrl(url: string): boolean {
  return JOB_DETAIL_PATTERNS.some((p) => p.test(url));
}

function isPreferredHost(url: string): boolean {
  const lower = url.toLowerCase();
  return PREFERRED_HOSTS.some((h) => lower.includes(h));
}

// URLを優先度でソート: 求人詳細 > 公式採用媒体 > その他
function sortByPriority(urls: string[]): string[] {
  return [...urls].sort((a, b) => {
    const ap = isJobDetailUrl(a) ? 0 : isPreferredHost(a) ? 1 : 2;
    const bp = isJobDetailUrl(b) ? 0 : isPreferredHost(b) ? 1 : 2;
    return ap - bp;
  });
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
    `- https://open.talentio.com/r/1/c/{slug}/pages/{id}`,
    `- https://hrmos.co/pages/{slug}/jobs/{id}`,
    `- https://www.wantedly.com/companies/{slug}/projects`,
    `- https://{domain}/careers/`,
    `- https://{domain}/recruit/`,
    "",
    "【絶対禁止】以下の求人媒体は無視してください:",
    BLOCKED_SITES.map((s) => `  - ${s}`).join("\n"),
    "",
    "URLのみ1行ずつ、最大6件出力。説明文不要。知らない場合は空でOK。",
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
  return { urls: urls.slice(0, 6), usage: (result as any).usageMetadata || {} };
}

// ---------- Gemini + Google Search で公式採用URLを探す（多角クエリ） ----------
async function findOfficialUrlWithGemini(
  ai: GoogleGenAI,
  companyName: string,
  jobTitle: string
): Promise<{ urls: string[]; usage: any }> {
  const jobClause = jobTitle ? `特に「${jobTitle}」の職種ページがあれば最優先。` : "";
  const prompt = [
    `「${companyName}」の求人票を作成するため、公式の採用関連URLをできるだけ多く集めてください。${jobClause}`,
    "",
    "【最優先で見つけたいURL（求人詳細ページ）】",
    `- open.talentio.com/r/.../c/.../pages/NNNNNN の形式の個別求人ページ`,
    `- hrmos.co/pages/.../jobs/NNNNNN の形式の個別求人ページ`,
    `- wantedly.com/projects/NNNNNN の形式の個別募集ページ`,
    `- herp.careers/v1/.../.../ の形式の個別求人ページ`,
    `- 会社独自の /careers/jobs/... /recruit/jobs/... 個別求人ページ`,
    `※ ルートURLだけでなく、個別求人の詳細ページURLを最大6件集めること。`,
    "",
    "【次点で欲しいURL】",
    `- 公式の採用/キャリアページ（トップ）`,
    `- 会社概要・事業内容・ミッション/ビジョン/バリュー（MVV）ページ`,
    `- プレスリリース・企業ブログ（採用や文化に関するもの）`,
    "",
    "【絶対に含めてはいけない（求人媒体）】",
    BLOCKED_SITES.map((s) => `  - ${s}`).join("\n"),
    "",
    "URLだけを1行ずつ**最大12件**出力。説明・番号・マークダウン記法は一切不要。",
  ].join("\n");

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
  const sorted = sortByPriority(merged);
  const usage = (result as any).usageMetadata || {};
  return { urls: sorted.slice(0, 12), usage };
}

// ---------- 複数ポジション検出 ----------
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
    sourceText.slice(0, 20000),
  ].join("\n");

  const result = await withTimeout(
    ai.models.generateContent({
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

// ====== プロンプト（talentio/HRMOS 実物ベースに再設計） ======
const COMMON_RULES = `【絶対ルール】
- **最優先**: 先頭に記載された「=== SOURCE URL: ...」の最初のソース（通常はTalentio/HRMOS/Wantedly等の求人詳細ページ）を**正本**として扱い、その原文を**ほぼ逐語的に**全てJSONへ転記する
- 原文の章見出し（「求人概要」「職務内容」「応募資格」「報酬」「諸手当」「休日・休暇」「福利厚生」「事業概要」「ミッション」「ビジョン」「バリュー」「カルチャー」等）を全てカバーする
- 箇条書き・表・制度一覧は1項目ずつ個別キーに分けて転記する（「など」で端折らない／まとめない）
- 数値・固有名詞・制度名・金額・時間帯・時間数は**原文通りに**転記（改変・丸め・言い換え禁止）
- 情報がない項目は値を空文字列 "" にする（"情報なし"等の文字列を入れない）
- 雛形にないキーは自由に追加してよい（原文にある情報は全部拾う）
- 値は必ず「文字列」（配列・ネストオブジェクト禁止）
- 複数項目がある場合は個別キー（例: "主な業務内容1","主な業務内容2"...）に分ける
- **推測・創作・要約・短縮は完全禁止**。原文に書かれていないことは絶対に書かない／書かれていることを端折らない
- **Indeed/doda/マイナビ転職/リクナビNEXT/エン転職等の求人媒体に書いてある表現や情報は一切使わない**。採用ページ原文のみを根拠とする
- 原文が長い場合は項目数を増やしてでも全て拾う（値が長くても省略しない）`;

// パートA: 企業全体情報
const PROMPT_COMPANY_PART = `あなたは採用ページ原文から求人票を作成する専門家です。与えられた**企業公式の採用ページ全文**から、**企業全体に関する情報**のみをJSONで出力してください。

${COMMON_RULES}

【出力セクション & 期待される項目（talentio水準）】
# summary
- このポジション／企業の魅力を採用ページの言葉で2〜3文に要約

# basicInfo（基本情報）最低5項目
- 企業名 / 募集職種 / 雇用形態 / 募集人数 / 契約期間 / 試用期間の有無 / 勤務開始日 等

# companyInfo（企業情報）最低12項目
- 事業内容1, 事業内容2, 事業内容3...（原文に列挙されている事業を全て個別キーに）
- ミッション（Mission）/ ビジョン（Vision）/ バリュー（Value）／行動指針
- 事業の特徴 / 事業の強み / 今後の展望
- カルチャー / 社風 / カルチャー特徴
- 設立年月 / 従業員数 / 資本金 / 代表者 / 本社所在地
- 代表メッセージ / 沿革 / グループ会社 等、採用ページにある項目は全部拾う

# holidays（休日・休暇）最低7項目
- 休日制度（例: 完全週休2日制 土日祝）
- 年間休日数
- 有給休暇（付与タイミング・日数の原文表記）
- 特別休暇1, 特別休暇2...（夏季/年末年始/バースデー/慶弔/GW 等を個別に）
- 長期休暇 / 育児休暇 / 介護休暇 等

# benefits（福利厚生・待遇）最低15項目
- 社会保険（健康/厚生年金/雇用/労災） ※原文で分かれていれば個別キーに
- 健康制度（健康診断/インフルエンザ/人間ドック）
- 食事補助/フリードリンク/軽食/フリーチョコレート 等 原文にある制度を1つずつ
- 在宅・リモート関連 / 通勤手当 / 住宅手当 / 家族手当
- 育児・介護支援
- 学習支援（書籍購入補助/研修/資格取得支援）
- 独自制度1, 独自制度2...（社員旅行/仮眠制度/慶弔金 等）
- 退職金 / 表彰制度 / 懇親会制度 等

【出力形式（JSONのみ、コードフェンス禁止）】
{
  "summary": "...",
  "basicInfo": { "企業名":"", "募集職種":"", ... },
  "companyInfo": { "事業内容1":"", "ミッション":"", "ビジョン":"", "バリュー":"", ... },
  "holidays": { "休日制度":"", "年間休日数":"", "特別休暇1":"", ... },
  "benefits": { "健康保険":"", "書籍購入補助":"", "社員旅行":"", ... }
}`;

// パートB: ポジション固有情報
const PROMPT_POSITION_PART = `あなたは採用ページ原文から求人票を作成する専門家です。与えられた**企業公式の採用ページ全文**から、**ポジションの業務/条件**に関する情報のみをJSONで出力してください。

${COMMON_RULES}

【出力セクション & 期待される項目（talentio水準）】
# jobContent（仕事内容）最低10項目
- 主な業務内容1, 主な業務内容2...（原文の業務列挙を全て個別キーに）
- ポジションの特徴 / このポジションの魅力
- 得られるスキル・経験1, 得られるスキル・経験2...
- チーム構成 / 配属先 / 1日の流れ
- 今後の活躍の場・キャリアパス
- 使用ツール・技術スタック（書いてあれば）

# requirements（応募資格）最低10項目
- 必須要件1, 必須要件2... （原文の「必須」項目を全部個別キーに）
- 歓迎要件1, 歓迎要件2... （原文の「歓迎」項目を全部個別キーに）
- 求める人材1, 求める人材2...（原文の「求める人材」「こんな方を求めています」項目を全部）
- 年齢 / 学歴（書いてあれば）

# salary（給与・報酬）最低10項目
- 想定年収（提示年俸） / 賃金形態 / 基本給 / 月給
- 年俸月額 / 所定内給与
- 固定時間外手当（月額・時間数）
- 固定深夜手当（月額・時間数・時間帯）
- 通勤手当 / 残業手当 / 諸手当1, 諸手当2...
- 給与改定(昇給頻度) / 賞与(種類・時期・業績連動有無)
- 給与モデル例（書いてあれば）

# workConditions（勤務条件）最低10項目
- 勤務地（オフィス/自宅/サテライト等、原文の表記を尊重）
- 勤務地住所 / 最寄り駅
- 勤務時間 / 所定労働時間 / フレックス有無 / コアタイム
- 清算期間
- 休憩時間（原文の細則通り）
- リモートワーク可否 / リモート頻度
- 残業 / 所定時間外労働の有無
- 試用期間 / 試用期間中の条件
- 転勤 / 副業 / 服装

【出力形式（JSONのみ、コードフェンス禁止）】
{
  "jobContent": { "主な業務内容1":"", ... },
  "requirements": { "必須要件1":"", "歓迎要件1":"", "求める人材1":"", ... },
  "salary": { "想定年収":"", "年俸月額":"", "固定時間外手当":"", ... },
  "workConditions": { "勤務地":"", "勤務時間":"", "休憩時間":"", ... }
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
    "【採用ページ全文テキスト（複数ソース統合）】",
    sourceText,
    "",
    "上記の**採用ページ原文からのみ**、企業全体の情報をJSONで返してください。原文にない情報は書かないでください。",
  ].join("\n");

  const result = await withTimeout(
    ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        temperature: 0.1,
        maxOutputTokens: 20000,
        thinkingConfig: { thinkingBudget: 0 },
      } as any,
    }),
    42000,
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
    focusHint ? `\n【重要】「${focusHint}」というポジション専用の情報に絞ってください。他職種の内容は混ぜないでください。` : "",
    "",
    "【採用ページ全文テキスト（複数ソース統合）】",
    sourceText,
    "",
    "上記の**採用ページ原文からのみ**、ポジション固有の情報をJSONで返してください。原文にない情報は書かないでください。",
  ].join("\n");

  const result = await withTimeout(
    ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        temperature: 0.1,
        maxOutputTokens: 20000,
        thinkingConfig: { thinkingBudget: 0 },
      } as any,
    }),
    42000,
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
      // ユーザーが求人詳細ページ(Talentio/HRMOS/Wantedly等)を指定した場合は、
      // その1ソースが最も密度が高い正本なので補助URL探索はスキップし、内容の希釈を防ぐ
      const isPrimaryDetail = isJobDetailUrl(companyUrl);
      if (isPrimaryDetail) {
        console.log(`[search] 指定URLは求人詳細ページと判定: 補助URL探索をスキップ (${companyUrl})`);
      } else if (companyName) {
        try {
          const more = await findOfficialUrlWithGemini(ai, companyName, jobTitle);
          searchUsage = more.usage;
          for (const u of more.urls) {
            if (!targetUrls.includes(u)) targetUrls.push(u);
          }
        } catch (e: any) {
          console.log(`[search] 補助URL探索失敗: ${e.message}`);
        }
      }
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
      console.log(`[search] 候補URL: ${targetUrls.length}件`);
    } else {
      return NextResponse.json(
        { error: "会社名または採用ページURLを入力してください" },
        { status: 400 }
      );
    }

    // 優先度順にソート
    targetUrls = sortByPriority(targetUrls);
    console.log(`[search] ソート後URL:`, targetUrls);

    // Step 2: Jina Reader で最大6件を並列取得
    const fetchCandidates = targetUrls.slice(0, 6);
    console.log(`[fetch] Jina Readerで並列取得: ${fetchCandidates.length}件`);
    const contents: { url: string; text: string }[] = [];
    const MIN_TEXT_LEN = 150;

    const fetchResults = await Promise.allSettled(
      fetchCandidates.map((url) => fetchJinaReader(url, 12000).then((text) => ({ url, text })))
    );
    for (const r of fetchResults) {
      if (r.status === "fulfilled" && r.value.text && r.value.text.length > MIN_TEXT_LEN) {
        contents.push(r.value);
        console.log(`  ✓ ${r.value.url} (${r.value.text.length}文字)`);
      } else if (r.status === "rejected") {
        console.log(`  ✗ ${r.reason?.message || r.reason}`);
      }
    }

    // 並列が全滅なら直列フォールバック
    if (contents.length === 0) {
      console.log(`[fetch] 並列全失敗、直列フォールバック`);
      for (const url of fetchCandidates) {
        try {
          const text = await fetchJinaReader(url, 18000);
          if (text && text.length > MIN_TEXT_LEN) {
            contents.push({ url, text });
            console.log(`  ✓ (serial) ${url} (${text.length}文字)`);
            break;
          }
        } catch (e: any) {
          console.log(`  ✗ (serial) ${url}: ${e.message}`);
        }
      }
    }

    if (contents.length === 0) {
      throw new Error(
        "採用ページのテキスト取得に失敗しました。URLを直接入力するか、別のページで試してください。"
      );
    }

    // Gemini入力: 最大80000文字、求人詳細ページを先頭に
    const MAX_CHARS = 80000;
    const sortedContents = [...contents].sort((a, b) => {
      const ap = isJobDetailUrl(a.url) ? 0 : isPreferredHost(a.url) ? 1 : 2;
      const bp = isJobDetailUrl(b.url) ? 0 : isPreferredHost(b.url) ? 1 : 2;
      return ap - bp;
    });
    let merged = sortedContents
      .map((c) => `=== SOURCE URL: ${c.url} ===\n${c.text}`)
      .join("\n\n---\n\n");
    if (merged.length > MAX_CHARS) merged = merged.slice(0, MAX_CHARS);
    console.log(`[fetch] 最終ソース数: ${contents.length}件 / ${merged.length}文字`);

    // Step 3: 検出 + 2分割並列生成
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

    const primaryPosition = jobTitle || detectedPositions[0] || "";
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

    const EMPTY_SET = new Set(["情報なし", "なし", "未記載", "—", "-", "N/A", "n/a", "該当なし", "未定"]);
    const normalizeEmpty = (v: any): string => {
      if (v === null || v === undefined) return "";
      const s = String(v).trim();
      return EMPTY_SET.has(s) ? "" : s;
    };

    if (companyName) jobData.companyName = companyName;
    if (jobTitle) jobData.jobTitle = jobTitle;
    jobData.companyName = normalizeEmpty(jobData.companyName);
    jobData.jobTitle = normalizeEmpty(jobData.jobTitle);
    if (jobData.summary) jobData.summary = normalizeEmpty(jobData.summary);
    if (salary) {
      jobData.salary = jobData.salary || {};
      jobData.salary["想定年収"] = salary;
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

    for (const sectionKey of requiredSections) {
      const section = jobData[sectionKey];
      const expanded: Record<string, string> = {};
      for (const [k, v] of Object.entries(section)) {
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
          const s = flattenValue(v);
          expanded[k] = EMPTY_SET.has(s.trim()) ? "" : s;
        }
      }
      jobData[sectionKey] = expanded;
    }

    if (typeof jobData.summary !== "string") jobData.summary = flattenValue(jobData.summary);
    if (typeof jobData.companyName !== "string")
      jobData.companyName = flattenValue(jobData.companyName);
    if (typeof jobData.jobTitle !== "string")
      jobData.jobTitle = flattenValue(jobData.jobTitle);

    jobData.sources = contents.map((c) => c.url).filter((u) => !isBlockedUrl(u));

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
              const s = flattenValue(v);
              expanded[k] = EMPTY_SET.has(s.trim()) ? "" : s;
            }
          }
          normalized[key] = expanded;
        }
        return normalized;
      });
    }

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
    const searchCostUSD = searchUsage ? 35 / 1000 : 0;
    const totalUSD = inputCostUSD + outputCostUSD + searchCostUSD;
    const usdToJpy = 155;

    jobData._meta = {
      engine: "jina-reader + gemini-2.5-flash",
      elapsed_ms: Date.now() - startedAt,
      source_chars: merged.length,
      source_count: contents.length,
      detected_positions: detectedPositions,
      positions_generated: allPositions.length,
      tokens: { input: totalInputTokens, output: totalOutputTokens },
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
