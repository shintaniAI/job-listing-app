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

// ---------- Jina Reader: URLからMarkdown全文取得 ----------
async function fetchJinaReader(url: string): Promise<string> {
  const target = `https://r.jina.ai/${url}`;
  const res = await fetch(target, {
    method: "GET",
    headers: {
      Accept: "text/plain",
      "X-Return-Format": "markdown",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Jina Reader取得失敗: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  return text;
}

function isBlockedUrl(url: string): boolean {
  return BLOCKED_SITES.some((b) => url.includes(b));
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

  const result = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      tools: [{ googleSearch: {} }],
      temperature: 0,
    },
  });

  const text = result.text || "";
  const urls = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\//.test(l))
    .filter((l) => !isBlockedUrl(l));

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
    sourceText.slice(0, 30000),
  ].join("\n");

  const result = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      temperature: 0,
      maxOutputTokens: 1000,
    },
  });

  try {
    const parsed = JSON.parse(result.text || "{}");
    const arr = Array.isArray(parsed.positions) ? parsed.positions : [];
    return arr.filter((s: any) => typeof s === "string" && s.trim().length > 0).slice(0, 10);
  } catch {
    return [];
  }
}

const GENERATION_INSTRUCTION = `あなたは求人票作成の専門家です。与えられた「採用ページ全文テキスト」から、採用ホームページと同等の情報密度で求人票JSONを生成してください。

【最重要】
- 原文に書かれている情報は**一切省略せず全て**JSONに反映する
- 箇条書き項目は全て転記する（「など」で端折らない）
- 数値・固有名詞・制度名は原文通りに転記する
- 情報がない項目は値を "情報なし" にする（フロントで自動非表示にする）
- 雛形にないキーは自由に追加してよい（例: "代表メッセージ", "選考フロー", "1日のスケジュール", "一日の流れ"）
- 業務内容・福利厚生は原文に出てくる全項目を**個別キーに分けて**列挙する

【JSON値のフォーマット規則 - 絶対厳守】
- **各セクションの値は必ず「文字列」で返す**（配列・ネストオブジェクト禁止）
- 複数項目がある場合は**個別のキーに分ける**（例: "主な業務内容1", "主な業務内容2", "主な業務内容3"...）
- 箇条書きを1つのキーに入れる場合は改行区切りの文字列（"・項目1\\n・項目2\\n・項目3"）
- 給与の内訳のような階層情報も、個別キーに展開する（例: "固定時間外手当", "固定深夜手当", "年俸月額"）

【項目数のミニマム】
- companyInfo: 8項目以上（MVV / 事業 / 特徴 / 代表メッセージ / カルチャー等）
- jobContent: 業務内容だけで5〜15項目（"主な業務内容1"～"主な業務内容N"）+ 業務の流れ / 配属 / キャリアパス
- requirements: 必須3項目 + 歓迎3項目以上 + 求める人物像
- salary: 8項目以上（年収 / 月給 / 固定時間外手当 / 固定深夜手当 / 昇給 / 賞与 / 諸手当 等）
- workConditions: 7項目以上
- holidays: 5項目以上
- benefits: 10項目以上（社会保険 / 健康 / 住宅 / 育児 / スキルアップ / 食事 / レクリエーション 等、独自制度は全て個別キー化）

【禁止事項】
- 要約・言い換え
- 推測・創作
- 「詳細は面接時」だけで済ませる（原文にあれば必ず具体化）
- 配列 [...] やネスト {...} を値に入れること

【品質基準】
- 1項目20〜300文字、具体的数値・固有名詞を含む
- 年収・残業時間・年間休日は必ず数値で記載
- MVV・事業内容・代表メッセージ・カルチャーも企業情報に含める`;

const JOB_SCHEMA_HINT = `
{
  "companyName": "企業名",
  "jobTitle": "募集職種",
  "summary": "求人の概要 (2-3文)",
  "basicInfo": { "企業名":"", "募集職種":"", "雇用形態":"", "募集人数":"", "勤務開始日":"" },
  "companyInfo": { "事業内容":"", "企業理念・ミッション":"", "企業の特徴・強み":"", "設立":"", "従業員数":"", "資本金":"", "本社所在地":"" },
  "jobContent": { "主な業務内容1":"", "主な業務内容2":"", "主な業務内容3":"", "主な業務内容4":"", "主な業務内容5":"", "業務の流れ":"", "配属部署":"", "キャリアパス・昇進":"", "将来性・成長機会":"" },
  "requirements": { "必須要件1":"", "必須要件2":"", "必須要件3":"", "歓迎要件1":"", "歓迎要件2":"", "歓迎要件3":"", "求める人物像":"", "年齢":"", "学歴":"" },
  "salary": { "基本給":"", "想定年収":"", "給与内訳":"", "昇給":"", "賞与":"", "年収モデル例":"", "諸手当":"", "給与備考":"" },
  "workConditions": { "勤務地":"", "勤務先住所":"", "最寄駅・アクセス":"", "勤務時間":"", "リモートワーク可否":"", "残業時間":"", "試用期間":"", "転勤可能性":"", "服装・ドレスコード":"" },
  "holidays": { "年間休日数":"", "休日パターン":"", "有給休暇":"", "特別休暇":"", "長期休暇":"", "休暇制度の特徴":"" },
  "benefits": { "社会保険":"", "退職金制度":"", "健康関連":"", "住宅関連":"", "育児・介護支援":"", "スキルアップ支援":"", "福利厚生施設":"", "その他福利厚生":"" }
}`;

