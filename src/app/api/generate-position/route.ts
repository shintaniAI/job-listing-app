import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

export const runtime = "nodejs";
export const maxDuration = 60;

// 旧BLOCKED_SITES: 求人媒体は排除せず補助ソースとして受け入れる方針に変更


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

const POSITION_INSTRUCTION = `あなたは採用ページ原文から求人票を作成する専門家です。与えられた**企業公式の採用ページ全文**と「対象ポジション名」から、そのポジション**固有**の4セクションをJSONで返してください。

【絶対ルール】
- **採用ページ最優先・網羅**: 先頭の「=== SOURCE URL:」ソース(Talentio/HRMOS/Wantedly等の採用ページ)は正本。そこに書かれているポジション関連の情報は**全て漏らさず**転記する（章見出し・箇条書き・表・制度一覧・数値・金額・時間帯を全てカバー）
- **HP等は追加情報**: 2件目以降のソース(HP・求人媒体等)は採用ページの補完に使う。採用ページに無い情報があれば追加するが、採用ページに書かれている項目の値を上書きしない
- 原文の章見出し（「職務内容」「得られるスキル・経験」「応募資格（必須/歓迎）」「求める人材」「報酬」「諸手当」「就業形態・休憩時間」「勤務地」等）を全てカバー
- 数値・固有名詞・制度名・金額・時間は**原文通りに**転記（改変・言い換え禁止）
- 情報がない項目は値を空文字列 "" にする
- 値は必ず「文字列」（配列・ネストオブジェクト禁止）
- 該当ポジション固有の情報のみ抽出（他職種の内容は混ぜない）
- **推測・創作・要約・短縮は完全禁止**。提供された原文（公式ページ・求人媒体含む）に無いことは書かない／あることは端折らない
- 求人媒体（Indeed/doda/マイナビ転職/リクナビNEXT/エン転職等）もソースに含まれていれば追加情報として参照OK
- 原文が長い場合は値が長くなっても省略しない

【キー設計・値の書き方】
- **同一トピックは必ず1つのキーにまとめる**。"主な業務内容1","主な業務内容2"のように番号付きで分けない。"主な業務内容"というキーに複数行（改行区切り）で全て書く
- 複数項目が列挙されるトピック（主な業務内容 / 必須要件 / 歓迎要件 / 求める人材 / 諸手当 等）は、値の中で改行区切りの箇条書きにする（各行頭に「・」）
- ナラティブな情報（ポジションの特徴・魅力・キャリアパス解説等）は番号や記号を付けず**そのまま文章**として転記
- **キー名は求人者目線で見出しとして自然なもの**にし、数字サフィックスは禁止

【出力する4セクション & 推奨キー】
# summary: このポジションの概要を原文ベースで2〜3文
# jobContent（仕事内容）
  推奨キー: 主な業務内容 / ポジションの特徴 / このポジションの魅力 / 得られるスキル・経験 / チーム構成 / 配属先 / 1日の流れ / キャリアパス / 使用ツール・技術スタック
# requirements（応募資格）
  推奨キー: 必須要件 / 歓迎要件 / 求める人材 / 年齢 / 学歴
# salary（給与）
  推奨キー: 想定年収 / 賃金形態 / 基本給 / 年俸月額 / 所定内給与 / 固定時間外手当 / 固定深夜手当 / 諸手当 / 給与改定 / 賞与 / 給与モデル例
# workConditions（勤務条件）
  推奨キー: 勤務地 / 勤務地住所 / 最寄り駅 / 勤務時間 / フレックス / コアタイム / 清算期間 / 休憩時間 / リモートワーク / 残業 / 試用期間 / 転勤 / 副業 / 服装

【出力形式（JSONのみ、コードフェンス禁止）】
{
  "summary": "...",
  "jobContent": { "主な業務内容":"", "得られるスキル・経験":"", ... },
  "requirements": { "必須要件":"", "歓迎要件":"", "求める人材":"", ... },
  "salary": { "想定年収":"", "固定時間外手当":"", "諸手当":"", ... },
  "workConditions": { "勤務地":"", "勤務時間":"", "休憩時間":"", ... }
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

const EMPTY_SET = new Set(["情報なし", "なし", "未記載", "—", "-", "N/A", "n/a", "該当なし", "未定"]);

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
    ? body.sources
        .filter((s: any) => typeof s === "string" && /^https?:\/\//.test(s))
        .slice(0, 4)
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

    // 元ソースを並列で再取得
    const texts: string[] = [];
    const results = await Promise.allSettled(
      sources.map((u) => fetchJinaReader(u, 15000).then((t) => ({ u, t })))
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.t && r.value.t.length > 200) {
        texts.push(`=== SOURCE URL: ${r.value.u} ===\n${r.value.t}`);
      }
    }
    if (texts.length === 0) {
      throw new Error("採用ページの再取得に失敗しました");
    }

    const merged = texts.join("\n\n---\n\n").slice(0, 80000);

    const prompt = [
      POSITION_INSTRUCTION,
      "",
      `会社名: ${companyName || "（未指定）"}`,
      `対象ポジション: ${positionTitle}`,
      "",
      "【採用ページ全文（複数ソース統合）】",
      merged,
      "",
      "上記の**採用ページ原文からのみ**、このポジション固有の情報をJSONで返してください。",
    ].join("\n");

    const result = await withTimeout(
      ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          temperature: 0.1,
          maxOutputTokens: 12000,
          thinkingConfig: { thinkingBudget: 0 },
        } as any,
      }),
      38000,
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

    const out: any = {
      jobTitle: positionTitle,
      summary: typeof parsed.summary === "string" ? parsed.summary : flattenValue(parsed.summary),
    };
    if (EMPTY_SET.has(String(out.summary).trim())) out.summary = "";

    for (const key of ["jobContent", "requirements", "salary", "workConditions"]) {
      const section = parsed[key] || {};
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
      out[key] = expanded;
    }

    const usage = (result as any).usageMetadata || {};
    const inTok = usage.promptTokenCount || 0;
    const outTok = usage.candidatesTokenCount || 0;
    out._meta = {
      elapsed_ms: Date.now() - startedAt,
      tokens: { input: inTok, output: outTok },
      cost_jpy_approx: +(((inTok / 1_000_000) * 0.3 + (outTok / 1_000_000) * 2.5) * 155).toFixed(3),
    };

    return NextResponse.json(out);
  } catch (err: any) {
    console.error("generate-position error:", err);
    return NextResponse.json({ error: err.message || "生成失敗" }, { status: 500 });
  }
}
