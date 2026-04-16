import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

export const runtime = "nodejs";
export const maxDuration = 60;

// 求人媒体（補助ソース: 公式採用ページ/HPが無い時の参照先として活用）
// ATS/公式HPより優先度は低いが、ソースとして排除はしない
const SECONDARY_JOB_SITES = [
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

// Jina Reader: HTMLフォーマットで取得（SPAで描画されるリンク/属性を拾う用。本文取得には使わない）
async function fetchJinaReaderHtml(url: string, timeoutMs = 8000): Promise<string> {
  const target = `https://r.jina.ai/${url}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(target, {
      method: "GET",
      headers: {
        Accept: "text/html",
        "X-Return-Format": "html",
      },
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Jina(html)取得失敗: ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// Talentio の homes/XXX や /c/{slug}/ (ATS企業ルート) の HTML版から
// 個別求人リンク (homes/XXX, pages/XXXXX 等) を抽出する。
// markdown版はSPAレンダリング済みテキストだけになるので data-link-url / publishedUrl は消えている。
async function extractAtsLinksFromPage(pageUrl: string, timeoutMs = 7000): Promise<string[]> {
  try {
    const html = await fetchJinaReaderHtml(pageUrl, timeoutMs);
    const out = new Set<string>();
    // homes/XXX と pages/XXX の両方を拾う（ATSルートから homes→pages 多段で辿るため）
    const patterns = [
      /data-link-url="([^"]*\/(?:pages|homes)\/\d+[^"]*)"/g,
      /"publishedUrl"\s*:\s*"([^"]*\/(?:pages|homes)\/\d+[^"]*)"/g,
      /href="([^"]*\/(?:pages|homes)\/\d+[^"]*)"/g,
      /"url"\s*:\s*"([^"]*\/(?:pages|homes)\/\d+[^"]*)"/g,
    ];
    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(html))) {
        let u = m[1].replace(/\\\//g, "/");
        // 相対URLは絶対化
        if (u.startsWith("/")) {
          try {
            const base = new URL(pageUrl);
            u = `${base.origin}${u}`;
          } catch { continue; }
        }
        if (/open\.talentio\.com|hrmos\.co/.test(u)) {
          if (!/\/apply\/?$/.test(u) && !/\/form\/?$/.test(u)) out.add(u);
        }
      }
    }
    return [...out];
  } catch {
    return [];
  }
}

// 後方互換エイリアス
const extractPagesUrlsFromAtsHome = extractAtsLinksFromPage;

// 求人媒体判定（排除ではなく優先度調整用）
function isSecondaryJobSite(url: string): boolean {
  const lower = url.toLowerCase();
  return SECONDARY_JOB_SITES.some((b) => lower.includes(b));
}

// カタカナ(と長音・促音)をヘボン式ローマ字に変換する簡易コンバータ
// Geminiのカタカナ→ローマ字推測は不安定なので(オリゾ→gikou等)、プログラムで直接変換する。
function katakanaToRomaji(text: string): string {
  const map: Record<string, string> = {
    ア:"a",イ:"i",ウ:"u",エ:"e",オ:"o",
    カ:"ka",キ:"ki",ク:"ku",ケ:"ke",コ:"ko",
    ガ:"ga",ギ:"gi",グ:"gu",ゲ:"ge",ゴ:"go",
    サ:"sa",シ:"shi",ス:"su",セ:"se",ソ:"so",
    ザ:"za",ジ:"ji",ズ:"zu",ゼ:"ze",ゾ:"zo",
    タ:"ta",チ:"chi",ツ:"tsu",テ:"te",ト:"to",
    ダ:"da",ヂ:"ji",ヅ:"zu",デ:"de",ド:"do",
    ナ:"na",ニ:"ni",ヌ:"nu",ネ:"ne",ノ:"no",
    ハ:"ha",ヒ:"hi",フ:"fu",ヘ:"he",ホ:"ho",
    バ:"ba",ビ:"bi",ブ:"bu",ベ:"be",ボ:"bo",
    パ:"pa",ピ:"pi",プ:"pu",ペ:"pe",ポ:"po",
    マ:"ma",ミ:"mi",ム:"mu",メ:"me",モ:"mo",
    ヤ:"ya",ユ:"yu",ヨ:"yo",
    ラ:"ra",リ:"ri",ル:"ru",レ:"re",ロ:"ro",
    ワ:"wa",ヲ:"wo",ン:"n",
    ヴ:"vu",
  };
  // 小書き(拗音)は直前に連結して処理
  const smallY: Record<string, string> = { ャ:"ya", ュ:"yu", ョ:"yo" };
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    // 促音(ッ) → 次文字の子音を重ねる
    if (c === "ッ" && next && map[next]) {
      const r = map[next];
      out += r[0];
      continue;
    }
    // 長音(ー) → 前の母音を繰り返す
    if (c === "ー" && out.length > 0) {
      const last = out[out.length - 1];
      if (/[aeiou]/.test(last)) out += last;
      continue;
    }
    if (map[c] && smallY[next]) {
      const r = map[c]; // 例: キ→"ki"
      // きゃ→kya, しゃ→sha, ちゃ→cha
      if (r.endsWith("i")) {
        const stem = r.slice(0, -1);
        out += stem + smallY[next];
      } else {
        out += r + smallY[next];
      }
      i++;
      continue;
    }
    if (map[c]) {
      out += map[c];
      continue;
    }
    // その他(英数・記号等)はそのまま残す(後段で処理)
    out += c;
  }
  return out;
}

// 会社名から、スラッグとして有効そうなローマ字候補を返す
// 例: "株式会社オリゾ" → ["orizo"]、"株式会社 Luup" → ["luup"]
function companyNameRomajiCandidates(companyName: string): string[] {
  if (!companyName) return [];
  const out = new Set<string>();
  const stripped = companyName
    .replace(/株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|学校法人|医療法人|社会福祉法人|特定非営利活動法人|ＮＰＯ法人|NPO法人/g, "")
    .replace(/（株）|\(株\)|（有）|\(有\)/g, "")
    .replace(/,?\s*(Inc|Corp|Corporation|Co\.?,?\s*Ltd\.?|Ltd\.?|LLC|K\.K\.)\.?/gi, "")
    .trim();
  // 既に半角英字主体ならそのまま小文字化
  if (/^[A-Za-z0-9\-_\s]+$/.test(stripped)) {
    out.add(stripped.toLowerCase().replace(/\s+/g, ""));
  }
  // カタカナ主体ならローマ字化
  if (/[\u30A0-\u30FF]/.test(stripped)) {
    const r = katakanaToRomaji(stripped).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (r.length >= 2) out.add(r);
  }
  // スペースや中点で分割して各パートも候補に
  for (const part of stripped.split(/[\s・／/]+/)) {
    if (/^[A-Za-z0-9\-_]+$/.test(part)) out.add(part.toLowerCase());
    else if (/[\u30A0-\u30FF]/.test(part)) {
      const r = katakanaToRomaji(part).toLowerCase().replace(/[^a-z0-9]/g, "");
      if (r.length >= 2) out.add(r);
    }
  }
  return [...out];
}

// 会社名から「株式会社」等の法人格修飾子を除去した核トークンを抽出
function companyNameTokens(companyName: string): string[] {
  if (!companyName) return [];
  const stripped = companyName
    .replace(/株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|学校法人|医療法人|社会福祉法人|特定非営利活動法人|ＮＰＯ法人|NPO法人/g, "")
    .replace(/（株）|\(株\)|（有）|\(有\)/g, "")
    .replace(/,?\s*(Inc|Corp|Corporation|Co\.?,?\s*Ltd\.?|Ltd\.?|LLC|K\.K\.)\.?/gi, "")
    .trim();
  const tokens = new Set<string>();
  if (stripped && stripped.length >= 2) tokens.add(stripped.toLowerCase());
  if (companyName.trim().length >= 2) tokens.add(companyName.trim().toLowerCase());
  // スペース・中点区切りの部分語も登録
  for (const part of stripped.split(/[\s・／/]+/)) {
    if (part.length >= 3) tokens.add(part.toLowerCase());
  }
  return [...tokens];
}

// Jina取得テキストが対象会社のものか判定（会社名のどれかを含めばOK）
function textMentionsCompany(text: string, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const lower = text.toLowerCase();
  return tokens.some((t) => lower.includes(t));
}

function isJobDetailUrl(url: string): boolean {
  return JOB_DETAIL_PATTERNS.some((p) => p.test(url));
}

function isPreferredHost(url: string): boolean {
  const lower = url.toLowerCase();
  return PREFERRED_HOSTS.some((h) => lower.includes(h));
}

// 既知の採用管理サービス(ATS)のホスト。/recruit/ 等のパス断片は含めない厳格判定。
const KNOWN_ATS_HOSTS = [
  "open.talentio.com",
  "talentio.com",
  "hrmos.co",
  "herp.careers",
  "wantedly.com",
];
function isKnownAtsHost(url: string): boolean {
  try {
    const h = new URL(url).host.toLowerCase();
    return KNOWN_ATS_HOSTS.some((x) => h === x || h.endsWith("." + x) || h === "www." + x);
  } catch {
    return false;
  }
}

// ATS企業ルート ( /homes/XXX や /pages/XXX を含まない ) URL か判定。
// これらは Jina markdown ではSPA未描画となるため、HTML抽出でリンクを辿る必要がある。
function isAtsCompanyRootUrl(url: string): boolean {
  // Talentio: /r/{N}/c/{slug}/  (/homes, /pages 無し)
  if (/^https?:\/\/open\.talentio\.com\/r\/[^/]+\/c\/[^/]+\/?$/i.test(url)) return true;
  if (/^https?:\/\/open\.talentio\.com\/r\/[^/]+\/c\/[^/]+\/homes\/\d+\/?$/i.test(url)) return true;
  // HRMOS: /pages/{slug}  (/jobs/NNN 無し)
  if (/^https?:\/\/hrmos\.co\/pages\/[^/]+\/?$/i.test(url)) return true;
  // Wantedly: /companies/{slug}  (/projects/NNN 無し)
  if (/^https?:\/\/(www\.)?wantedly\.com\/companies\/[^/]+\/?$/i.test(url)) return true;
  return false;
}

// ATSホスト上のURLが「企業固有ページ」か判定。
// 例: open.talentio.com/r/1/c/orizo/ → true, open.talentio.com/ → false,
// hrmos.co/terms/ → false, atsguide.hrmos.co/hc/... → false
// これを満たさない ATS URL は会社特定に使えないので選定から除外する。
function extractAtsCompanySlug(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.host.toLowerCase();
    const p = u.pathname;
    if (host.endsWith("talentio.com")) {
      const m = p.match(/^\/r\/[^/]+\/c\/([^/]+)/);
      if (m) return m[1].toLowerCase();
    }
    if (host === "hrmos.co") {
      // 会社非依存パスを除外: /terms/, /privacy/, /help/, /login/, /signup/ 等
      if (/^\/(terms|privacy|help|login|signup|about|faq|agreement|contact|guide)(\/|$)/i.test(p)) return null;
      const m = p.match(/^\/pages\/([^/]+)/);
      if (m) return m[1].toLowerCase();
    }
    if (host === "wantedly.com" || host === "www.wantedly.com") {
      const m = p.match(/^\/companies\/([^/]+)/);
      if (m) return m[1].toLowerCase();
    }
    if (host.endsWith("herp.careers")) {
      const m = p.match(/^\/v\d+\/([^/]+)/);
      if (m) return m[1].toLowerCase();
    }
    return null;
  } catch {
    return null;
  }
}

// ATSホストのURLが「会社特定可能」(=企業スラッグを持つ) か
function isAtsUrlCompanySpecific(url: string): boolean {
  return extractAtsCompanySlug(url) !== null;
}

// ATSホスト上の明らかに会社非依存なURLを除外
// (ルート、ヘルプ、利用規約、関連サブドメインなど)
function isUselessAtsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.host.toLowerCase();
    if (!isKnownAtsHost(url)) return false;
    const p = u.pathname;
    // ルート or パス無し
    if (p === "" || p === "/") return true;
    // 会社非依存のサブドメイン (例: atsguide.hrmos.co)
    if (/^atsguide\.hrmos\.co$/i.test(host)) return true;
    // ATSホスト上のgeneralパス
    if (/^\/(terms|privacy|help|login|signup|about|faq|agreement|contact|guide)(\/|$)/i.test(p)) return true;
    // 会社スラッグが抽出できないATS URLは(会社特定不能なので)除外
    if (!isAtsUrlCompanySpecific(url)) return true;
    return false;
  } catch {
    return false;
  }
}

// ATSページ全般(ルート/一覧/詳細いずれも): HTML抽出で追加URLを発掘する価値がある
function shouldHtmlExtractAts(url: string): boolean {
  if (!isKnownAtsHost(url)) return false;
  // pages/XXX 詳細ページからも関連求人リンクを拾えるが、ノイズも多いのでルート/homes のみ対象
  if (isAtsCompanyRootUrl(url)) return true;
  return false;
}

// URLを優先度でソート: 求人詳細 > 公式採用媒体(ATS/HP) > 求人媒体(Indeed等) > その他
function sortByPriority(urls: string[]): string[] {
  const rank = (u: string): number => {
    if (isJobDetailUrl(u)) return 0;
    if (isPreferredHost(u)) return 1;
    if (isSecondaryJobSite(u)) return 2;
    return 3;
  };
  return [...urls].sort((a, b) => rank(a) - rank(b));
}

// www./非www./末尾スラッシュ違いを正規化（同一ページのURL変種を束ねるため）
function normalizeUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/i, "https://").toLowerCase().replace(/\/+$/, "");
}
function dedupeUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    const n = normalizeUrl(u);
    if (!seen.has(n)) {
      seen.add(n);
      out.push(u);
    }
  }
  return out;
}

// 会社公式サイトのホーム(パス無し or "/")か判定
function isCompanyHomepage(url: string): boolean {
  try {
    const p = new URL(url).pathname;
    return p === "" || p === "/";
  } catch {
    return false;
  }
}

// 優先度を考慮しつつ各層に枠を確保する取得対象選定。
// 順序: (1) 求人詳細/ATS既知ホスト → (2) 求人媒体(Indeed/doda等) → (3) 会社HPホーム → (4) その他
// Gemini guess が hrmos.co/ や open.talentio.com/ のような会社非依存URLを混ぜることもあるので、
// ATSホストでも企業スラッグを持たないURLは除外する。
function pickFetchCandidates(urls: string[], max: number): string[] {
  // まず明らかに使えないATS URLを全体から除外
  const usable = urls.filter((u) => !isUselessAtsUrl(u));
  const sorted = sortByPriority(usable);
  const pAts = sorted.filter((u) => isJobDetailUrl(u) || isKnownAtsHost(u));
  const pMedia = sorted.filter((u) => !pAts.includes(u) && isSecondaryJobSite(u));
  const pHome = sorted.filter((u) => !pAts.includes(u) && !pMedia.includes(u) && isCompanyHomepage(u));
  const pOther = sorted.filter((u) => !pAts.includes(u) && !pMedia.includes(u) && !pHome.includes(u));

  const picked: string[] = [];
  const pushUnique = (u: string) => { if (!picked.includes(u)) picked.push(u); };
  for (const u of pAts.slice(0, 4)) pushUnique(u);
  for (const u of pMedia.slice(0, 3)) pushUnique(u);
  for (const u of pHome.slice(0, 2)) pushUnique(u);
  for (const u of pOther.slice(0, 2)) pushUnique(u);
  return picked.slice(0, max);
}

// URLとして有効な行を抽出（末尾の句読点は除去、スキーム無しは補完）
function extractUrls(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  // 複数URLが同一行にある可能性も拾う
  const re = /(https?:\/\/[^\s、。」）)\]'"<>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let u = m[1].replace(/[.,)、。」]+$/, "");
    out.add(u);
  }
  return [...out];
}

// 取得済みJina本文（マークダウン）から、ATS/採用系URLを抽出
// 例: orizo.co.jp の本文に [RECRUIT](https://open.talentio.com/r/1/c/orizo/homes/4235) があれば拾う
function extractRecruitmentLinksFromContent(text: string): string[] {
  const urls = extractUrls(text);
  // 画像・CSS・JSなど静的アセットを除外
  return urls.filter((u) => {
    if (/\.(png|jpg|jpeg|gif|svg|webp|ico|css|js|woff2?|ttf|eot|pdf)(\?|#|$)/i.test(u)) return false;
    // ATS/採用系ホストを優先
    return isPreferredHost(u) || isJobDetailUrl(u);
  });
}

// プログラム生成: ローマ字スラッグ候補から HP/ATS の具体URLを機械的に組み立てる
// Gemini のローマ字幻覚(オリゾ→gikou)を回避するため、カタカナ直変換した確実な候補を先に入れる。
function buildDeterministicCandidateUrls(companyName: string): string[] {
  const slugs = companyNameRomajiCandidates(companyName);
  const out: string[] = [];
  for (const s of slugs) {
    if (s.length < 2) continue;
    // HP (.co.jp / .com / .jp)
    out.push(`https://${s}.co.jp/`);
    out.push(`https://www.${s}.co.jp/`);
    out.push(`https://${s}.com/`);
    out.push(`https://${s}.jp/`);
    // ATS
    out.push(`https://open.talentio.com/r/1/c/${s}/`);
    out.push(`https://hrmos.co/pages/${s}`);
    out.push(`https://www.wantedly.com/companies/${s}`);
  }
  return out;
}

