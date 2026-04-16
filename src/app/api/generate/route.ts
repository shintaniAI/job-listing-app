import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

export const runtime = "nodejs";
// Pro モデル使用により search+fetch+gen で 60s を超える可能性があるため 90s に延長
// (Vercel Pro プランなら 300s まで可能。Hobby で deploy エラーになるなら 60 に戻す)
export const maxDuration = 90;

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
// ATS(Talentio/HRMOS/Wantedly/HERP) だけでなく、企業HP自前の個別職種ページも対象に含める
// (例: cybozu.co.jp/recruit/job/engineering.html, example.com/careers/engineer/)
const JOB_DETAIL_PATTERNS = [
  /open\.talentio\.com\/r\/[^/]+\/c\/[^/]+\/pages\/\d+/i,
  /talentio\.com\/[^/]+\/pages\/\d+/i,
  /hrmos\.co\/pages\/[^/]+\/jobs\/\d+/i,
  /wantedly\.com\/projects\/\d+/i,
  /herp\.careers\/v\d+\/[^/]+\/[^/]+/i,
  // HP内の職種別詳細ページ: /recruit/job/XXX / /careers/YYY/ / /saiyou/jobs/ZZZ 等
  // 末尾が /index 以外のパスセグメントまたは .html で終わるもの
  /\/(recruit|careers?|saiyou?|hiring|jobs?)\/(job|position|occupation|role)\/[a-z0-9-]+/i,
  /\/(recruit|careers?)\/[a-z0-9-]+\.html?$/i,
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

// 503/UNAVAILABLE (Pro 過負荷) の場合、別モデルへ自動フォールバックする高レベルラッパ。
// 1st: Pro を試す → 失敗 or 503 → Flash に即切替
// ハルシネーション抑制のため最重要ルールが効けば Flash でも出力品質は許容範囲。
function isRetryableGeminiError(err: any): boolean {
  const msg = String(err?.message || err || "");
  // 503 / UNAVAILABLE / RESOURCE_EXHAUSTED / deadline / タイムアウト / モデル未提供(404/NOT_FOUND) を対象
  // 404/NOT_FOUND: 3.1-pro-preview がプロジェクトで未解放の場合に発生する → 次モデルへ降格
  return /\b503\b|\b404\b|UNAVAILABLE|RESOURCE_EXHAUSTED|NOT_FOUND|not found|experiencing high demand|overloaded|deadline|タイムアウト/i.test(
    msg
  );
}

// モデル階層: 3.1 Pro Preview (最高品質) → 2.5 Pro (安定) → 2.5 Flash (高速フォールバック)
// 3.1 Pro は現在 preview で 503 も出やすいので、多段で確実に応答を返す設計。
const MODEL_CHAIN = ["gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"];

async function generateWithFallback<T>(
  ai: GoogleGenAI,
  buildRequest: (model: string) => Parameters<GoogleGenAI["models"]["generateContent"]>[0],
  timeoutMs: number,
  label: string,
  models: string[] = MODEL_CHAIN
): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      const res = await withTimeout(
        ai.models.generateContent(buildRequest(model)),
        timeoutMs,
        `${label}[${model}]`
      );
      if (i > 0) console.log(`[gemini] ${label}: ${model} でフォールバック成功`);
      return res as T;
    } catch (e: any) {
      lastErr = e;
      const retryable = isRetryableGeminiError(e);
      console.log(`[gemini] ${label} ${model} 失敗 (retryable=${retryable}): ${e.message}`);
      if (!retryable) throw e; // 致命的エラーは即throw
      // 次のモデルへフォールバック
    }
  }
  throw lastErr;
}

