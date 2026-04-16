import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

export const runtime = "nodejs";
export const maxDuration = 60;

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

function isBlockedUrl(url: string): boolean {
  return BLOCKED_SITES.some((b) => url.includes(b));
}

async function fetchJinaReader(url: string, timeoutMs = 20000): Promise<string> {
  const target = `https://r.jina.ai/${url}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(target, {
      method: "GET",
      headers: { Accept: "text/plain", "X-Return-Format": "markdown" },
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Jina取得失敗: ${res.status}`);
    return await res.text();
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`Jina Readerタイムアウト(${timeoutMs}ms)`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 特定ポジションに絞った部分セクション生成
const POSITION_INSTRUCTION = `あなたは求人票作成の専門家です。与えられた採用ページ全文と「対象ポジション名」から、そのポジション**固有**の4セクションだけをJSONで返してください。

【出力する4セクション】
- jobContent (仕事内容 / 業務内容を個別キーに分けて列挙)
- requirements (応募資格: 必須/歓迎/求める人物像)
- salary (給与: 年収/月給/固定時間外手当/賞与/諸手当 等を個別キーに)
- workConditions (勤務条件: 勤務地/勤務時間/リモート可否/残業/試用期間 等)

【絶対ルール】
- 値は必ず「文字列」。配列・ネストオブジェクト禁止
- 複数項目は個別キーに分ける（例: "主な業務内容1", "主な業務内容2", ...）
- 該当ポジション固有の情報のみ抽出（他職種の内容は混ぜない）
- 情報がなければ値を "情報なし" にする
- 原文の数値・固有名詞・制度名をそのまま転記

【追加出力】
- summary: このポジションの概要を2〜3文で

【出力形式（JSONのみ）】
{
  "summary": "...",
  "jobContent": { "主な業務内容1": "...", ... },
  "requirements": { ... },
  "salary": { ... },
  "workConditions": { ... }
}`;

const flattenValue = (v: any, depth = 0): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v))
    return v
      .map((i) => flattenValue(i, depth + 1))
      .filter((s) => s.trim())
      .map((s) => (depth === 0 ? `・${s}` : s))
      .join("\n");
  if (typeof v === "object")
    return Object.entries(v)
      .map(([k, val]) => {
        const sub = flattenValue(val, depth + 1);
        return sub ? `${k}: ${sub}` : "";
      })
      .filter((s) => s)
      .join("\n");
  return String(v);
};

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "不正なJSON" }, { status: 400 });
  }

  const positionTitle = String(body.positionTitle || "").trim().slice(0, 200);
  const companyName = String(body.companyName || "").trim().slice(0, 200);
  const sources: string[] = Array.isArray(body.sources)
    ? body.sources.filter((s: any) => typeof s === "string" && /^https?:\/\//.test(s) && !isBlockedUrl(s)).slice(0, 3)
    : [];

  if (!positionTitle) {
    return NextResponse.json({ error: "positionTitle が必要です" }, { status: 400 });
  }
  if (sources.length === 0) {
    return NextResponse.json({ error: "sources (URL) が必要です" }, { status: 400 });
  }

  const startedAt = Date.now();
  try {
    const ai = getGenAI();

    // 元ソースを再取得（Jinaはキャッシュされるので高速）
    const texts: string[] = [];
    for (const url of sources) {
      try {
        const t = await fetchJinaReader(url);
        if (t && t.length > 200) texts.push(`=== ${url} ===\n${t}`);
      } catch {}
      if (texts.length >= 2) break;
    }
    if (texts.length === 0) {
      throw new Error("採用ページの再取得に失敗しました");
    }

    const merged = texts.join("\n\n").slice(0, 60000);

    const prompt = [
      POSITION_INSTRUCTION,
      "",
      `会社名: ${companyName || "（未指定）"}`,
      `対象ポジション: ${positionTitle}`,
      "",
      "【採用ページ全文】",
      merged,
      "",
      "上記からこのポジション固有の情報のみを JSON で返してください。",
    ].join("\n");

    const result = await withTimeout(
      ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          temperature: 0.2,
          maxOutputTokens: 8000,
        },
      }),
      45000,
      "Gemini(ポジション詳細生成)"
    );

    let parsed: any;
    try {
      parsed = JSON.parse(result.text || "{}");
    } catch {
      const m = (result.text || "").match(/\{[\s\S]*\}/);
      if (!m) throw new Error("パース失敗");
      parsed = JSON.parse(m[0]);
    }

    // 正規化
    const out: any = {
      jobTitle: positionTitle,
      summary: typeof parsed.summary === "string" ? parsed.summary : flattenValue(parsed.summary),
    };
    for (const key of ["jobContent", "requirements", "salary", "workConditions"]) {
      const section = parsed[key] || {};
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
      out[key] = expanded;
    }

    const usage = (result as any).usageMetadata || {};
    const inTok = usage.promptTokenCount || 0;
    const outTok = usage.candidatesTokenCount || 0;
    out._meta = {
      elapsed_ms: Date.now() - startedAt,
      tokens: { input: inTok, output: outTok },
      cost_jpy_approx: +((inTok / 1_000_000) * 0.3 + (outTok / 1_000_000) * 2.5).toFixed(6) * 155,
    };

    return NextResponse.json(out);
  } catch (err: any) {
    console.error("generate-position error:", err);
    return NextResponse.json({ error: err.message || "生成失敗" }, { status: 500 });
  }
}