// フォールバック: Groundingを使わず知識ベースで具体URL推測（高速）
// ATS URL (Talentio/HRMOS/Wantedly) はスラッグの幻覚を起こしやすい (オリゾ→gikou等) ため
// ここでは HP 系のみ推測させ、ATS は grounded 側に任せる。
async function guessUrlsWithoutGrounding(
  ai: GoogleGenAI,
  companyName: string
): Promise<{ urls: string[]; usage: any }> {
  const prompt = [
    `「${companyName}」の以下URLを推測してください。プレースホルダ({slug}等)を残さず、実在しそうな具体値に埋めてください。`,
    "",
    "【重要: ローマ字化のルール】",
    "- 会社名がカタカナ(例「オリゾ」)なら、そのカタカナをヘボン式で直接ローマ字化する (オリゾ→orizo)",
    "- 漢字の音読み/訓読みを当てずっぽうで推測しない (オリゾを儀工/義工として『gikou』と読み替える等はNG)",
    "- 会社名が漢字なら一般的な訓読み/音読みのローマ字化を試し、自信が無ければそのURLは出さない",
    "",
    "【出して欲しい項目 (HP系のみ)】",
    "1. 公式ウェブサイトのホームURL (例: https://<ローマ字ドメイン>.co.jp/ や .com/)",
    "2. 公式サイトの採用ページ (/careers/ /recruit/ /company/careers/ など)",
    "3. 公式サイトの会社概要ページ (/company/ /about/ など)",
    "",
    "※ Talentio/HRMOS/Wantedly等のATSページは推測しない（スラッグ幻覚防止のため）。これらは検索で探す。",
    "※ プレースホルダ({slug}, XXX等)を残したURLは絶対禁止。",
    "※ 自信が無い場合は項目を出さなくて良い（空出力OK）。",
    "",
    "出力: URLのみ1行ずつ、最大5件。説明・番号・記号なし。",
  ].join("\n");

  try {
    const result = await withTimeout(
      ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: { temperature: 0, maxOutputTokens: 400, thinkingConfig: { thinkingBudget: 0 } } as any,
      }),
      7000,
      "Gemini(URL推測)"
    );
    const urls = extractUrls(result.text || "")
      .filter((u) => !/\{[a-z_-]+\}/i.test(u)) // プレースホルダが残っているものは捨てる
      .filter((u) => !isKnownAtsHost(u)) // ATS URL は推測しない方針（プロンプトで禁じてるが念押し）
      .slice(0, 5);
    return { urls, usage: (result as any).usageMetadata || {} };
  } catch (e: any) {
    console.log(`[search] 知識ベース推測失敗: ${e.message}`);
    return { urls: [], usage: {} };
  }
}