// ---------- Jina Reader: URLからMarkdown全文取得 ----------
// プラットフォーム(Wantedly/Talentio/HRMOS等)自身のマーケ/フッター/ナビ文を除去する。
// これらはどの会社ページにも出るので、LLMが会社情報として誤抽出しないよう事前に削る。
const PLATFORM_BOILERPLATE_PATTERNS: RegExp[] = [
  // Wantedly 共通マーケ文
  /Wantedlyは、?\s*\d+\s*万人のユーザーと\s*\d+,?\d*\s*社が利用するビジネスSNS。?[^\n]*/g,
  /共感を軸にした新しい挑戦との出会い[^\n]*/g,
  /あなただけのキャリア実績の記録をつくり[^\n]*/g,
  /Wantedly\s*,?\s*Inc\.[^\n]*/g,
  /©\s*Wantedly[^\n]*/g,
  // Talentio 共通
  /このサイトは採用管理システム「Talentio」で作成されています/g,
  /Powered by Talentio[^\n]*/g,
  // HRMOS 共通
  /このページは採用管理システム「HRMOS採用」で作成されています/g,
  /Powered by HRMOS[^\n]*/g,
  // Herp 共通
  /Powered by HERP[^\n]*/g,
  // 各社共通のプライバシー/利用規約フッター
  /プライバシーポリシー\s*\|\s*利用規約[^\n]*/g,
];

