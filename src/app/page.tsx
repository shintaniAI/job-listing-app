"use client";

import React, { useState, useRef, useEffect } from "react";

const STORAGE_KEY = "job-listing-app:state:v2";

type JobData = {
  companyName: string;
  jobTitle: string;
  summary: string;
  basicInfo: Record<string, string>;
  companyInfo: Record<string, string>;
  jobContent: Record<string, string>;
  requirements: Record<string, string>;
  salary: Record<string, string>;
  workConditions: Record<string, string>;
  holidays: Record<string, string>;
  benefits: Record<string, string>;
  sources?: string[];
};

// 新しい8セクション定義
const SECTION_DEFS: { key: keyof JobData; title: string }[] = [
  { key: "basicInfo", title: "1. 基本情報" },
  { key: "companyInfo", title: "2. 企業情報" },
  { key: "jobContent", title: "3. 仕事内容" },
  { key: "requirements", title: "4. 応募資格" },
  { key: "salary", title: "5. 給与・報酬" },
  { key: "workConditions", title: "6. 勤務条件" },
  { key: "holidays", title: "7. 休日・休暇" },
  { key: "benefits", title: "8. 福利厚生・待遇" },
];

// PDF生成用：値が空 or "情報なし" の行を除外
const EMPTY_VALUES = new Set(["", "情報なし", "なし", "未記載", "—", "-", "N/A", "n/a"]);
function filterEmptyRows(rows: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rows || {})) {
    const trimmed = (v || "").trim();
    if (!EMPTY_VALUES.has(trimmed)) {
      out[k] = v;
    }
  }
  return out;
}