// 1本のGrounded検索を実行してURLを抽出（失敗時は空配列）
async function runGroundedSearch(
  ai: GoogleGenAI,
  prompt: string,
  timeoutMs: number,
  label: string
): Promise<{ urls: string[]; usage: any; debug: any }> {
  try {
    const result = await withTimeout(
      ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: { tools: [{ googleSearch: {} }], temperature: 0 },
      }),
      timeoutMs,
      `Gemini(${label})`
    );
    const text = result.text || "";
    const direct = extractUrls(text);

    const grounded: string[] = [];
    const searchQueries: string[] = [];
    try {
      const candidates: any[] = (result as any).candidates || [];
      for (const c of candidates) {
        const meta = c?.groundingMetadata || {};
        const chunks = meta.groundingChunks || [];
        for (const ch of chunks) {
          const u = ch?.web?.uri;
          if (u && /^https?:\/\//.test(u)) grounded.push(u);
        }
        if (Array.isArray(meta.webSearchQueries)) {
          for (const q of meta.webSearchQueries) if (typeof q === "string") searchQueries.push(q);
        }
      }
    } catch {}

    const merged = Array.from(new Set([...direct, ...grounded]));
    console.log(`[search] ${label} 抽出: 本文${direct.length} + grounding${grounded.length} → 計${merged.length}件`);
    return {
      urls: merged,
      usage: (result as any).usageMetadata || {},
      debug: {
        label,
        textSample: text.slice(0, 400),
        textUrls: direct,
        groundingUrls: grounded,
        searchQueries,
      },
    };
  } catch (e: any) {
    console.log(`[search] ${label} 失敗: ${e.message}`);
    return { urls: [], usage: {}, debug: { label, error: e.message } };
  }
}

