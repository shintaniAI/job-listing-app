import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";
export const maxDuration = 60;

function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY が設定されていません");
  return new OpenAI({ apiKey });
}

function buildResearchPrompt(
  companyName: string,
  companyUrl: string,
  jobTitle: string
): string {
  const lines: string[] = [];

  if (companyUrl) {
    lines.push(`以下のURLに直接アクセスし、採用・求人情報を全て詳細に抽出してください。`);
    lines.push(`URL: ${companyUrl}`);
    lines.push(``);
    if (companyName) {
      lines.push(`また、「${companyName}」の他の採用ページ（Talentio・Wantedly・HRMOS・公式サイト）も追加で検索・調査してください。`);
    }
  } else {
    lines.push(`「${companyName}」の公式採用情報を調査してください。`);
    lines.push(``);
    lines.push(`【調査優先順位】`);
    lines.push(`1. Talentio・Wantedly・HRMOS などの採用プラットフォーム上の企業ページ`);
    lines.push(`2. 企業公式サイトの採用・キャリアページ（/recruit, /careers, /jobs, /採用 など）`);
    lines.push(`3. 上記で情報が不足する場合のみ、求人媒体（Indeed, doda等）を参照`);
  }

  lines.push(``);
  lines.push(`【抽出してほしい情報（全て詳細に）】`);
  lines.push(`- 企業情報: ミッション・ビジョン・バリュー、事業内容、設立年、従業員数、資本金、本社所在地`);
  lines.push(`- 職種名・雇用形態・募集人数`);
  lines.push(`- 仕事内容（具体的な業務を箇条書きで5項目以上）`);
  lines.push(`- 応募資格（必須条件・歓迎条件・求める人物像）`);
  lines.push(`- 給与・年収（必ず具体的な数値で記載。例: 年収400万〜840万円）`);
  lines.push(`- 給与詳細（月額・固定残業代・昇給・賞与）`);
  lines.push(`- 勤務地・住所・最寄り駅・アクセス`);
  lines.push(`- 勤務時間・フレックス制度・残業時間`);
  lines.push(`- 休日・休暇（年間休日数・完全週休2日・有給・特別休暇等）`);
  lines.push(`- 福利厚生・各種手当（健康診断・書籍補助・リモートワーク等）`);
  lines.push(`- 社会保険・退職金`);
  lines.push(`- 試用期間`);

  if (jobTitle) {
    lines.push(``);
    lines.push(`【注目職種】「${jobTitle}」に関する情報を優先的に収集してください。`);
  }

  lines.push(``);
  lines.push(`取得した情報は要約・省略せず、原文に近い形で詳細に出力してください。`);
  lines.push(`数値情報（給与・休日数・残業時間等）は必ず具体的に記載してください。`);

  return lines.join("\n");
}

function extractSources(research: any): string[] {
  const sources: string[] = [];
  try {
    for (const item of research.output || []) {
      if (item.type === "message") {
        for (const content of item.content || []) {
          if (content.type === "output_text") {
            for (const annotation of content.annotations || []) {
              if (annotation.type === "url_citation" && annotation.url) {
                if (!sources.includes(annotation.url)) {
                  sources.push(annotation.url);
                }
              }
            }
          }
        }
      }
    }
  } catch {}
  return sources;
}

const GENERATION_SYSTEM_PROMPT = `あなたは求人票作成の専門家です。企業の公式採用ページから収集した情報を基に、詳細で充実した求人票を作成してください。

【重要な要件】
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
- 情報がない項目は「情報なし」とする（創作・推測は行わない）
- 具体的な数値がある場合は必ず記載する（年収400万～840万円、年間休日120日など）
- MVV（ミッション・ビジョン・バリュー）は企業情報セクションに含める
- 業務内容は5項目以上の具体的な内容を記載する`;

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

    // Step 1: 公式採用ページを web_search でリサーチ（JS描画ページも対応）
    console.log("採用情報をリサーチ中...");
    const researchPrompt = buildResearchPrompt(companyName, companyUrl, jobTitle);

    const research = await openai.responses.create({
      model: "gpt-4o",
      tools: [{ type: "web_search", search_context_size: "high" } as any],
      input: researchPrompt,
    });

    const context = research.output_text || "";
    const sources = extractSources(research);

    console.log(`リサーチ完了: ${context.length}文字, ソース${sources.length}件`);

    if (!context || context.length < 200) {
      throw new Error("企業情報の収集に失敗しました。会社名またはURLを確認してください。");
    }

    // Step 2: 収集情報をもとに構造化された求人票を生成
    console.log("求人票を生成中...");
    const userPrompt = `以下の収集情報から求人票を生成してください。

会社名: ${companyName || "（未指定）"}
職種: ${jobTitle || "（未指定）"}
給与: ${salary || "（未指定）"}

【収集した企業・求人情報】
${context}

注意: 上記の情報を最大限活用し、8セクション構成で詳細な求人票を生成してください。`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: GENERATION_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 4000,
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error("AI応答が空です");

    const jobData = JSON.parse(content);

    // ユーザー入力値で上書き
    if (companyName) jobData.companyName = companyName;
    if (jobTitle) jobData.jobTitle = jobTitle;
    jobData.companyName = jobData.companyName || "";
    jobData.jobTitle = jobData.jobTitle || "";

    if (salary) {
      jobData.salary = jobData.salary || {};
      jobData.salary["基本給"] = salary;
    }

    // セクションの正規化
    const requiredSections = [
      "basicInfo", "companyInfo", "jobContent", "requirements",
      "salary", "workConditions", "holidays", "benefits",
    ];
    for (const section of requiredSections) {
      if (!jobData[section] || typeof jobData[section] !== "object" || Array.isArray(jobData[section])) {
        jobData[section] = {};
      }
    }

    jobData.sources = sources.length > 0
      ? sources
      : [`${companyName} 公式採用ページ（Web検索）`];

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
