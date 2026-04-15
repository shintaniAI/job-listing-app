import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";
export const maxDuration = 60;

function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY が設定されていません");
  return new OpenAI({ apiKey });
}

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

function buildResearchPrompt(
  companyName: string,
  companyUrl: string,
  jobTitle: string
): string {
  const blocked = BLOCKED_SITES.map((s) => `  - ${s}`).join("\n");

  if (companyUrl) {
    return [
      "以下のURLにアクセスして、ページに書かれている採用・求人情報を一切省略せず全文抽出してください。",
      "",
      `対象URL: ${companyUrl}`,
      companyName ? `企業名: ${companyName}` : "",
      jobTitle ? `注目職種: ${jobTitle}` : "",
      "",
      "【絶対厳守】以下の求人媒体サイトは一切参照しないでください。上記URLと企業公式ページのみを情報源としてください：",
      blocked,
      "",
      "【抽出してほしい情報（全て原文のまま詳細に・要約禁止）】",
      "- 企業情報: ミッション・ビジョン・バリュー、代表メッセージ、事業内容（全事業・全サービス）、設立年月、従業員数、資本金、本社所在地、拠点",
      "- カルチャー・社風・働く環境・社員の特徴",
      "- 募集職種・雇用形態・試用期間（期間中の条件変化含む）",
      "- 仕事内容（業務内容を箇条書きで**全て**列挙。業務の流れ、一日のスケジュール例、担当領域、裁量範囲なども含む）",
      "- 配属部署・チーム構成・上司・メンバー",
      "- キャリアパス・昇進・昇格の仕組み",
      "- 応募資格（必須条件・歓迎条件・求める人物像・年齢・学歴）",
      "- 給与・年収: 月額・年収レンジ・固定残業代（時間と金額）・想定モデル年収",
      "- 昇給（頻度）・賞与（頻度と実績）",
      "- 勤務地・住所・最寄り駅（徒歩分数まで）・リモート/サテライト選択の有無",
      "- 勤務時間・フレックス・コアタイム・標準労働時間",
      "- 残業時間（月平均・実績値）",
      "- 休日・休暇（完全週休2日制の詳細・年間休日数・有給・特別休暇・慶弔休暇・誕生日休暇など全種類）",
      "- 福利厚生: 健康関連、食事関連、住宅関連、育児介護、スキルアップ支援、社員旅行、レクリエーション、その他独自制度**すべて**",
      "- 社会保険（健康保険・厚生年金・雇用保険・労災）",
      "- 選考フロー・面接回数・選考期間",
      "",
      "【禁止事項】",
      "- 要約・箇条書きの省略・言い換え",
      "- 「〜など」で情報を端折る（全項目を書き出す）",
      "- 創作・推測（書かれていない情報の補完）",
      "",
      "取得した情報は原文の密度・語彙をそのまま保持し、箇条書き項目は全て転記してください。数値・固有名詞・制度名は原文通りに。",
    ].join("\n");
  }

  // URL未指定の場合：公式採用プラットフォームを指定検索
  return [
    `「${companyName}」の公式採用情報を以下の手順で調査してください。`,
    jobTitle ? `特に「${jobTitle}」職種の情報を優先的に収集してください。` : "",
    "",
    "【検索クエリ（この順番で試してください）】",
    `1. site:open.talentio.com "${companyName}"`,
    `2. site:talentio.com "${companyName}"`,
    `3. site:wantedly.com "${companyName}"`,
    `4. site:hrmos.co "${companyName}"`,
    `5. "${companyName}" 採用サイト`,
    "",
    "【絶対厳守】以下の求人媒体サイトは検索結果に出てきても無視し、絶対に参照しないでください：",
    blocked,
    "",
    "企業公式サイトや採用プラットフォーム（Talentio・Wantedly・HRMOS等）のページのみにアクセスしてください。",
    "",
    "【アクセスしたページから全て抽出してほしい情報】",
    "- 企業情報: ミッション・ビジョン・バリュー、事業内容、設立年、従業員数、資本金、本社所在地",
    "- 募集職種・雇用形態・試用期間",
    "- 仕事内容（業務内容を箇条書きで、できるだけ多く）",
    "- 応募資格（必須条件・歓迎条件・求める人物像）",
    "- 給与・年収（具体的な数値: 月額・年収・固定残業代等）",
    "- 昇給・賞与",
    "- 勤務地・住所・最寄り駅",
    "- 勤務時間・フレックス・コアタイム",
    "- 残業時間（月平均）",
    "- 休日・休暇（年間休日数・有給・特別休暇等）",
    "- 福利厚生（全項目）",
    "- 社会保険",
    "- リモートワーク・テレワーク制度",
    "",
    "取得した情報は要約・省略せず、原文に近い形でそのまま出力してください。数値は必ず具体的に記載してください。",
  ].join("\n");
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
                const isBlocked = BLOCKED_SITES.some((blocked) =>
                  annotation.url.includes(blocked)
                );
                if (!isBlocked && !sources.includes(annotation.url)) {
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

const GENERATION_SYSTEM_PROMPT = `あなたは求人票作成の専門家です。企業の公式採用ページから収集した情報を基に、採用ページと同等レベルに充実した求人票を作成してください。

【最重要】採用ホームページに書かれている情報は**一切省略せず全て**求人票に反映してください。箇条書きは全項目を残し、数値・固有名詞は原文通りに転記してください。

【必須要件】
- 出力は必ず8つのセクションに分ける（基本情報、企業情報、仕事内容、応募資格、給与・報酬、勤務条件、休日・休暇、福利厚生・待遇）
- 下記JSON形式はあくまで**最低限の雛形**。収集情報にあれば**追加キーを自由に追加して良い**（例: "海外出張", "部署規模", "選考フロー", "面接回数", "代表メッセージ" など）
- 各業務内容・福利厚生項目は**収集情報に出てくる全項目**を列挙する（5個で足りなければ10個でも20個でもOK）
- 「詳細は面接時」「要相談」のみの曖昧な記載は避け、具体的な数値・固有名詞・制度名を必ず記載する
- 企業のMVV・事業内容・代表メッセージ・カルチャー・働く環境なども積極的に含める

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
- 外部ソースに記載されている情報は**漏れなく**活用する（要約NG、原文に近い密度で転記）
- 情報がない項目は "情報なし" という文字列を値に入れる（空文字列ではなく "情報なし"）。フロント側でPDF生成時に自動で非表示にする
- 具体的な数値がある場合は必ず記載する（年収400万～840万円、年間休日120日、残業月平均20時間など）
- MVV（ミッション・ビジョン・バリュー）は企業情報セクションに含める
- 業務内容・福利厚生は収集情報に出てくる**全項目**を列挙する（雛形の個数に縛られない）
- 文字数は1項目あたり20〜300文字を目安に、固有名詞や具体例を含めて記述する`;

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

    // Step 1: 公式採用ページを web_search でリサーチ
    console.log(`リサーチ開始 | URL: ${companyUrl || "なし"} | 会社名: ${companyName}`);
    const researchPrompt = buildResearchPrompt(companyName, companyUrl, jobTitle);

    const research = await openai.responses.create({
      model: "gpt-4o",
      tools: [{ type: "web_search", search_context_size: "high" } as any],
      input: researchPrompt,
    });

    const context = research.output_text || "";
    const sources = extractSources(research);

    console.log(`リサーチ完了: ${context.length}文字, ソース${sources.length}件`);
    console.log("参照ソース:", sources);

    if (!context || context.length < 200) {
      throw new Error(
        "企業情報の収集に失敗しました。\n採用ページのURLを直接入力すると精度が上がります（例: https://open.talentio.com/...）"
      );
    }

    // Step 2: 収集情報をもとに構造化された求人票を生成
    console.log("求人票を生成中...");
    const userPrompt = [
      "以下の収集情報から求人票を生成してください。",
      "",
      `会社名: ${companyName || "（未指定）"}`,
      `職種: ${jobTitle || "（未指定）"}`,
      `給与: ${salary || "（未指定）"}`,
      "",
      "【収集した企業・求人情報（公式採用ページより）】",
      context,
      "",
      "注意: 上記の情報を最大限活用し、8セクション構成で詳細な求人票を生成してください。",
    ].join("\n");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: GENERATION_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 8000,
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
      if (
        !jobData[section] ||
        typeof jobData[section] !== "object" ||
        Array.isArray(jobData[section])
      ) {
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