// ---------- Gemini + Google Search で公式採用URLを探す（複線検索） ----------
// A) ATS詳細ページ検索（Talentio/HRMOS/Wantedly/Herp の個別求人URL）
// B) 企業サイト検索（公式採用TOP、会社概要、MVV、福利厚生）
// C) 知識ベース推測（Groundingで拾えない場合の保険として常時併走）
async function findOfficialUrlWithGemini(
  ai: GoogleGenAI,
  companyName: string,
  jobTitle: string
): Promise<{ urls: string[]; usage: any }> {
  const jobClause = jobTitle ? `特に「${jobTitle}」の個別求人ページがあれば最優先。` : "";

  const broadPrompt = [
    `対象企業: 「${companyName}」(この企業名と完全一致する会社のみ対象)`,
    "",
    `Google検索でこの会社の公式URL群を見つけてください。${jobClause}`,
    "",
    "【絶対遵守】",
    `- 社名が「${companyName}」と完全一致する企業のURLのみ出力する`,
    "- 似た社名、違う会社、関連しない会社のURLは絶対に含めない",
    "- 検索結果が無い/自信が無い場合は空出力する（間違ったURLを返すより空の方が良い）",
    "",
    "【検索ヒント：これらのクエリを内部で試してOK】",
    `- "${companyName}" 公式サイト`,
    `- "${companyName}" 採用 OR recruit OR careers`,
    `- "${companyName}" site:talentio.com OR site:hrmos.co OR site:wantedly.com`,
    `- "${companyName}" 会社概要 事業内容`,
    "",
    "【出力したいURL（優先度順）】",
    "- 求人詳細ページ（Talentio/HRMOS/Wantedly/Herpの個別URL＝最優先）",
    "- 会社公式サイト（ホーム・採用・会社概要・MVV）",
    "- 求人媒体の該当企業ページ（Indeed/doda/マイナビ転職/リクナビNEXT/エン転職/Green/type/ビズリーチ等）も補助ソースとして出してよい",
    "",
    "見つけたURLを全てhttps://付きで1行ずつ出力（最大12件）。説明・番号・記号不要。",
  ].join("\n");

  const [groundRes, guessRes] = await Promise.all([
    runGroundedSearch(ai, broadPrompt, 15000, "公式URL検索"),
    guessUrlsWithoutGrounding(ai, companyName).catch(() => ({
      urls: [] as string[],
      usage: {},
    })),
  ]);

  // プログラム生成候補: カタカナ→ローマ字で確実なスラッグを作る
  const deterministicUrls = buildDeterministicCandidateUrls(companyName);

  // ATS URL のスラッグ妥当性チェック: 会社名から生成したローマ字候補と一致するもののみ許可
  // (gikou 等の hallucinated スラッグを弾く)
  const slugCandidates = companyNameRomajiCandidates(companyName);
  const isPlausibleAtsSlug = (url: string): boolean => {
    const slug = extractAtsCompanySlug(url);
    if (!slug) return true; // ATSじゃない or slug抽出失敗時は通す (別の検証でフィルタ)
    if (slugCandidates.length === 0) return true; // 会社名がローマ字化できない → 判定保留
    // 会社名のローマ字候補のいずれかを含む/含まれる、または完全一致
    return slugCandidates.some((s) =>
      slug === s || slug.includes(s) || s.includes(slug)
    );
  };

  const filteredGrounded = groundRes.urls.filter((u) => !isKnownAtsHost(u) || isPlausibleAtsSlug(u));
  const filteredGuess = guessRes.urls.filter((u) => !isKnownAtsHost(u) || isPlausibleAtsSlug(u));

  const merged = dedupeUrls(Array.from(
    new Set([...filteredGrounded, ...filteredGuess, ...deterministicUrls])
  ));
  const sorted = sortByPriority(merged);
  console.log(
    `[search] grounded:${groundRes.urls.length}(有効${filteredGrounded.length}) 推測:${guessRes.urls.length}(有効${filteredGuess.length}) 機械生成:${deterministicUrls.length} → 統合${sorted.length}件`
  );
  console.log(`[search] ローマ字候補:`, slugCandidates);

  const usage = {
    promptTokenCount:
      (groundRes.usage?.promptTokenCount || 0) +
      ((guessRes as any).usage?.promptTokenCount || 0),
    candidatesTokenCount:
      (groundRes.usage?.candidatesTokenCount || 0) +
      ((guessRes as any).usage?.candidatesTokenCount || 0),
  };

  const debug = {
    grounded: (groundRes as any).debug,
    guessUrls: guessRes.urls,
  };

  return { urls: sorted.slice(0, 12), usage, debug } as any;
}