async function generateJobJsonWithGemini(
  ai: GoogleGenAI,
  companyName: string,
  jobTitle: string,
  salary: string,
  sourceText: string,
  focusHint?: string
): Promise<{ jobData: any; usage: any }> {
  const userPrompt = [
    GENERATION_INSTRUCTION,
    "",
    "【最低限の雛形（キーは自由に追加・増やしてOK、雛形にないキーも歓迎）】",
    JOB_SCHEMA_HINT,
    "",
    `会社名(ユーザー入力): ${companyName || "（未指定）"}`,
    `職種(ユーザー入力): ${jobTitle || "（未指定）"}`,
    `給与(ユーザー入力): ${salary || "（未指定）"}`,
    focusHint
      ? `\n【重要】本JSONは「${focusHint}」というポジション専用の求人票として生成してください。\n- jobContent, requirements, salary, workConditions はこのポジション固有の内容にする\n- companyInfo, holidays, benefits など会社全体の情報は共通で構わない`
      : "",
    "",
    "【採用ページ全文テキスト】",
    sourceText,
    "",
    "上記を忠実に反映したJSONだけを出力してください (前後の説明文・マークダウン不要)。",
  ].join("\n");

  const result = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: userPrompt,
    config: {
      responseMimeType: "application/json",
      temperature: 0.2,
      maxOutputTokens: 16000,
    },
  });

  const text = result.text || "";
  let jobData: any;
  try {
    jobData = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Geminiレスポンスをパースできませんでした");
    jobData = JSON.parse(m[0]);
  }

  const usage = (result as any).usageMetadata || {};
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

    // Step 2: Jina Reader で全文Markdown取得（複数URLを結合）
    console.log(`[fetch] Jina Readerで取得: ${targetUrls.length}件`);
    const contents: { url: string; text: string }[] = [];
    for (const url of targetUrls.slice(0, 3)) {
      try {
        const text = await fetchJinaReader(url);
        if (text && text.length > 200) {
          contents.push({ url, text });
          console.log(`  ✓ ${url} (${text.length}文字)`);
        } else {
          console.log(`  ✗ ${url} (短すぎ: ${text?.length || 0}文字)`);
        }
      } catch (e: any) {
        console.log(`  ✗ ${url}: ${e.message}`);
      }
      if (contents.length >= 2) break;
    }

    if (contents.length === 0) {
      throw new Error(
        "採用ページのテキスト取得に失敗しました。URLを直接入力するか、別のページで試してください。"
      );
    }

    const MAX_CHARS = 60000;
    let merged = contents.map((c) => `=== ${c.url} ===\n${c.text}`).join("\n\n");
    if (merged.length > MAX_CHARS) merged = merged.slice(0, MAX_CHARS);

    // Step 2.5: 複数ポジション検出
    console.log(`[positions] 複数ポジションを検出中...`);
    const detectedPositions = await detectPositionsWithGemini(ai, merged);
    console.log(`[positions] 検出結果: ${JSON.stringify(detectedPositions)}`);

    // プライマリポジションの決定: ユーザー指定 > 検出された最初
    const primaryPosition = jobTitle || detectedPositions[0] || "";

    // Step 3: プライマリポジションの求人票を生成
    console.log(`[format] Geminiで整形 (入力${merged.length}文字, focus=${primaryPosition})`);
    const { jobData, usage: formatUsage } = await generateJobJsonWithGemini(
      ai,
      companyName,
      primaryPosition,
      salary,
      merged,
      primaryPosition || undefined
    );

    // Step 3.5: 複数ポジションがある場合は各ポジション用に軽量JSONを生成
    const subPositionUsages: any[] = [];
    const allPositions: any[] = [];

    // ユーザーが特定職種を指定していない かつ 2件以上検出された時のみ複数生成
    const shouldGenerateMultiple =
      !jobTitle && detectedPositions.length >= 2 && detectedPositions.length <= 5;

    if (shouldGenerateMultiple) {
      console.log(`[positions] ${detectedPositions.length}ポジション分を個別生成します`);
      // プライマリは既に生成済みなので残りを生成
      const otherPositions = detectedPositions.filter((p) => p !== primaryPosition);

      // 並列生成 (Gemini Flash は RPM 余裕あり)
      const subResults = await Promise.all(
        otherPositions.map(async (pos) => {
          try {
            const r = await generateJobJsonWithGemini(
              ai,
              companyName,
              pos,
              "",
              merged,
              pos
            );
            return { position: pos, jobData: r.jobData, usage: r.usage };
          } catch (e: any) {
            console.log(`  ✗ ${pos}: ${e.message}`);
            return null;
          }
        })
      );

      // プライマリを先頭にallPositionsに入れる
      allPositions.push({
        jobTitle: primaryPosition,
        summary: jobData.summary || "",
        jobContent: jobData.jobContent || {},
        requirements: jobData.requirements || {},
        salary: jobData.salary || {},
        workConditions: jobData.workConditions || {},
      });

      for (const r of subResults) {
        if (!r) continue;
        subPositionUsages.push(r.usage);
        allPositions.push({
          jobTitle: r.position,
          summary: r.jobData.summary || "",
          jobContent: r.jobData.jobContent || {},
          requirements: r.jobData.requirements || {},
          salary: r.jobData.salary || {},
          workConditions: r.jobData.workConditions || {},
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
