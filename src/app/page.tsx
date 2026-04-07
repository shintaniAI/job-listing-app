"use client";

import { useState } from "react";

type JobData = {
  companyName: string;
  jobTitle: string;
  summary: string;
  overview: Record<string, string>;
  jobContent: Record<string, string>;
  requirements: Record<string, string>;
  environment: Record<string, string>;
  sources?: string[];
};

export default function Home() {
  const [companyName, setCompanyName] = useState("");
  const [companyUrl, setCompanyUrl] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [salary, setSalary] = useState("");

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<JobData | null>(null);
  const [error, setError] = useState("");
  const [pdfGenerating, setPdfGenerating] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName: companyName.trim(),
          companyUrl: companyUrl.trim(),
          jobTitle: jobTitle.trim(),
          salary: salary.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "エラーが発生しました");
      setResult({
        companyName: data.companyName || "",
        jobTitle: data.jobTitle || "",
        summary: data.summary || "",
        overview: data.overview || {},
        jobContent: data.jobContent || {},
        requirements: data.requirements || {},
        environment: data.environment || {},
        sources: data.sources || [],
      });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadPdf = async () => {
    if (!result) return;
    setPdfGenerating(true);
    setError("");
    try {
      const res = await fetch("/api/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobData: result }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error("PDF生成に失敗しました: " + txt);
      }
      const raw = await res.blob();
      // Safari: force correct MIME type so the anchor download works.
      const blob = new Blob([raw], { type: "application/pdf" });
      const fileName = `求人票_${result.companyName || "job"}.pdf`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.rel = "noopener";
      a.target = "_blank"; // Safari fallback: opens in new tab if download attr ignored
      document.body.appendChild(a);
      a.click();
      // Safari needs the anchor + object URL alive briefly after click.
      setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
      }, 1500);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setPdfGenerating(false);
    }
  };

  const updateField = (key: keyof JobData, value: string) => {
    if (!result) return;
    setResult({ ...result, [key]: value } as JobData);
  };

  const updateSection = (
    section: "overview" | "jobContent" | "requirements" | "environment",
    key: string,
    value: string
  ) => {
    if (!result) return;
    setResult({
      ...result,
      [section]: { ...result[section], [key]: value },
    });
  };

  return (
    <main className="max-w-3xl mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold text-center mb-2">📋 求人票自動生成</h1>
      <p className="text-center text-gray-500 mb-8">
        会社情報を入力 → 外部ソースから収集 → 編集 → PDF出力
      </p>

      <form onSubmit={handleSubmit} className="bg-white rounded-xl border shadow-sm p-6 mb-8 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            会社名（任意）
          </label>
          <input
            type="text"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="例: 〇〇クリニック"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            会社HP URL（任意）
          </label>
          <input
            type="url"
            value={companyUrl}
            onChange={(e) => setCompanyUrl(e.target.value)}
            placeholder="https://example.com（未入力ならSerpAPIで会社名検索）"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            職種（任意）
          </label>
          <input
            type="text"
            value={jobTitle}
            onChange={(e) => setJobTitle(e.target.value)}
            placeholder="例: 看護師 / フロントエンドエンジニア"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            給与（任意）
          </label>
          <input
            type="text"
            value={salary}
            onChange={(e) => setSalary(e.target.value)}
            placeholder="例: 月給28万円〜35万円"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-blue-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "生成中..." : "求人票を生成"}
        </button>
      </form>

      {loading && (
        <div className="text-center py-12">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-blue-600 border-t-transparent mb-4"></div>
          <p className="text-gray-500">求人情報を収集・整理しています...</p>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4 mb-6 whitespace-pre-wrap">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl shadow-sm border p-6 space-y-4">
            <p className="text-xs text-gray-500">✏️ 各項目は直接編集できます。編集後の内容でPDFが生成されます。</p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <LabeledInput
                label="会社名"
                value={result.companyName}
                onChange={(v) => updateField("companyName", v)}
              />
              <LabeledInput
                label="職種"
                value={result.jobTitle}
                onChange={(v) => updateField("jobTitle", v)}
              />
            </div>
            <LabeledTextarea
              label="募集概要（summary）"
              value={result.summary}
              onChange={(v) => updateField("summary", v)}
              rows={2}
            />

            <EditableSection
              title="募集概要"
              rows={result.overview}
              onChange={(k, v) => updateSection("overview", k, v)}
            />
            <EditableSection
              title="仕事内容"
              rows={result.jobContent}
              onChange={(k, v) => updateSection("jobContent", k, v)}
            />
            <EditableSection
              title="募集要項"
              rows={result.requirements}
              onChange={(k, v) => updateSection("requirements", k, v)}
            />
            <EditableSection
              title="仕事環境"
              rows={result.environment}
              onChange={(k, v) => updateSection("environment", k, v)}
            />
          </div>

          {result.sources && result.sources.length > 0 && (
            <div className="bg-gray-50 rounded-lg border p-4">
              <h3 className="font-bold text-gray-700 text-sm mb-2">📎 情報ソース（PDFには含まれません）</h3>
              <ul className="text-sm text-gray-500 space-y-1">
                {result.sources.map((src, i) => (
                  <li key={i}>
                    {src.startsWith("http") ? (
                      <a href={src} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline break-all">
                        {src}
                      </a>
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

function LabeledInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  );
}

function LabeledTextarea({
  label,
  value,
  onChange,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  );
}

function EditableSection({
  title,
  rows,
  onChange,
}: {
  title: string;
  rows: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  const entries = Object.entries(rows || {});
  if (entries.length === 0) return null;
  return (
    <div>
      <h3 className="font-bold text-gray-800 border-b-2 border-blue-600 pb-1 mb-2">{title}</h3>
      <div className="space-y-2">
        {entries.map(([key, val]) => (
          <div key={key} className="flex flex-col md:flex-row gap-2">
            <div className="md:w-1/4 text-sm font-medium text-gray-600 pt-2">{key}</div>
            <textarea
              value={val}
              onChange={(e) => onChange(key, e.target.value)}
              rows={Math.max(2, Math.min(6, (val || "").split("\n").length + 1))}
              className="flex-1 border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
