"use client";

import React, { useState, useEffect, useRef } from "react";

const STORAGE_KEY = "job-search-app:state:v3";

const EMPLOYMENT_TYPES = [
  "",
  "正社員",
  "契約社員",
  "業務委託",
  "派遣社員",
  "アルバイト・パート",
  "インターン",
];

type Listing = {
  title: string;
  url: string;
  rawText: string;
};

type Source = {
  id: string;
  media: string;
  domain: string;
  searchUrl: string;
  listings: Listing[];
  note?: string;
};

type SearchResult = {
  companyName: string;
  jobTitle?: string;
  workLocation?: string;
  employmentType?: string;
  salary?: string;
  keywords?: string;
  generatedAt: string;
  sources: Source[];
};

export default function Home() {
  const [companyName, setCompanyName] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [workLocation, setWorkLocation] = useState("");
  const [employmentType, setEmploymentType] = useState("");
  const [salary, setSalary] = useState("");
  const [keywords, setKeywords] = useState("");
  const [loading, setLoading] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState("");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (typeof s.companyName === "string") setCompanyName(s.companyName);
        if (typeof s.jobTitle === "string") setJobTitle(s.jobTitle);
        if (typeof s.workLocation === "string") setWorkLocation(s.workLocation);
        if (typeof s.employmentType === "string") setEmploymentType(s.employmentType);
        if (typeof s.salary === "string") setSalary(s.salary);
        if (typeof s.keywords === "string") setKeywords(s.keywords);
        if (s.result) setResult(s.result);
      }
    } catch {}
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          companyName,
          jobTitle,
          workLocation,
          employmentType,
          salary,
          keywords,
          result,
        })
      );
    } catch {}
  }, [hydrated, companyName, jobTitle, workLocation, employmentType, salary, keywords, result]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = companyName.trim();
    const job = jobTitle.trim();
    if (!name) {
      setError("会社名を入力してください");
      return;
    }
    if (!job) {
      setError("職種を入力してください");
      return;
    }
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName: name,
          jobTitle: job,
          workLocation: workLocation.trim(),
          employmentType: employmentType.trim(),
          salary: salary.trim(),
          keywords: keywords.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "エラーが発生しました");
      setResult(data as SearchResult);
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleClear = () => {
    if (!confirm("入力と検索結果をリセットしますか？")) return;
    setCompanyName("");
    setJobTitle("");
    setWorkLocation("");
    setEmploymentType("");
    setSalary("");
    setKeywords("");
    setResult(null);
    setError("");
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
  };

  const handleDownloadPdf = async () => {
    if (!result) return;
    setPdfLoading(true);
    setError("");
    try {
      const res = await fetch("/api/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "PDF生成に失敗しました");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `求人まとめ_${result.companyName}_${result.jobTitle || ""}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setPdfLoading(false);
    }
  };

  const totalListings = result
    ? result.sources.reduce((n, s) => n + s.listings.length, 0)
    : 0;

  return (
    <main className="max-w-4xl mx-auto px-4 py-10">
      <h1 className="text-3xl font-bold text-center mb-2">🔎 求人媒体 横断検索</h1>
      <p className="text-center text-gray-500 mb-8 text-sm">
        会社名・職種・勤務地などで絞り込み → Indeed / doda / マイナビ転職 / リクナビNEXT / エン転職 を横断検索 → 掲載内容を原文のまま表示
      </p>

      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-xl border shadow-sm p-6 mb-8 space-y-4"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              会社名 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="例: 株式会社サイバーエージェント"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={loading}
            />
            <p className="text-xs text-gray-400 mt-1">
              正式名称（株式会社〇〇）で入れるとヒット率が上がります
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              職種 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              placeholder="例: バックエンドエンジニア / 営業 / Webデザイナー"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={loading}
            />
            <p className="text-xs text-gray-400 mt-1">この職種に該当する求人だけに絞り込みます</p>
          </div>
        </div>
        <details className="group" open>
          <summary className="cursor-pointer text-sm font-medium text-gray-700 select-none">
            ▾ 詳細条件（任意）
          </summary>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">勤務地</label>
              <input
                type="text"
                value={workLocation}
                onChange={(e) => setWorkLocation(e.target.value)}
                placeholder="例: 東京都渋谷区 / 大阪 / リモート可"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={loading}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">雇用形態</label>
              <select
                value={employmentType}
                onChange={(e) => setEmploymentType(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={loading}
              >
                {EMPLOYMENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t || "（指定なし）"}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">給与</label>
              <input
                type="text"
                value={salary}
                onChange={(e) => setSalary(e.target.value)}
                placeholder="例: 年収600万以上 / 時給1500円以上"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={loading}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">キーワード</label>
              <input
                type="text"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                placeholder="例: React TypeScript AWS"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={loading}
              />
            </div>
          </div>
        </details>
        <div className="flex gap-3">
          <button
            type="submit"
            disabled={loading}
            className="flex-1 bg-blue-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? "検索中（最大60秒かかります）..." : "🔍 求人を検索"}
          </button>
          <button
            type="button"
            onClick={handleClear}
            disabled={loading}
            className="bg-gray-100 text-gray-700 px-4 py-3 rounded-lg font-medium hover:bg-gray-200 disabled:opacity-50"
          >
            リセット
          </button>
        </div>
      </form>

      {loading && (
        <div className="text-center py-12">
          <div className="inline-block animate-spin rounded-full h-10 w-10 border-4 border-blue-600 border-t-transparent mb-4"></div>
          <p className="text-gray-500 text-sm">各求人媒体を横断検索しています…</p>
          <p className="text-gray-400 text-xs mt-1">通常 10〜40 秒程度かかります</p>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4 mb-6 whitespace-pre-wrap text-sm">
          ⚠️ {error}
        </div>
      )}

      {result && (
        <div className="space-y-6">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center justify-between flex-wrap gap-3">
            <div className="min-w-0">
              <div className="text-sm text-gray-500">検索対象</div>
              <div className="text-lg font-bold text-gray-900 break-words">
                {result.companyName}
                {result.jobTitle && (
                  <span className="text-gray-500 font-normal text-base"> / {result.jobTitle}</span>
                )}
              </div>
              {(result.workLocation || result.employmentType || result.salary || result.keywords) && (
                <div className="text-xs text-gray-500 mt-1 flex flex-wrap gap-2">
                  {result.workLocation && <span>📍 {result.workLocation}</span>}
                  {result.employmentType && <span>💼 {result.employmentType}</span>}
                  {result.salary && <span>💴 {result.salary}</span>}
                  {result.keywords && <span>🔖 {result.keywords}</span>}
                </div>
              )}
            </div>
            <div className="flex items-center gap-3">
              <div className="text-right">
                <div className="text-sm text-gray-500">合計ヒット</div>
                <div className="text-lg font-bold text-blue-700">{totalListings} 件</div>
              </div>
              <button
                type="button"
                onClick={handleDownloadPdf}
                disabled={pdfLoading}
                className="bg-emerald-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 whitespace-nowrap"
              >
                {pdfLoading ? "生成中..." : "📄 PDFダウンロード"}
              </button>
            </div>
          </div>

          {result.sources.map((source) => (
            <SourceCard key={source.id} source={source} />
          ))}
          <p className="text-xs text-gray-400 text-center">
            最終更新: {new Date(result.generatedAt).toLocaleString("ja-JP")}
          </p>
        </div>
      )}

      <footer className="text-center text-xs text-gray-400 mt-16">
        掲載内容は各求人媒体に書かれている情報を取得時点のまま表示しています。最新情報は各媒体の元ページでご確認ください。
      </footer>
    </main>
  );
}

function SourceCard({ source }: { source: Source }) {
  const hasListings = source.listings.length > 0;
  return (
    <section className="bg-white rounded-xl border shadow-sm overflow-hidden">
      <header className="px-5 py-3 bg-gradient-to-r from-blue-600 to-blue-500 text-white flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold">📘 {source.media}</span>
          <span className="text-xs opacity-80">{source.domain}</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span
            className={
              hasListings
                ? "bg-white/20 px-2 py-0.5 rounded-full"
                : "bg-white/10 px-2 py-0.5 rounded-full opacity-80"
            }
          >
            {hasListings ? `${source.listings.length} 件ヒット` : "掲載なし"}
          </span>
          {source.searchUrl && (
            <a
              href={source.searchUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="bg-white/20 hover:bg-white/30 px-2 py-0.5 rounded-full"
            >
              検索ページ ↗
            </a>
          )}
        </div>
      </header>
      <div className="p-5 space-y-5">
        {!hasListings && (
          <p className="text-sm text-gray-500 italic">
            {source.note
              ? source.note
              : "当該企業の求人は見つかりませんでした（掲載なし／検索不可）。"}
          </p>
        )}
        {source.listings.map((l, i) => (
          <ListingBlock key={i} listing={l} sourceName={source.media} index={i + 1} />
        ))}
      </div>
    </section>
  );
}

function ListingBlock({
  listing,
  sourceName,
  index,
}: {
  listing: Listing;
  sourceName: string;
  index: number;
}) {
  const [copied, setCopied] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const buildCopyText = () => {
    const parts: string[] = [];
    parts.push(`【媒体】${sourceName}`);
    if (listing.title) parts.push(`【タイトル】${listing.title}`);
    if (listing.url) parts.push(`【URL】${listing.url}`);
    parts.push("");
    parts.push(listing.rawText || "（本文なし）");
    return parts.join("\n");
  };

  const handleCopy = async () => {
    const text = buildCopyText();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback: select textarea
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.select();
        try {
          document.execCommand("copy");
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {}
      }
    }
  };

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="bg-gray-50 px-4 py-3 border-b border-gray-200">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-gray-400 mb-0.5">求人 #{index}</div>
            <div className="font-bold text-gray-800 break-words">
              {listing.title || "（タイトルなし）"}
            </div>
            {listing.url && (
              <a
                href={listing.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-600 hover:underline break-all"
              >
                {listing.url} ↗
              </a>
            )}
          </div>
          <button
            type="button"
            onClick={handleCopy}
            className={
              "text-xs rounded-md px-3 py-1.5 border font-medium whitespace-nowrap " +
              (copied
                ? "bg-green-600 text-white border-green-600"
                : "bg-white text-gray-700 border-gray-300 hover:bg-gray-100")
            }
          >
            {copied ? "✓ コピーしました" : "📋 コピー"}
          </button>
        </div>
      </div>
      <div className="p-0">
        <textarea
          ref={taRef}
          readOnly
          value={buildCopyText()}
          className="w-full border-0 bg-white p-4 text-sm text-gray-800 font-mono leading-relaxed whitespace-pre-wrap resize-y focus:outline-none focus:ring-2 focus:ring-blue-400"
          rows={Math.min(30, Math.max(8, (listing.rawText || "").split("\n").length + 3))}
        />
      </div>
    </div>
  );
}