export default function Home() {
  const [companyName, setCompanyName] = useState("");
  const [companyUrl, setCompanyUrl] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [salary, setSalary] = useState("");

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<JobData | null>(null);
  const [error, setError] = useState("");
  const [pdfGenerating, setPdfGenerating] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);
  const [hydrated, setHydrated] = useState(false);

  // 状態の復元
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s.companyName) setCompanyName(s.companyName);
        if (s.companyUrl) setCompanyUrl(s.companyUrl);
        if (s.jobTitle) setJobTitle(s.jobTitle);
        if (s.salary) setSalary(s.salary);
        if (s.result) setResult(s.result);
      }
    } catch {}
    setHydrated(true);
  }, []);

  // 自動保存
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ companyName, companyUrl, jobTitle, salary, result })
      );
    } catch {}
  }, [hydrated, companyName, companyUrl, jobTitle, salary, result]);

  const handleClearAll = () => {
    if (!confirm("入力と編集中の求人票をすべてリセットしますか？")) return;
    setCompanyName("");
    setCompanyUrl("");
    setJobTitle("");
    setSalary("");
    setResult(null);
    setError("");
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!companyName.trim() && !companyUrl.trim()) {
      setError("会社名または会社URLのいずれかを入力してください。");
      return;
    }

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

      // 新しい8セクション構造に対応
      setResult({
        companyName: data.companyName || "",
        jobTitle: data.jobTitle || "",
        summary: data.summary || "",
        basicInfo: data.basicInfo || {},
        companyInfo: data.companyInfo || {},
        jobContent: data.jobContent || {},
        requirements: data.requirements || {},
        salary: data.salary || {},
        workConditions: data.workConditions || {},
        holidays: data.holidays || {},
        benefits: data.benefits || {},
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
    const node = printRef.current;
    if (!node) return;
    setPdfGenerating(true);
    setError("");

    try {
      const [{ default: html2canvas }, jsPDFmod] = await Promise.all([
        import("html2canvas"),
        import("jspdf"),
      ]);
      const JsPDF = (jsPDFmod as any).jsPDF || (jsPDFmod as any).default;

      node.style.display = "block";
      void node.offsetHeight;

      const canvas = await html2canvas(node, {
        scale: 2,
        useCORS: true,
        backgroundColor: "#ffffff",
        windowWidth: node.scrollWidth,
      });

      node.style.display = "none";

      const imgData = canvas.toDataURL("image/png");
      const pdf = new JsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const margin = 10;
      const imgW = pageW - margin * 2;
      const imgH = (canvas.height * imgW) / canvas.width;

      if (imgH <= pageH - margin * 2) {
        pdf.addImage(imgData, "PNG", margin, margin, imgW, imgH);
      } else {
        const pageContentH = pageH - margin * 2;
        const pxPerMm = canvas.width / imgW;
        const sliceHpx = Math.floor(pageContentH * pxPerMm);
        let yPx = 0;
        let first = true;
        while (yPx < canvas.height) {
          const h = Math.min(sliceHpx, canvas.height - yPx);
          const slice = document.createElement("canvas");
          slice.width = canvas.width;
          slice.height = h;
          const ctx = slice.getContext("2d")!;
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, slice.width, slice.height);
          ctx.drawImage(canvas, 0, yPx, canvas.width, h, 0, 0, canvas.width, h);
          const sliceData = slice.toDataURL("image/png");
          if (!first) pdf.addPage();
          pdf.addImage(sliceData, "PNG", margin, margin, imgW, (h / pxPerMm));
          first = false;
          yPx += h;
        }
      }

      const fileName = `求人票_${result.companyName || "job"}_${new Date().toISOString().slice(0, 10)}.pdf`;
      try {
        pdf.save(fileName);
      } catch {
        const blob = pdf.output("blob") as Blob;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          a.remove();
          URL.revokeObjectURL(url);
        }, 2000);
      }
    } catch (err: any) {
      console.error(err);
      setError("PDF生成に失敗しました: " + (err?.message || String(err)));
    } finally {
      if (node) node.style.display = "none";
      setPdfGenerating(false);
    }
  };

  const handlePrintPdf = () => {
    if (!result) return;
    const title = [result.companyName, result.jobTitle].filter(Boolean).join(" - ") || "求人票";
    const sections: { title: string; rows: Record<string, string> }[] = SECTION_DEFS
      .map(({ key, title }) => ({ title, rows: filterEmptyRows(((result as any)[key] || {}) as Record<string, string>) }))
      .filter((s) => Object.keys(s.rows).length > 0);

    const esc = (s: string) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    const sectionsHtml = sections
      .map(
        (s) => `
      <div class="section">
        <h2>${esc(s.title)}</h2>
        <table>
          <tbody>
            ${Object.entries(s.rows)
              .map(
                ([k, v]) =>
                  `<tr><th>${esc(k)}</th><td>${esc(v || "—")}</td></tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>`
      )
      .join("");

    const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${esc(
      title
    )}</title><style>
      @page { size: A4; margin: 14mm; }
      * { box-sizing: border-box; }
      body { font-family: "Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","Meiryo","Noto Sans JP",system-ui,sans-serif; color:#222; font-size:12px; line-height:1.65; margin:0; padding:24px; }
      .header { background:#1e40af; color:#fff; padding:16px 20px; border-radius:6px; margin-bottom:20px; }
      .header h1 { font-size:20px; margin:0 0 4px; }
      .header p { font-size:12px; margin:0; opacity:0.92; }
      .section { margin-bottom:18px; page-break-inside: avoid; }
      .section h2 { font-size:13px; color:#1e40af; border-bottom:2px solid #1e40af; padding-bottom:4px; margin:0 0 8px; }
      table { width:100%; border-collapse:collapse; }
      th, td { padding:8px 10px; font-size:11px; vertical-align:top; border-bottom:1px solid #e5e7eb; }
      th { width:26%; background:#f3f4f6; color:#4b5563; font-weight:700; text-align:left; }
      td { white-space:pre-wrap; }
      .footer { margin-top:24px; text-align:center; font-size:9px; color:#9ca3af; }
      @media print { body { padding:0; } }
    </style></head><body>
      <div class="header">
        <h1>${esc(title)}</h1>
        ${result.summary ? `<p>${esc(result.summary)}</p>` : ""}
      </div>
      ${sectionsHtml}
      <div class="footer">
        <p>生成日: ${new Date().toLocaleDateString('ja-JP')} | 求人票自動生成システム v2.0</p>
      </div>
      <script>
        window.addEventListener('load', function(){
          setTimeout(function(){ window.focus(); window.print(); }, 200);
        });
      </script>
    </body></html>`;

    const w = window.open("", "_blank");
    if (!w) {
      setError("ポップアップがブロックされています。ブラウザのポップアップ許可を確認してください。");
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
  };

  const updateField = (key: keyof JobData, value: string) => {
    if (!result) return;
    setResult({ ...result, [key]: value } as JobData);
  };

  type SectionKey = "basicInfo" | "companyInfo" | "jobContent" | "requirements" | "salary" | "workConditions" | "holidays" | "benefits";

  const updateSectionValue = (section: SectionKey, key: string, value: string) => {
    if (!result) return;
    setResult({ ...result, [section]: { ...result[section], [key]: value } });
  };

  const renameSectionKey = (section: SectionKey, oldKey: string, newKey: string) => {
    if (!result) return;
    if (!newKey.trim() || oldKey === newKey) return;
    const src = result[section] || {};
    if (newKey in src) return; // 競合回避
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(src)) out[k === oldKey ? newKey : k] = v;
    setResult({ ...result, [section]: out });
  };

  const deleteSectionRow = (section: SectionKey, key: string) => {
    if (!result) return;
    const src = { ...(result[section] || {}) };
    delete src[key];
    setResult({ ...result, [section]: src });
  };

  const addSectionRow = (section: SectionKey) => {
    if (!result) return;
    const src = { ...(result[section] || {}) };
    let base = "新しい項目";
    let name = base;
    let i = 2;
    while (name in src) name = `${base}${i++}`;
    src[name] = "";
    setResult({ ...result, [section]: src });
  };

  return (
    <main className="max-w-4xl mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold text-center mb-2">📋 求人票自動生成アプリ v2.0</h1>
      <p className="text-center text-gray-500 mb-2">
        企業の公式採用ページから詳細情報を収集 → 8セクション構成の求人票を生成
      </p>
      <p className="text-center text-sm text-blue-600 mb-8">
        🎯 Talentio、Wantedly、HRMOS等の公式採用ページを最優先で検索・分析
      </p>

      <form onSubmit={handleSubmit} className="bg-white rounded-xl border shadow-sm p-6 mb-8 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            会社名 <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="例: 株式会社オリゾ"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            required
          />
          <p className="text-xs text-gray-500 mt-1">
            「{companyName || "会社名"} 採用」「{companyName || "会社名"} 求人 公式」で検索します
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            会社HP URL（任意）
          </label>
          <input
            type="url"
            value={companyUrl}
            onChange={(e) => setCompanyUrl(e.target.value)}
            placeholder="https://example.com（指定した場合は直接このページを優先分析）"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              職種（任意）
            </label>
            <input
              type="text"
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              placeholder="例: ソリューション営業"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              希望給与（任意）
            </label>
            <input
              type="text"
              value={salary}
              onChange={(e) => setSalary(e.target.value)}
              placeholder="例: 年収400万〜840万円"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-blue-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "🔍 企業採用ページを分析中..." : "🚀 詳細求人票を生成"}
        </button>
      </form>

      {loading && (
        <div className="text-center py-12">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-blue-600 border-t-transparent mb-4"></div>
          <div className="space-y-2">
            <p className="text-gray-700 font-medium">企業の公式採用ページを検索・分析しています...</p>
            <p className="text-sm text-gray-500">Talentio、Wantedly、HRMOS、企業サイトを優先的に調査中</p>
            <p className="text-xs text-gray-400">通常15-30秒で完了します</p>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4 mb-6 whitespace-pre-wrap">
          ❌ {error}
        </div>
      )}

      {result && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl shadow-sm border p-6 space-y-6">
            <div className="border-b pb-4">
              <p className="text-sm text-blue-600 mb-3">
                ✏️ 各項目は直接編集できます。編集後の内容でPDFが生成されます。
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
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
                label="募集概要"
                value={result.summary}
                onChange={(v) => updateField("summary", v)}
                rows={3}
              />
            </div>

            {/* 8セクションの編集エリア */}
            {SECTION_DEFS.map(({ key, title }) => (
              <EditableSection
                key={key}
                title={title}
                rows={(result[key] as Record<string, string>) || {}}
                onChangeValue={(k, v) => updateSectionValue(key as SectionKey, k, v)}
                onRenameKey={(oldK, newK) => renameSectionKey(key as SectionKey, oldK, newK)}
                onDeleteRow={(k) => deleteSectionRow(key as SectionKey, k)}
                onAddRow={() => addSectionRow(key as SectionKey)}
              />
            ))}
          </div>

          {/* 情報ソース表示 */}
          {result.sources && result.sources.length > 0 && (
            <div className="bg-gray-50 rounded-lg border p-4">
              <h3 className="font-bold text-gray-700 text-sm mb-2">📎 情報取得ソース</h3>
              <ul className="text-sm text-gray-600 space-y-1">
                {result.sources.map((src, i) => (
                  <li key={i} className="flex items-start">
                    <span className="text-blue-500 mr-2">•</span>
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

          {/* PDF生成ボタン */}
          <div className="text-center space-y-4">
            <div className="flex flex-wrap gap-3 justify-center">
              <button
                onClick={handleDownloadPdf}
                disabled={pdfGenerating}
                className="bg-green-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-green-700 disabled:opacity-50 shadow-sm"
              >
                {pdfGenerating ? "📄 PDF生成中..." : "📥 PDFダウンロード"}
              </button>
              <button
                onClick={handlePrintPdf}
                className="bg-blue-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-blue-700 shadow-sm"
              >
                🖨 印刷 / PDFとして保存
              </button>
              <button
                onClick={handleClearAll}
                className="bg-gray-200 text-gray-700 px-4 py-3 rounded-lg font-medium hover:bg-gray-300"
              >
                🗑 リセット
              </button>
            </div>
            <p className="text-xs text-gray-500">
              ダウンロードが動かない場合は「印刷 / PDFとして保存」をお使いください
            </p>
          </div>

          {/* 印刷用隠しレイアウト */}
          <PrintLayout ref={printRef} data={result} />
        </div>
      )}
    </main>
  );
}

// 印刷レイアウトコンポーネント
const PrintLayout = React.forwardRef<HTMLDivElement, { data: JobData }>(function PrintLayout({ data }, ref) {
  const title = [data.companyName, data.jobTitle].filter(Boolean).join(" - ") || "求人票";
  const sections: { title: string; rows: Record<string, string> }[] = SECTION_DEFS
    .map(({ key, title }) => ({ title, rows: filterEmptyRows(((data as any)[key] || {}) as Record<string, string>) }))
    .filter((s) => Object.keys(s.rows).length > 0);

  return (
    <div
      ref={ref}
      style={{
        display: "none",
        position: "absolute",
        left: "-10000px",
        top: 0,
        width: "794px",
        padding: "32px",
        background: "#ffffff",
        color: "#222",
        fontFamily: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Noto Sans JP", system-ui, sans-serif',
        fontSize: "11px",
        lineHeight: 1.5,
        boxSizing: "border-box",
      }}
    >
      {/* ヘッダー */}
      <div style={{ background: "#1e40af", color: "#fff", padding: "20px 24px", borderRadius: 6, marginBottom: 24 }}>
        <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>{title}</div>
        {data.summary ? <div style={{ fontSize: 13, opacity: 0.92, lineHeight: 1.4 }}>{data.summary}</div> : null}
        <div style={{ fontSize: 9, opacity: 0.7, marginTop: 8 }}>
          生成日: {new Date().toLocaleDateString('ja-JP')} | 求人票自動生成システム v2.0
        </div>
      </div>

      {/* セクション */}
      {sections.map((s) => (
        <div key={s.title} style={{ marginBottom: 18, pageBreakInside: 'avoid' }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: "#1e40af",
              borderBottom: "2px solid #1e40af",
              paddingBottom: 6,
              marginBottom: 10,
            }}
          >
            {s.title}
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <tbody>
              {Object.entries(s.rows).map(([k, v]) => (
                <tr key={k} style={{ borderBottom: "1px solid #e5e7eb" }}>
                  <td
                    style={{
                      width: "28%",
                      background: "#f9fafb",
                      padding: "10px 12px",
                      fontWeight: 600,
                      fontSize: 10,
                      color: "#374151",
                      verticalAlign: "top",
                      border: "1px solid #e5e7eb",
                    }}
                  >
                    {k}
                  </td>
                  <td
                    style={{
                      padding: "10px 12px",
                      fontSize: 10,
                      verticalAlign: "top",
                      whiteSpace: "pre-wrap",
                      border: "1px solid #e5e7eb",
                      lineHeight: 1.4,
                    }}
                  >
                    {v || "情報なし"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
});

// ヘルパーコンポーネント
function LabeledInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  );
}

function LabeledTextarea({ label, value, onChange, rows = 3 }: { label: string; value: string; onChange: (v: string) => void; rows?: number }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  );
}

function EditableSection({
  title,
  rows,
  onChangeValue,
  onRenameKey,
  onDeleteRow,
  onAddRow,
}: {
  title: string;
  rows: Record<string, string>;
  onChangeValue: (key: string, value: string) => void;
  onRenameKey: (oldKey: string, newKey: string) => void;
  onDeleteRow: (key: string) => void;
  onAddRow: () => void;
}) {
  const entries = Object.entries(rows || {});
  const itemCount = entries.length;
  
  return (
    <div className="border rounded-lg p-4 bg-gray-50">
      <div className="flex items-center justify-between border-b-2 border-blue-600 pb-2 mb-4">
        <div>
          <h3 className="font-bold text-gray-800 text-lg">{title}</h3>
          <p className="text-xs text-gray-500 mt-1">項目数: {itemCount}個</p>
        </div>
        <button
          type="button"
          onClick={onAddRow}
          className="text-sm bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded-lg px-3 py-2 font-medium"
        >
          ＋項目を追加
        </button>
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-gray-400 italic text-center py-4 bg-white rounded border-2 border-dashed border-gray-200">
          項目がありません。「＋項目を追加」から追加できます。
        </p>
      ) : (
        <div className="space-y-3">
          {entries.map(([key, val], idx) => (
            <KeyValueRow
              key={`${idx}-${key}`}
              rowKey={key}
              value={val}
              onChangeValue={(v) => onChangeValue(key, v)}
              onRenameKey={(newK) => onRenameKey(key, newK)}
              onDelete={() => onDeleteRow(key)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function KeyValueRow({
  rowKey,
  value,
  onChangeValue,
  onRenameKey,
  onDelete,
}: {
  rowKey: string;
  value: string;
  onChangeValue: (v: string) => void;
  onRenameKey: (newKey: string) => void;
  onDelete: () => void;
}) {
  const [localKey, setLocalKey] = React.useState(rowKey);
  
  React.useEffect(() => setLocalKey(rowKey), [rowKey]);
  
  const commitKey = () => {
    const trimmed = localKey.trim();
    if (!trimmed) {
      setLocalKey(rowKey);
      return;
    }
    if (trimmed !== rowKey) onRenameKey(trimmed);
  };

  return (
    <div className="bg-white rounded-lg border p-3 shadow-sm">
      <div className="flex flex-col lg:flex-row gap-3 items-start">
        <div className="lg:w-1/3">
          <input
            type="text"
            value={localKey}
            onChange={(e) => setLocalKey(e.target.value)}
            onBlur={commitKey}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              }
            }}
            className="w-full border border-gray-200 bg-blue-50 rounded px-3 py-2 text-sm font-medium text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white"
            placeholder="項目名"
          />
        </div>
        <div className="flex-1">
          <textarea
            value={value}
            onChange={(e) => onChangeValue(e.target.value)}
            rows={Math.max(2, Math.min(6, (value || "").split("\n").length + 1))}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="詳細情報を入力..."
          />
        </div>
        <button
          type="button"
          onClick={onDelete}
          title="この項目を削除"
          className="text-red-500 hover:bg-red-50 border border-red-200 rounded px-3 py-2 text-sm font-medium hover:text-red-700"
        >
          🗑 削除
        </button>
      </div>
    </div>
  );
}