function stripPlatformBoilerplate(text: string): string {
  let out = text;
  for (const p of PLATFORM_BOILERPLATE_PATTERNS) {
    out = out.replace(p, "");
  }
  // 3行以上連続した空行を1行に畳む
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

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
    const raw = await res.text();
    return stripPlatformBoilerplate(raw);
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

// 採用ページと見なせるURLか（ATSホスト / 会社HPの採用セクション / 採用系パス）
// 「採用ページ必ず最優先」判定に使う。isJobDetailUrl より広い定義。
function isRecruitmentPage(url: string): boolean {
  if (isJobDetailUrl(url)) return true;
  if (isKnownAtsHost(url)) return true;
  try {
    const p = new URL(url).pathname.toLowerCase();
    // 典型的な採用ページパス: /recruit /careers /career /saiyo /saiyou /jobs /job /hiring /job-openings /recruitment
    if (/\/(recruit|careers?|saiyou?|jobs?|hiring|job-openings?|recruitment)(\/|$)/i.test(p)) return true;
  } catch {}
  return false;
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

// www./非www./末尾スラッシュ違い/アンカーフラグメントを正規化（同一ページのURL変種を束ねるため）
function normalizeUrl(url: string): string {
  return url
    .replace(/^https?:\/\/(www\.)?/i, "https://")
    .replace(/#.*$/, "") // アンカー(#section) 除去。同一ページなので
    .toLowerCase()
    .replace(/\/+$/, "");
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

// 採用ページ最優先で枠を確保する取得対象選定。
// 順序: (1) ATS/採用詳細 → (2) 会社HPの採用・会社情報ページ → (3) HPホーム → (4) 求人媒体 → (5) その他
// 採用ページ不足時の事故を防ぐため ATS 枠を最大化する。
// Gemini guess が hrmos.co/ や open.talentio.com/ のような会社非依存URLを混ぜることもあるので、
// ATSホストでも企業スラッグを持たないURLは除外する。
function pickFetchCandidates(urls: string[], max: number): string[] {
  // まず明らかに使えないATS URLを全体から除外
  const usable = urls.filter((u) => !isUselessAtsUrl(u));
  const sorted = sortByPriority(usable);
  const pAts = sorted.filter((u) => isJobDetailUrl(u) || isKnownAtsHost(u));
  // HP内の採用/会社情報系パスは ATS が無い時の受け皿として ATS 並みに拾う
  const pRecruitPath = sorted.filter(
    (u) => !pAts.includes(u) && !isSecondaryJobSite(u) && isRecruitmentPage(u)
  );
  const pHome = sorted.filter(
    (u) => !pAts.includes(u) && !pRecruitPath.includes(u) && !isSecondaryJobSite(u) && isCompanyHomepage(u)
  );
  const pMedia = sorted.filter((u) => !pAts.includes(u) && isSecondaryJobSite(u));
  const pOther = sorted.filter(
    (u) => !pAts.includes(u) && !pRecruitPath.includes(u) && !pHome.includes(u) && !pMedia.includes(u)
  );

  const picked: string[] = [];
  const pushUnique = (u: string) => { if (!picked.includes(u)) picked.push(u); };
  for (const u of pAts.slice(0, 5)) pushUnique(u);           // ATS: 最大5枠
  for (const u of pRecruitPath.slice(0, 3)) pushUnique(u);   // HP内採用系: 最大3枠
  for (const u of pHome.slice(0, 2)) pushUnique(u);          // HPホーム: 最大2枠
  for (const u of pMedia.slice(0, 3)) pushUnique(u);         // 求人媒体: 最大3枠 (募集背景・求める人物像・訴求文など求職者目線の情報源として必須)
  for (const u of pOther.slice(0, 2)) pushUnique(u);         // その他: 最大2枠
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
    // アンカー除去 (同一ページの重複取得を避ける)
    u = u.replace(/#.*$/, "");
    if (u) out.add(u);
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
    // 検索/リサーチは採用ページ発見の精度が最重要 → 3.1 Pro Preview > 2.5 Pro > 2.5 Flash の多段で確実性担保
    const result = await generateWithFallback<any>(
      ai,
      (model) => ({
        model,
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
          temperature: 0,
          // Pro 系は thinking 必須、Flash は 0 でOK
          thinkingConfig: { thinkingBudget: model.includes("pro") ? 512 : 0 },
        } as any,
      }),
      timeoutMs,
      label
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
    "【最重要目的】",
    "**採用ページを必ず見つけること**。採用ページ(ATS個別求人/ATS企業ルート/会社HPの/careers・/recruit)は応募者に提示する求人票の正本となるため、どんな形式であれ1つ以上必ず含めること。",
    "",
    "【絶対遵守】",
    `- 社名が「${companyName}」と完全一致する企業のURLのみ出力する`,
    "- 似た社名、違う会社、関連しない会社のURLは絶対に含めない",
    "- 検索結果が無い/自信が無い場合は空出力する（間違ったURLを返すより空の方が良い）",
    "",
    "【検索ヒント：これらのクエリを内部で試してOK。上から順に優先】",
    `- "${companyName}" site:talentio.com OR site:hrmos.co OR site:wantedly.com OR site:herp.careers  (ATS最優先)`,
    `- "${companyName}" 採用 OR recruit OR careers`,
    `- "${companyName}" 採用情報 OR 募集要項 OR 職務内容`,
    `- "${companyName}" 公式サイト OR コーポレートサイト`,
    `- "${companyName}" 会社概要 OR ミッション OR ビジョン OR バリュー`,
    `- "${companyName}" site:indeed.com OR site:doda.jp OR site:mynavi.jp OR site:rikunabi.com  (求人媒体: ATS/公式と併せて必ず取る)`,
    "",
    "【出力したいURL（優先度順）】",
    "1. 求人詳細ページ（Talentio/HRMOS/Wantedly/Herpの個別URL）＝最優先",
    "2. ATS企業ルート（open.talentio.com/r/../c/../ や hrmos.co/pages/.. など個別URLがなければ必須）",
    "3. 会社公式サイトの採用/キャリアページ（/careers/ /recruit/ /saiyou/ 等）",
    "4. 会社公式サイト（ホーム・会社概要・MVV）＝HP追加情報用",
    "5. 求人媒体の該当企業ページ（Indeed/doda/マイナビ/リクナビ/エン/Green等）＝募集背景・求職者訴求文など追加情報用として積極的に含める",
    "",
    "見つけたURLを全てhttps://付きで1行ずつ出力（最大12件）。説明・番号・記号不要。",
  ].join("\n");

  // リサーチ用クエリ: 採用ページ以外に取り込みたい会社情報（HP/会社概要/MVV/事業/代表メッセージ/沿革）
  const researchPrompt = [
    `対象企業: 「${companyName}」(この企業名と完全一致する会社のみ)`,
    "",
    "会社情報を補強するために下記トピックが記載されている**会社公式サイト内のページ**を探してください。",
    "応募者が事前に会社理解を深めるために使う追加情報源です。",
    "",
    "【欲しいページ】",
    "- 会社概要 / About / コーポレートページ (/company/ /about/ /corporate/ 等)",
    "- ミッション / ビジョン / バリュー / 行動指針 (/mission/ /vision/ /values/ /mvv/ 等)",
    "- 代表メッセージ / CEOメッセージ / 創業ストーリー",
    "- 事業紹介 / サービス一覧 / プロダクト紹介",
    "- 沿革 / ヒストリー",
    "- カルチャー / 社風 / メンバー紹介 / 働き方",
    "",
    "【絶対遵守】",
    `- 社名が「${companyName}」と完全一致する企業のURLのみ`,
    "- 似た社名・違う会社・無関係サイトのURLは返さない",
    "- 確信がない時は空出力",
    "",
    "URLのみ1行ずつhttps://付きで出力（最大8件）。説明不要。",
  ].join("\n");

  // 求人媒体(Indeed/doda/マイナビ/リクナビ/エン/Green/type/ビズリーチ)の掲載ページを積極的に探す追加検索。
  // これらは ATS/HP に書かれていない「募集背景」「求める人物像」「求職者への訴求文」「応募者の声」が載っていることがあり、
  // 求職者目線で価値ある情報源なので必ず取りに行く。
  const mediaPrompt = [
    `対象企業: 「${companyName}」(この企業名と完全一致する会社のみ)`,
    "",
    `この会社が以下の求人媒体に**掲載していれば**、その掲載ページURLを出力してください。${jobClause}`,
    "",
    "【探す媒体】",
    "- Indeed (jp.indeed.com) — 求人詳細/会社ページ",
    "- doda (doda.jp) — 求人詳細/会社ページ",
    "- マイナビ転職 (tenshoku.mynavi.jp) — 求人詳細",
    "- リクナビNEXT (next.rikunabi.com) — 求人詳細",
    "- エン転職 (employment.en-japan.com) — 求人詳細",
    "- Green (green-japan.com) — 求人詳細",
    "- type (type.jp) — 求人詳細",
    "- ビズリーチ (bizreach.jp) — 求人詳細",
    "",
    "【検索ヒント】",
    `- "${companyName}" site:jp.indeed.com`,
    `- "${companyName}" site:doda.jp`,
    `- "${companyName}" site:tenshoku.mynavi.jp`,
    `- "${companyName}" site:next.rikunabi.com`,
    `- "${companyName}" site:employment.en-japan.com`,
    `- "${companyName}" site:green-japan.com`,
    `- "${companyName}" 採用 site:indeed.com OR site:doda.jp OR site:mynavi.jp`,
    "",
    "【絶対遵守】",
    `- 社名が「${companyName}」と完全一致する掲載のみ返す`,
    "- 無関係会社の求人URLや、会社名の一部に含まれるだけの求人は絶対に返さない",
    "- 掲載が見つからない場合は空出力",
    "",
    "URLのみ1行ずつhttps://付きで出力（最大6件）。",
  ].join("\n");

  const [groundRes, guessRes, researchRes, mediaRes] = await Promise.all([
    runGroundedSearch(ai, broadPrompt, 22000, "採用URL検索"),
    guessUrlsWithoutGrounding(ai, companyName).catch(() => ({
      urls: [] as string[],
      usage: {},
    })),
    runGroundedSearch(ai, researchPrompt, 18000, "会社情報リサーチ"),
    runGroundedSearch(ai, mediaPrompt, 18000, "求人媒体リサーチ"),
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
  const filteredResearch = researchRes.urls.filter((u) => !isKnownAtsHost(u) || isPlausibleAtsSlug(u));
  // 求人媒体は ATS ではないのでスラッグチェック不要。全て候補化
  const filteredMedia = (mediaRes as any).urls.filter((u: string) => isSecondaryJobSite(u));

  const merged = dedupeUrls(Array.from(
    new Set([...filteredGrounded, ...filteredGuess, ...deterministicUrls, ...filteredResearch, ...filteredMedia])
  ));
  const sorted = sortByPriority(merged);
  console.log(
    `[search] 採用grounded:${groundRes.urls.length}(有効${filteredGrounded.length}) 推測:${guessRes.urls.length}(有効${filteredGuess.length}) 会社情報research:${researchRes.urls.length}(有効${filteredResearch.length}) 求人媒体:${(mediaRes as any).urls.length}(有効${filteredMedia.length}) 機械生成:${deterministicUrls.length} → 統合${sorted.length}件`
  );
  console.log(`[search] ローマ字候補:`, slugCandidates);

  const usage = {
    promptTokenCount:
      (groundRes.usage?.promptTokenCount || 0) +
      ((guessRes as any).usage?.promptTokenCount || 0) +
      (researchRes.usage?.promptTokenCount || 0) +
      ((mediaRes as any).usage?.promptTokenCount || 0),
    candidatesTokenCount:
      (groundRes.usage?.candidatesTokenCount || 0) +
      ((guessRes as any).usage?.candidatesTokenCount || 0) +
      (researchRes.usage?.candidatesTokenCount || 0) +
      ((mediaRes as any).usage?.candidatesTokenCount || 0),
  };

  const debug = {
    grounded: (groundRes as any).debug,
    research: (researchRes as any).debug,
    media: (mediaRes as any).debug,
    guessUrls: guessRes.urls,
  };

  // ATS最大5 + HP採用系3 + HPホーム2 + 求人媒体3 + その他2 = 最大15枠を取れるよう上限拡大
  return { urls: sorted.slice(0, 18), usage, debug } as any;
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
const COMMON_RULES = `【最重要ルール: ハルシネーション完全禁止】
- **提供された原文(採用ページ/HP/求人媒体)に書かれていない情報は、いかなる形でも出力しない**。推測・創作・一般化・類推・常識による補完・他社事例からの流用は**全て禁止**
- 原文に書かれていない内容を書くくらいなら、そのキーは空文字列 "" にする
- 「こういう会社はこうだろう」「この業界なら〜が普通」等の**業界知識や一般常識は絶対に持ち込まない**
- 原文の文言を**言い換え・要約・改変しない**。そのままの文字列を転記すること
- 数値・金額・時間・固有名詞は原文通り(改変禁止、丸め禁止、四捨五入禁止)
- 原文内で矛盾する記述がある場合は、より新しい/詳細な方を採用し、メモとして両方を書く
- 会社名・サービス名・人物名は原文にあるスペル・漢字・カタカナで書く

【絶対ルール】
- **採用ページ最優先・網羅**: 「=== PRIMARY SOURCE (採用ページ／...)」タグが付いたソースは採用ページである。そこに書かれている情報は項目として**全て漏らさず**JSONに転記する（章・見出し・箇条書き・表・制度一覧・数値・金額・時間帯など全て）。タグがない場合は先頭の「=== SOURCE URL: ...」を採用ページとみなす
- **HP等は追加情報として取り込む**: 「=== 補助ソース:」(HP・会社概要・求人媒体等)および2件目以降のSOURCE URLは、**採用ページを補完する追加情報**として扱う。採用ページに無い情報(会社概要・MVV・事業詳細・代表メッセージ・沿革 等)があれば積極的に取り込み、既存キーの補足や新しいキーの追加に使ってよい。ただし採用ページに書いてある項目の値を補助ソースの内容で上書きしてはいけない
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
- **プラットフォーム自身のマーケティング文は絶対に使わない**: Wantedly/Talentio/HRMOS/Herp 等の採用管理システムが自社を紹介する文言（例:「Wantedlyは〇〇万人のユーザーと〇〇社が利用するビジネスSNS」「共感を軸にした新しい挑戦」「あなただけのキャリア実績の記録をつくり〜」「このサイトは採用管理システム『Talentio/HRMOS』で作成されています」等）は、対象企業とは無関係のため出力に含めてはいけない。同様に Indeed/doda/マイナビ/リクナビ/エン 等の求人媒体プラットフォーム自身の宣伝文も除外する
- 対象企業「(会社名)」自身が書いた文章のみを抽出する。プラットフォームの定型文・フッター・ナビゲーション・広告は無視
- 採用ページ(PRIMARY)は全て転記。HP/会社概要/求人媒体(Indeed/doda/マイナビ転職/リクナビNEXT/エン転職/Green/type/ビズリーチ等)は追加情報源として、採用ページに無い事実があれば追加する
- 求人媒体には以下のような「ATSに無い求職者目線の情報」が載っていることが多い。**見つけたら必ず取り込む**:
  * 募集背景・組織拡大の理由・ポジション新設の経緯
  * 求める人物像（原文ママの訴求文）・求職者への期待
  * 応募から内定までの選考フロー・面接回数・カジュアル面談の可否
  * 残業時間の実績値・月平均残業・有給取得率
  * 社員の声・現場インタビュー・1日の流れ
  * 会社の成長率・業績数値・表彰歴・メディア露出
  * 平均年齢・男女比・中途入社比率
- 原文が長い場合は値が長くなっても省略しない（読みやすさのため段落分けや改行は入れてよい）

【求職者が本当に知りたい情報】
以下の観点は応募判断に直結するため、原文に手がかりがあれば必ず対応キーに拾うこと:
- 仕事のやりがい・面白さ（"このポジションの魅力" "得られる経験"）
- 1日の流れ・働き方イメージ
- キャリアパス・成長環境・評価制度
- チーム構成・上司・一緒に働くメンバー
- 残業の実態・ワークライフバランス
- リモート可否・フレックス・服装自由度
- 選考フロー・応募プロセス・カジュアル面談
- 会社の成長性・事業の将来性・競合優位性
- 年収レンジ・賞与実績・昇給実績
- 福利厚生の実態（利用率・独自制度）`;

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
推奨キー: 事業内容 / ミッション / ビジョン / バリュー / 行動指針 / 事業の特徴・強み / 今後の展望 / カルチャー / 社風 / 成長性・業績 / 表彰・受賞歴 / メディア掲載 / 社員構成（平均年齢・男女比・中途入社比率 等） / 設立年月 / 従業員数 / 資本金 / 代表者 / 本社所在地 / 代表メッセージ / 沿革 / グループ会社
- 「事業内容」は列挙されている事業を全て1つの値にまとめる（改行区切り・先頭「・」の箇条書き、または文章）
- ミッション/ビジョン/バリューなどナラティブなものは原文の文章をそのまま
- カルチャー/社風は原文の説明文を網羅した読み物として転記
- 成長性・業績・表彰歴・メディア露出・社員構成は求人媒体側に載っていることが多い。見つけたら必ず拾う

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
推奨キー: 主な業務内容 / ポジションの特徴 / このポジションの魅力 / 募集背景 / 得られるスキル・経験 / チーム構成 / 配属先 / 上司・一緒に働くメンバー / 1日の流れ / 今後の活躍の場・キャリアパス / 評価制度 / 使用ツール・技術スタック / 社員の声・インタビュー
- 「主な業務内容」は原文に列挙された業務を全て1つの値に改行区切り箇条書き（先頭「・」）でまとめる
- 「得られるスキル・経験」も同様に複数項目を1つの値にまとめる
- ポジションの特徴・魅力は原文の文章をそのまま転記
- 募集背景・上司・メンバー・1日の流れ・評価制度・社員の声は求人媒体側にある可能性が高い。見つけたら必ず取り込む

# requirements（応募資格）
推奨キー: 必須要件 / 歓迎要件 / 求める人材（求職者への訴求文） / 年齢 / 学歴
- 「必須要件」は原文の必須項目を全て1つの値に改行区切り箇条書きでまとめる
- 「歓迎要件」「求める人材」も同様に1キーに集約
- 「求める人材」は求人媒体の訴求文（「〜な方を歓迎」「〜な方にピッタリ」等）があれば原文ママで転記

# salary（給与・報酬）
推奨キー: 想定年収 / 賃金形態 / 基本給 / 月給 / 年俸月額 / 所定内給与 / 固定時間外手当 / 固定深夜手当 / 通勤手当 / 残業手当 / 諸手当 / 給与改定 / 昇給実績 / 賞与 / 賞与実績 / 給与モデル例
- 「諸手当」は複数ある場合1つの値に改行区切りでまとめる
- 固定時間外/深夜手当は金額・時間数・時間帯を1つの値に詳細記述
- 昇給実績・賞与実績は求人媒体にある場合が多いので積極的に拾う

# workConditions（勤務条件）
推奨キー: 勤務地 / 勤務地住所 / 最寄り駅 / 勤務時間 / 所定労働時間 / フレックス / コアタイム / 清算期間 / 休憩時間 / リモートワーク / 残業 / 月平均残業時間 / 有給取得率 / 試用期間 / 転勤 / 副業 / 服装
- 勤務地が複数拠点ある場合は1つの値に改行区切りでまとめる
- 休憩時間は原文の細則（例: 12:00-13:00 + 15:00-15:15）を1つの値に詳細転記
- 月平均残業時間・有給取得率は求人媒体に載りやすい実データ。必ず転記

# selection（選考プロセス）※ 新規セクション
推奨キー: 応募方法 / 選考フロー / 面接回数 / カジュアル面談 / 必要書類 / 内定までの期間 / 応募後の流れ / 連絡手段
- 採用ページ/求人媒体の選考情報を網羅

【出力形式（JSONのみ、コードフェンス禁止）】
{
  "jobContent": { "主な業務内容":"", "得られるスキル・経験":"", "募集背景":"", ... },
  "requirements": { "必須要件":"", "歓迎要件":"", "求める人材":"", ... },
  "salary": { "想定年収":"", "年俸月額":"", "固定時間外手当":"", "諸手当":"", "昇給実績":"", ... },
  "workConditions": { "勤務地":"", "勤務時間":"", "休憩時間":"", "月平均残業時間":"", ... },
  "selection": { "選考フロー":"", "面接回数":"", "カジュアル面談":"", ... }
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

  // 3.1-pro-preview → 2.5-pro → 2.5-flash で多段フォールバック
  const result = await generateWithFallback<any>(
    ai,
    (model) => ({
      model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        temperature: 0.1,
        maxOutputTokens: 20000,
        // Pro 系は thinking 必須。Flash は 0 で可。
        thinkingConfig: { thinkingBudget: model.includes("pro") ? 256 : 0 },
      } as any,
    }),
    35000,
    "企業パート生成"
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

  const result = await generateWithFallback<any>(
    ai,
    (model) => ({
      model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        temperature: 0.1,
        maxOutputTokens: 20000,
        // Pro 系(2.5-pro / 3.1-pro-preview)のみ thinkingBudget>0 を必須とする
        thinkingConfig: { thinkingBudget: model.includes("pro") ? 256 : 0 },
      } as any,
    }),
    40000,
    "ポジションパート生成"
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
    selection: positionData.selection || {},
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
    // 会社HP(優先2)も確実に枠確保。採用ページ＋HP+補助情報を合わせて10件取得。
    const fetchCandidates = pickFetchCandidates(targetUrls, 12);
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
      // 最大12件に拡大: 複数ポジションを持つ企業のために個別職種ページまで取り込む余地を確保
      const stage2Candidates = sortByPriority([...discovered]).slice(0, 12);
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
        // 最大8件に拡大: ATS/企業HPの個別求人詳細まで広く拾う
        const stage3Candidates = [...stage3Discovered].slice(0, 8);
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

    // 3.1 Pro (1M token context) を活かして従来より多く投入。原文網羅性UP。
    const MAX_CHARS = 140000;
    // 採用ページを最優先ソースに固定: ATS > HP内採用ページ > 求人媒体 の順で正本選定
    const recruitmentRank = (u: string): number => {
      if (isJobDetailUrl(u) || isKnownAtsHost(u)) return 0;  // ATS最優先
      if (isRecruitmentPage(u) && !isSecondaryJobSite(u)) return 1; // HP内採用系
      if (isSecondaryJobSite(u)) return 2; // 求人媒体 (フォールバック)
      return 3;
    };
    const recruitmentSorted = [...scored].sort((a, b) => {
      const ar = recruitmentRank(a.url);
      const br = recruitmentRank(b.url);
      if (ar !== br) return ar - br;
      return b.score - a.score;
    });
    const topSource = recruitmentSorted[0];
    const topIsAts = isJobDetailUrl(topSource.url) || isKnownAtsHost(topSource.url);
    const topIsRecruitment = isRecruitmentPage(topSource.url);
    // ATSは閾値緩め (SPA/薄いページでも正本化)、HP採用系・求人媒体は3000字以上で正本化
    const hasRichPrimary = topIsAts
      ? topSource.text.length > 1500
      : topIsRecruitment && topSource.text.length > 3000;

    let merged: string;
    if (hasRichPrimary) {
      // 採用ページが取得できた → PRIMARY に厚く予算配分 (100k)、HP等の補助ソースは40kを分配
      const PRIMARY_BUDGET = 100000;
      const OTHER_BUDGET = 40000;
      const primaryText = topSource.text.slice(0, PRIMARY_BUDGET);
      const others = recruitmentSorted.slice(1, 6);
      const perOther = others.length > 0 ? Math.floor(OTHER_BUDGET / others.length) : 0;
      const othersBlock = others
        .map((c) => `=== 補助ソース (HP/会社概要/求人媒体等 — 採用ページに無い追加情報を取り込む用): ${c.url} ===\n${c.text.slice(0, perOther)}`)
        .join("\n\n---\n\n");
      merged =
        `=== PRIMARY SOURCE (採用ページ／このソースの情報は必ず全項目網羅的に転記する): ${topSource.url} ===\n${primaryText}` +
        (othersBlock ? `\n\n---\n\n${othersBlock}` : "");
      if (merged.length > MAX_CHARS) merged = merged.slice(0, MAX_CHARS);
      console.log(
        `[fetch] 採用ページPRIMARYモード: PRIMARY=${topSource.url}(${primaryText.length}字) / 補助=${others.length}件`
      );
    } else {
      // 採用ページが見つからず/薄い → スコア降順で均等配分
      merged = scored
        .slice(0, 6)
        .map((c) => `=== SOURCE URL: ${c.url} ===\n${c.text}`)
        .join("\n\n---\n\n");
      if (merged.length > MAX_CHARS) merged = merged.slice(0, MAX_CHARS);
      console.log(`[fetch] 均等配分モード(採用ページ未取得): ${Math.min(scored.length, 6)}件結合`);
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
        selection: jobData.selection || {},
      });

      // サブポジションも並列で実際に生成 (以前は空オブジェクトだったため求職者に情報が届いてなかった)
      // 各ポジションで merged 全文を渡し focusHint で絞らせる。60k字に切り詰めてトークン抑制。
      const subPositions = uniqueDetected.slice(1, 8);
      const subSource = merged.slice(0, 60000);
      console.log(`[sub-positions] ${subPositions.length}件を並列生成: ${JSON.stringify(subPositions)}`);
      const subResults = await Promise.allSettled(
        subPositions.map((pos) =>
          generatePositionPart(ai, companyName, pos, salary, subSource, pos)
            .then((r) => ({ pos, data: r.data, usage: r.usage }))
            .catch((e) => {
              console.log(`[sub-positions] ${pos} 失敗: ${e.message}`);
              return { pos, data: {} as any, usage: {} as any };
            })
        )
      );
      for (const r of subResults) {
        if (r.status === "fulfilled") {
          const { pos, data, usage } = r.value;
          subPositionUsages.push(usage);
          allPositions.push({
            jobTitle: pos,
            summary: data.summary || "",
            jobContent: data.jobContent || {},
            requirements: data.requirements || {},
            salary: data.salary || {},
            workConditions: data.workConditions || {},
            selection: data.selection || {},
          });
        }
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
      "selection",
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
        for (const key of ["jobContent", "requirements", "salary", "workConditions", "selection"]) {
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
      engine: "jina-reader + gemini-3.1-pro-preview (fallback: 2.5-pro, 2.5-flash)",
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
