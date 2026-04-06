"use client";

import { useState } from "react";

export default function Home() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");
  const [pdfGenerating, setPdfGenerating] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    setLoading(true);
    setError("");
    setResult(null);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: input.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "エラーが発生しました");
      setResult(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadPdf = async () => {
    if (!result) return;
    setPdfGenerating(true);
    try {
      const res = await fetch("/api/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobData: result }),
      });
      if (!res.ok) throw new Error("PDF生成に失敗しました");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `求人票_${result.companyName || "unknown"}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setPdfGenerating(false);
    }
  };

  return (
    <main className="max-w-3xl mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold text-center mb-2">📋 求人票自動生成</h1>
      <p className="text-center text-gray-500 mb-8">
        求人ページのURLを入力、または会社名でWeb検索して求人情報を収集・整理しPDFを生成します
      </p>

      <form onSubmit={handleSubmit} className="flex gap-3 mb-8">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="例: 〇〇クリニック / https://example.com/jobs/123"
          className="flex-1 border border-gray-300 rounded-lg px-4 py-3 text-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          type="submit"
          disabled={loading}
          className="bg-blue-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? "生成中..." : "生成"}
        </button>
      </form>

      {loading && (
        <div className="text-center py-12">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-blue-600 border-t-transparent mb-4"></div>
          <p className="text-gray-500">求人情報を収集・整理しています...</p>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4 mb-6">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl shadow-sm border p-6">
            <h2 className="text-xl font-bold text-blue-800 mb-1">
              {result.companyName} {result.jobTitle && `- ${result.jobTitle}`}
            </h2>
            <p className="text-gray-500 text-sm mb-4">{result.summary}</p>

            <Section title="募集概要" rows={result.overview} />
            <Section title="仕事内容" rows={result.jobContent} />
            <Section title="募集要項" rows={result.requirements} />
            <Section title="仕事環境" rows={result.environment} />
          </div>

          {result.sources && result.sources.length > 0 && (
            <div className="bg-gray-50 rounded-lg border p-4">
              <h3 className="font-bold text-gray-700 text-sm mb-2">📎 情報ソース</h3>
              <ul className="text-sm text-gray-500 space-y-1">
                {result.sources.map((src: string, i: number) => (
                  <li key={i}>
                    {src.startsWith("http") ? (
                      <a href={src} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline break-all">{src}</a>
                    ) : (
                      <span>{src}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="text-center">
            <button
              onClick={handleDownloadPdf}
              disabled={pdfGenerating}
              className="bg-green-600 text-white px-8 py-3 rounded-lg font-medium hover:bg-green-700 disabled:opacity-50"
            >
              {pdfGenerating ? "PDF生成中..." : "📥 PDFダウンロード"}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

function Section({ title, rows }: { title: string; rows?: Record<string, string> }) {
  if (!rows || Object.keys(rows).length === 0) return null;
  return (
    <div className="mb-4">
      <h3 className="font-bold text-gray-800 border-b-2 border-blue-600 pb-1 mb-2">{title}</h3>
      <table className="w-full text-sm">
        <tbody>
          {Object.entries(rows).map(([key, val]) => (
            <tr key={key} className="border-b border-gray-100">
              <td className="py-2 pr-4 font-medium text-gray-600 w-1/4 align-top whitespace-nowrap">
                {key}
              </td>
              <td className="py-2 text-gray-800 whitespace-pre-wrap">{val}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