// ---------- 複数ポジション検出 ----------
async function detectPositionsWithGemini(
  ai: GoogleGenAI,
  sourceText: string,
  hasRecruitmentSource: boolean = true
): Promise<string[]> {
  const prompt = [
    "以下の採用ページテキストから、**実際に募集されている職種名**を全て抽出してください。",
    "",
    "【必ず除外するもの（職種ではない）】",
    "- 事業内容・事業領域・事業セグメント（例: 「広告事業」「美容医療支援事業」「クリエイティブ事業」）",
    "- サービス名・製品名・ブランド名",
    "- 業界名・分野名（例: 「IT業界」「マーケティング分野」）",
    "- 会社の強み・特徴・コンセプト",
    "- ミッション/ビジョン/バリュー関連の文言",
    "",
    "【職種として扱うもの】",
    "- 採用ページで「募集職種」「Job」「採用情報」などに列挙されている具体的な仕事名",
    "- 例: 「営業」「エンジニア」「デザイナー」「カスタマーサクセス」「一気通貫型ソリューション営業」など",
    "",
    "【ルール】",
    "- 同一ポジションの別名表記は統合（例: 「営業」と「ソリューション営業」が同一なら1つ）",
    "- 職種名は原文にあるものをそのまま使う",
    "- 該当が1つしか無い場合は1つだけ返す",
    "- **自信が持てない場合は空配列 [] を返す** (事業内容を職種と誤認するくらいなら返さない方が良い)",
    hasRecruitmentSource
      ? "- ソースに採用ページ(ATS等)が含まれている前提で抽出する"
      : "- **ソースは会社HPのみで採用ページ(ATS等)が含まれていない**。このため明確に募集職種と断定できるもの以外は返さない。事業名を職種と混同しないこと。",
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
- **最優先**: 「=== PRIMARY SOURCE (正本／...)」タグが付いたソースがあればそれを**正本**とし、原文の情報を漏らさず転記する。タグがない場合は先頭の「=== SOURCE URL: ...」を正本とみなす
- 「=== 補助ソース:」および2件目以降のSOURCE URLは、正本で欠けている項目を埋める用途のみに使う（正本を上書きしない）
- 原文の章見出し（「求人概要」「職務内容」「応募資格」「報酬」「諸手当」「休日・休暇」「福利厚生」「事業概要」「ミッション」「ビジョン」「バリュー」「カルチャー」等）を全てカバーする
- 数値・固有名詞・制度名・金額・時間帯・時間数は**原文通りに**転記（改変・丸め・言い換え禁止）
- 情報がない項目は値を空文字列 "" にする（"情報なし"等の文字列を入れない）
- 雛形にないキーは自由に追加してよい（原文にある情報は全部拾う）
- 値は必ず「文字列」（配列・ネストオブジェクト禁止）

【キー設計・値の書き方】
- **同一トピックは必ず1つのキーにまとめる**。"事業内容1","事業内容2"のように番号付きで分けない。代わりに"事業内容"というキーに複数行（改行区切り）で全て書く
- 複数の項目が列挙されているトピック（事業内容 / 必須要件 / 歓迎要件 / 主な業務内容 / 福利厚生の制度一覧 等）は、値の中で改行区切りの箇条書きにする。各行頭に「・」を付ける
- 個々の項目が長文（1文以上）なら文章としてそのまま書く。短い項目は箇条書きで1行1項目
- 解説文・メッセージ・カルチャー紹介などナラティブな情報は、番号や記号を付けず**そのまま文章**として転記
- **キー名は求人者(応募者)目線で見出しとして自然なもの**（例: "事業内容" "ミッション" "必須要件" "歓迎要件" "想定年収" "勤務地" "福利厚生"）。数字サフィックスは禁止
- 同種だが明確に別トピックの場合（例: 必須要件 と 歓迎要件）はキーを分ける。ただし番号ではなく意味で分ける

【文章化の指針】
- 求人者が読んで職務イメージ・待遇・会社の魅力が掴めるよう、**情報密度を保ったまま読みやすい文章**にする
- 原文の要素を削らない範囲で、接続詞や句読点を補って自然な読み物として機能させてよい（意味は変えない）
- **推測・創作・要約・短縮は完全禁止**。提供された原文（公式採用ページ・求人媒体含む）に書かれていないことは絶対に書かない／書かれていることを端折らない

【ソースの扱い】
- 求人媒体（Indeed/doda/マイナビ転職/リクナビNEXT/エン転職/Green/type/ビズリーチ等）もソースに含まれる場合は参照OK。ただし正本タグが付いた公式ページが最優先で、媒体の情報は正本で欠けている項目の補完に使う
- 原文が長い場合は値が長くなっても省略しない（読みやすさのため段落分けや改行は入れてよい）`;

// パートA: 企業全体情報
const PROMPT_COMPANY_PART = `あなたは採用ページ原文から求人票を作成する専門家です。与えられた**企業公式の採用ページ全文**から、**企業全体に関する情報**のみをJSONで出力してください。

${COMMON_RULES}

【出力セクション & 推奨キー（求人者目線で見やすい粒度）】
各セクションは「トピック名: 値」のマップ。値は原文を網羅した文章または改行区切り箇条書き。番号サフィックス(1,2,3...)は禁止。

# summary
- 企業・ポジションの魅力が2〜3文で伝わる要約文（原文の言葉で）

# basicInfo（基本情報）
推奨キー: 企業名 / 募集職種 / 雇用形態 / 募集人数 / 契約期間 / 試用期間 / 勤務開始日
- 各値は短い事実を1〜2行で

# companyInfo（企業情報）
推奨キー: 事業内容 / ミッション / ビジョン / バリュー / 行動指針 / 事業の特徴・強み / 今後の展望 / カルチャー / 社風 / 設立年月 / 従業員数 / 資本金 / 代表者 / 本社所在地 / 代表メッセージ / 沿革 / グループ会社
- 「事業内容」は列挙されている事業を全て1つの値にまとめる（改行区切り・先頭「・」の箇条書き、または文章）
- ミッション/ビジョン/バリューなどナラティブなものは原文の文章をそのまま
- カルチャー/社風は原文の説明文を網羅した読み物として転記

# holidays（休日・休暇）
推奨キー: 休日制度 / 年間休日数 / 有給休暇 / 特別休暇 / 長期休暇 / 育児休暇 / 介護休暇
- 「特別休暇」は夏季/年末年始/バースデー/慶弔/GW等を1つの値に改行区切りでまとめる

# benefits（福利厚生・待遇）
推奨キー: 社会保険 / 健康制度 / 食事・ドリンク補助 / リモート・在宅支援 / 通勤手当 / 住宅手当 / 家族手当 / 育児・介護支援 / 学習支援 / 独自制度 / 退職金 / 表彰制度 / 懇親会制度
- 同じカテゴリ内に複数制度がある場合は1つのキーに改行区切りでまとめる（「独自制度」の値に社員旅行/仮眠制度/慶弔金を並べる等）

【出力形式（JSONのみ、コードフェンス禁止）】
{
  "summary": "...",
  "basicInfo": { "企業名":"", "募集職種":"", ... },
  "companyInfo": { "事業内容":"", "ミッション":"", "ビジョン":"", "バリュー":"", "カルチャー":"", ... },
  "holidays": { "休日制度":"", "年間休日数":"", "特別休暇":"", ... },
  "benefits": { "社会保険":"", "学習支援":"", "独自制度":"", ... }
}`;

// パートB: ポジション固有情報
const PROMPT_POSITION_PART = `あなたは採用ページ原文から求人票を作成する専門家です。与えられた**企業公式の採用ページ全文**から、**ポジションの業務/条件**に関する情報のみをJSONで出力してください。

${COMMON_RULES}

【出力セクション & 推奨キー（求人者目線で見やすい粒度）】
各セクションは「トピック名: 値」のマップ。値は原文を網羅した文章または改行区切り箇条書き。番号サフィックス(1,2,3...)は禁止。

# jobContent（仕事内容）
推奨キー: 主な業務内容 / ポジションの特徴 / このポジションの魅力 / 得られるスキル・経験 / チーム構成 / 配属先 / 1日の流れ / 今後の活躍の場・キャリアパス / 使用ツール・技術スタック
- 「主な業務内容」は原文に列挙された業務を全て1つの値に改行区切り箇条書き（先頭「・」）でまとめる
- 「得られるスキル・経験」も同様に複数項目を1つの値にまとめる
- ポジションの特徴・魅力は原文の文章をそのまま転記

# requirements（応募資格）
推奨キー: 必須要件 / 歓迎要件 / 求める人材 / 年齢 / 学歴
- 「必須要件」は原文の必須項目を全て1つの値に改行区切り箇条書きでまとめる
- 「歓迎要件」「求める人材」も同様に1キーに集約

# salary（給与・報酬）
推奨キー: 想定年収 / 賃金形態 / 基本給 / 月給 / 年俸月額 / 所定内給与 / 固定時間外手当 / 固定深夜手当 / 通勤手当 / 残業手当 / 諸手当 / 給与改定 / 賞与 / 給与モデル例
- 「諸手当」は複数ある場合1つの値に改行区切りでまとめる
- 固定時間外/深夜手当は金額・時間数・時間帯を1つの値に詳細記述

# workConditions（勤務条件）
推奨キー: 勤務地 / 勤務地住所 / 最寄り駅 / 勤務時間 / 所定労働時間 / フレックス / コアタイム / 清算期間 / 休憩時間 / リモートワーク / 残業 / 試用期間 / 転勤 / 副業 / 服装
- 勤務地が複数拠点ある場合は1つの値に改行区切りでまとめる
- 休憩時間は原文の細則（例: 12:00-13:00 + 15:00-15:15）を1つの値に詳細転記

【出力形式（JSONのみ、コードフェンス禁止）】
{
  "jobContent": { "主な業務内容":"", "得られるスキル・経験":"", ... },
  "requirements": { "必須要件":"", "歓迎要件":"", "求める人材":"", ... },
  "salary": { "想定年収":"", "年俸月額":"", "固定時間外手当":"", "諸手当":"", ... },
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
    22000,
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
    22000,
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
    let searchDebug: any = null;

    if (companyUrl && /^https?:\/\//.test(companyUrl)) {
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
          searchDebug = (more as any).debug || null;
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
      searchDebug = (r as any).debug || null;
      if (targetUrls.length === 0) {
        return NextResponse.json(
          {
            error: "公式採用ページのURLが見つかりませんでした。採用ページURLを直接入力してください。",
            _diag: searchDebug,
          },
          { status: 500 }
        );
      }
      console.log(`[search] 候補URL: ${targetUrls.length}件`);
    } else {
      return NextResponse.json(
        { error: "会社名または採用ページURLを入力してください" },
        { status: 400 }
      );
    }

    // www/非www/末尾スラッシュ違いの変種を統合
    targetUrls = dedupeUrls(targetUrls);
    // 優先度順にソート
    targetUrls = sortByPriority(targetUrls);
    console.log(`[search] ソート後URL:`, targetUrls);

    // Step 2: Jina Reader で優先度バランスを取って最大7件を並列取得
    // ATS系(優先1)だけを拾うと homepages が落ちて Stage2 クロールの起点を失うため、
    // 会社HP(優先2)も確実に枠確保
    const fetchCandidates = pickFetchCandidates(targetUrls, 7);
    console.log(`[fetch] Jina Readerで並列取得: ${fetchCandidates.length}件`, fetchCandidates);
    const contents: { url: string; text: string }[] = [];
    const MIN_TEXT_LEN = 150;

    const fetchResults = await Promise.allSettled(
      fetchCandidates.map((url) => fetchJinaReader(url, 8000).then((text) => ({ url, text })))
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
          const text = await fetchJinaReader(url, 15000);
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

    // ---------- 他社ページ混入ガード ----------
    // URL無しで会社名のみの場合、Jina本文に会社名トークンが含まれないページは他社ページとして除外。
    // ATS例外ポリシー:
    //   - 企業固有ATS URL (slug持ち) かつ markdown が SPA プレースホルダ程度(〜2500文字) → 信頼
    //     (SPA描画で実テキストが出ない場合があり、HTML抽出で辿るフェーズに委ねる)
    //   - それ以外(本文がリッチに取れてる場合や企業非依存URL) → 会社名マッチを要求
    // これにより「guessUrls が誤ったスラッグを返した」「ATSホストの規約ページ」等を弾く。
    const SPA_PLACEHOLDER_LEN = 2500;
    const nameTokens = companyNameTokens(companyName);
    if (!companyUrl && nameTokens.length > 0) {
      const before = contents.length;
      const droppedUrls: string[] = [];
      const filtered = contents.filter((c) => {
        const atsSpaPass =
          isKnownAtsHost(c.url) &&
          isAtsUrlCompanySpecific(c.url) &&
          c.text.length < SPA_PLACEHOLDER_LEN;
        if (atsSpaPass) return true;
        const ok = textMentionsCompany(c.text, nameTokens);
        if (!ok) {
          droppedUrls.push(c.url);
          console.log(`  × 他社疑い除外: ${c.url}`);
        }
        return ok;
      });
      console.log(`[filter] 他社ページ除外: ${before}→${filtered.length}件`);
      if (filtered.length === 0) {
        return NextResponse.json(
          {
            error: `「${companyName}」の採用ページを特定できませんでした。取得したページは全て別会社のものと判定されました。採用ページURLを直接入力してください。`,
            _diag: { droppedUrls, nameTokens, search: searchDebug },
          },
          { status: 404 }
        );
      }
      contents.length = 0;
      contents.push(...filtered);
    }

    // ---------- Stage 1.5: Stage 1 で取得済みのATSルート/homesからHTML抽出 ----------
    // grounded search がいきなり /c/orizo/ や /homes/XXX を返したケースで、
    // そのページ自身のSPA描画を HTML 版 Jina で取り直してリンクを発掘する。
    // Stage 2 は本文中のリンク抽出しかできないためSPA の場合ここで補う必要がある。
    //
    // 「正しい会社か」の検証も兼ねる:
    //  - SPA例外でフィルタを通過した短文ATS URL に対して HTML 抽出が 0 件を返す場合、
    //    そのATSは当該企業のページではない可能性が高い (例: hallucinated slug "gikou")
    //  - よって検証失敗(抽出0件)かつSPA例外で通した内容は contents から取り除く
    const stage1AtsHtmlPages: string[] = [];
    const stage1AtsVerifiedUrls = new Set<string>();
    {
      const stage1Ats = contents.filter((c) => shouldHtmlExtractAts(c.url));
      if (stage1Ats.length > 0) {
        console.log(`[crawl] Stage1.5: ATS ${stage1Ats.length}件をHTML抽出`);
        const results = await Promise.allSettled(
          stage1Ats.map((c) => extractAtsLinksFromPage(c.url, 7000))
        );
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (r.status === "fulfilled") {
            console.log(`  HTML抽出 ${stage1Ats[i].url} → ${r.value.length}件`);
            for (const u of r.value) stage1AtsHtmlPages.push(u);
            if (r.value.length > 0) stage1AtsVerifiedUrls.add(stage1Ats[i].url);
          }
        }
      }
    }

    // ---------- SPA例外で通したが検証失敗したATSを除外 ----------
    // 本文が短くて会社名マッチを回避した ATS URL のうち、HTML抽出で求人リンクが0件だったもの、
    // または markdown にも会社名が含まれないものを除外する。誤ったスラッグの ATS URL が
    // sources に混入するのを防ぐ。
    if (!companyUrl && nameTokens.length > 0) {
      const before = contents.length;
      const kept = contents.filter((c) => {
        // ATS でない or 本文が十分長い → 既に会社名検証済み
        const wasSpaExempt =
          isKnownAtsHost(c.url) &&
          isAtsUrlCompanySpecific(c.url) &&
          c.text.length < SPA_PLACEHOLDER_LEN;
        if (!wasSpaExempt) return true;
        // 本文に会社名が含まれる → OK
        if (textMentionsCompany(c.text, nameTokens)) return true;
        // HTML抽出で求人URLが取れた → OK (企業特定の傍証)
        if (stage1AtsVerifiedUrls.has(c.url)) return true;
        // それ以外はスラッグ不一致の疑い
        console.log(`  × ATS検証失敗(抽出0件かつ本文に会社名なし): ${c.url}`);
        return false;
      });
      if (kept.length !== before) {
        contents.length = 0;
        contents.push(...kept);
        console.log(`[filter] ATS検証後: ${before}→${contents.length}件`);
      }
      if (contents.length === 0) {
        return NextResponse.json(
          {
            error: `「${companyName}」の採用ページを特定できませんでした。ATS候補URLが全て会社名マッチ/HTML抽出検証に失敗しました。採用ページURLを直接入力してください。`,
            _diag: { search: searchDebug, crawl: { stage1HtmlExtracted: stage1AtsHtmlPages } },
          },
          { status: 404 }
        );
      }
    }

    // ---------- Stage 2: Stage1本文からATS/採用系リンクを抽出して追加取得 ----------
    // 例: orizo.co.jp の本文に [RECRUIT](https://open.talentio.com/r/1/c/orizo/homes/4235) があれば、
    // そこを辿って深い採用情報を取りに行く。会社HP→ATSの2段階クロールが必要なケースを救う。
    const crawlDebug: any = {
      stage1HtmlExtracted: stage1AtsHtmlPages,
      stage2: { candidates: [] as string[], fetched: [] as any[], extracted: {} as any },
      stage3: { candidates: [] as string[], fetched: [] as any[] },
    };
    {
      const alreadyFetched = new Set(contents.map((c) => c.url));
      const discovered = new Set<string>();
      const addIfUsable = (u: string) => {
        if (alreadyFetched.has(u) || discovered.has(u)) return;
        if (isUselessAtsUrl(u)) return;
        discovered.add(u);
      };
      for (const c of contents) {
        const extracted = extractRecruitmentLinksFromContent(c.text);
        crawlDebug.stage2.extracted[c.url] = extracted;
        for (const u of extracted) addIfUsable(u);
      }
      // Stage1.5 の HTML 抽出で見つけた /homes/XXX, /pages/XXX も Stage2 候補に入れる
      for (const u of stage1AtsHtmlPages) addIfUsable(u);
      crawlDebug.stage2.extracted["__stage1_html__"] = stage1AtsHtmlPages;
      const stage2Candidates = sortByPriority([...discovered]).slice(0, 4);
      crawlDebug.stage2.candidates = stage2Candidates;
      if (stage2Candidates.length > 0) {
        console.log(`[crawl] Stage2: Stage1本文から${stage2Candidates.length}件の追加URLを発見`);
        console.log(`[crawl] Stage2対象:`, stage2Candidates);

        // ATS homes/ルートページは SPA のため markdown には個別求人リンクが無い。
        // 並行して HTML 版も取得し data-link-url / publishedUrl から抽出する。
        const stage2Results = await Promise.allSettled(
          stage2Candidates.map(async (url) => {
            if (shouldHtmlExtractAts(url)) {
              const [text, pagesUrls] = await Promise.all([
                fetchJinaReader(url, 8000),
                extractAtsLinksFromPage(url, 7000),
              ]);
              return { url, text, pagesUrls };
            }
            const text = await fetchJinaReader(url, 8000);
            return { url, text, pagesUrls: [] as string[] };
          })
        );

        const htmlDiscoveredPages: string[] = [];
        for (const r of stage2Results) {
          if (r.status === "fulfilled" && r.value.text && r.value.text.length > MIN_TEXT_LEN) {
            // ATS例外: 企業固有URLかつSPAプレースホルダ相当の短文のみ信頼（Stage 1 と同ポリシー）
            const atsSpaPass =
              isKnownAtsHost(r.value.url) &&
              isAtsUrlCompanySpecific(r.value.url) &&
              r.value.text.length < SPA_PLACEHOLDER_LEN;
            if (atsSpaPass || nameTokens.length === 0 || textMentionsCompany(r.value.text, nameTokens)) {
              contents.push({ url: r.value.url, text: r.value.text });
              crawlDebug.stage2.fetched.push({ url: r.value.url, len: r.value.text.length, status: "ok", htmlPages: r.value.pagesUrls.length });
              console.log(`  ✓ Stage2 ${r.value.url} (${r.value.text.length}文字, HTML抽出pages:${r.value.pagesUrls.length}件)`);
              for (const u of r.value.pagesUrls) htmlDiscoveredPages.push(u);
            } else {
              crawlDebug.stage2.fetched.push({ url: r.value.url, len: r.value.text.length, status: "filtered-offtopic" });
              console.log(`  × Stage2 除外(会社名不一致): ${r.value.url}`);
            }
          } else if (r.status === "fulfilled") {
            crawlDebug.stage2.fetched.push({ url: r.value.url, len: r.value.text?.length || 0, status: "too-short" });
          } else if (r.status === "rejected") {
            crawlDebug.stage2.fetched.push({ status: "rejected", reason: String(r.reason?.message || r.reason) });
            console.log(`  ✗ Stage2 ${r.reason?.message || r.reason}`);
          }
        }

        // Stage 3: 個別求人詳細ページ(pages/XXXXX)を取得
        // ソース: (a) Stage2本文(markdown)から抽出したisJobDetailUrl (b) HTML抽出で得たpages URL
        const stage2Added = contents.filter((c) => stage2Candidates.includes(c.url));
        const stage3Discovered = new Set<string>();
        for (const c of stage2Added) {
          for (const u of extractRecruitmentLinksFromContent(c.text)) {
            if (!alreadyFetched.has(u) && !stage2Candidates.includes(u) && isJobDetailUrl(u)) {
              stage3Discovered.add(u);
            }
          }
        }
        for (const u of htmlDiscoveredPages) {
          if (!alreadyFetched.has(u) && !stage2Candidates.includes(u) && isJobDetailUrl(u)) {
            stage3Discovered.add(u);
          }
        }
        const stage3Candidates = [...stage3Discovered].slice(0, 3);
        crawlDebug.stage3.candidates = stage3Candidates;
        if (stage3Candidates.length > 0) {
          console.log(`[crawl] Stage3: 個別求人詳細URL ${stage3Candidates.length}件`);
          console.log(`[crawl] Stage3対象:`, stage3Candidates);
          const stage3Results = await Promise.allSettled(
            stage3Candidates.map((url) =>
              fetchJinaReader(url, 7000).then((text) => ({ url, text }))
            )
          );
          for (const r of stage3Results) {
            if (r.status === "fulfilled" && r.value.text && r.value.text.length > MIN_TEXT_LEN) {
              if (nameTokens.length === 0 || textMentionsCompany(r.value.text, nameTokens)) {
                contents.push(r.value);
                crawlDebug.stage3.fetched.push({ url: r.value.url, len: r.value.text.length, status: "ok" });
                console.log(`  ✓ Stage3 ${r.value.url} (${r.value.text.length}文字)`);
              } else {
                crawlDebug.stage3.fetched.push({ url: r.value.url, len: r.value.text.length, status: "filtered-offtopic" });
              }
            } else if (r.status === "rejected") {
              crawlDebug.stage3.fetched.push({ status: "rejected", reason: String(r.reason?.message || r.reason) });
              console.log(`  ✗ Stage3 ${r.reason?.message || r.reason}`);
            }
          }
        }
      }
    }

    // ---------- content-aware ランキング & 予算配分 ----------
    // スコア: 求人詳細ページ(1e6) >> 公式採用媒体ホスト(1e4) >> 本文長
    const scored = contents.map((c) => ({
      ...c,
      score:
        (isJobDetailUrl(c.url) ? 1_000_000 : 0) +
        (isPreferredHost(c.url) ? 10_000 : 0) +
        c.text.length,
    }));
    scored.sort((a, b) => b.score - a.score);

    const MAX_CHARS = 80000;
    const topSource = scored[0];
    const topIsDetail = isJobDetailUrl(topSource.url);
    const hasRichPrimary = topIsDetail && topSource.text.length > 3000;

    let merged: string;
    if (hasRichPrimary) {
      // 正本(Talentio/HRMOS等)が十分リッチ → 60k を正本に割り当て、残り20kを補助に分配
      const PRIMARY_BUDGET = 60000;
      const OTHER_BUDGET = 20000;
      const primaryText = topSource.text.slice(0, PRIMARY_BUDGET);
      const others = scored.slice(1, 5);
      const perOther = others.length > 0 ? Math.floor(OTHER_BUDGET / others.length) : 0;
      const othersBlock = others
        .map((c) => `=== 補助ソース: ${c.url} ===\n${c.text.slice(0, perOther)}`)
        .join("\n\n---\n\n");
      merged =
        `=== PRIMARY SOURCE (正本／このソースを最優先で逐語転記): ${topSource.url} ===\n${primaryText}` +
        (othersBlock ? `\n\n---\n\n${othersBlock}` : "");
      if (merged.length > MAX_CHARS) merged = merged.slice(0, MAX_CHARS);
      console.log(
        `[fetch] 正本モード: PRIMARY=${topSource.url}(${primaryText.length}字) / 補助=${others.length}件`
      );
    } else {
      // リッチな正本なし → 均等配分（スコア降順で上位6件を結合）
      merged = scored
        .slice(0, 6)
        .map((c) => `=== SOURCE URL: ${c.url} ===\n${c.text}`)
        .join("\n\n---\n\n");
      if (merged.length > MAX_CHARS) merged = merged.slice(0, MAX_CHARS);
      console.log(`[fetch] 均等配分モード: ${Math.min(scored.length, 6)}件結合`);
    }
    console.log(`[fetch] 最終ソース数: ${contents.length}件 / ${merged.length}文字`);

    // Step 3: 検出 + 2分割並列生成
    const primaryPositionCandidate = jobTitle || "";
    // 事業セグメントを職種と誤認するのを防ぐため、ソースに採用ページ(ATS/求人詳細)が
    // 含まれているかどうかをポジション検出プロンプトに伝える
    const hasRecruitmentSource = contents.some(
      (c) => isJobDetailUrl(c.url) || isKnownAtsHost(c.url)
    );
    console.log(`[parallel] 検出 + 企業パート + ポジションパート を3並列実行 (recruitment source: ${hasRecruitmentSource})`);
    const [detectedPositions, primaryResult] = await Promise.all([
      detectPositionsWithGemini(ai, merged, hasRecruitmentSource).catch((e) => {
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

    jobData.sources = contents.map((c) => c.url);

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
      crawl: crawlDebug,
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
