"use client";

import React, { useState, useRef } from "react";

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
  const printRef = useRef<HTMLDivElement>(null);

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
    const node = printRef.current;
    if (!node) return;
    setPdfGenerating(true);
    setError("");
    try {
      // Client-side PDF generation (Mac Safari/Chrome compatible).
      // Browser rasterizes text → no font embedding needed.
      const [{ default: html2canvas }, jsPDFmod] = await Promise.all([
        import("html2canvas"),
        import("jspdf"),
      ]);
      const JsPDF = (jsPDFmod as any).jsPDF || (jsPDFmod as any).default;

      // Make the hidden node visible to the layout engine temporarily.
      node.style.display = "block";
      // Force reflow for Safari
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
        // Multi-page: slice the canvas vertically.
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

      const fileName = `求人票_${result.companyName || "job"}.pdf`;
      // Try multiple download strategies for Mac Chrome/Safari reliability.
      try {
        pdf.save(fileName);
      } catch {
        // Fallback 1: bloburl in new tab (Safari sometimes blocks anchor download)
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
      if (node) node.style.display = "none";
    } finally {
      setPdfGenerating(false);
    }
  };

  // Guaranteed fallback: open a new window with formatted HTML and call window.print().
  // Uses the browser's native "Save as PDF" — works on Mac Chrome & Safari unconditionally.
  const handlePrintPdf = () => {
    if (!result) return;
    const title = [result.companyName, result.jobTitle].filter(Boolean).join(" - ") || "求人票";
    const sections: { title: string; rows: Record<string, string> }[] = [
      { title: "募集概要", rows: result.overview || {} },
      { title: "仕事内容", rows: result.jobContent || {} },
      { title: "募集要項", rows: result.requirements || {} },
      { title: "仕事環境", rows: result.environment || {} },
    ].filter((s) => Object.keys(s.rows).length > 0);

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

          <div className="text-center space-y-3">
            <div className="flex flex-wrap gap-3 justify-center">
              <button
                onClick={handleDownloadPdf}
                disabled={pdfGenerating}
                className="bg-green-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-green-700 disabled:opacity-50"
              >
                {pdfGenerating ? "PDF生成中..." : "📥 PDFダウンロード"}
              </button>
              <button
                onClick={handlePrintPdf}
                className="bg-blue-600 text-white px-6 py-3 rounded-lg font-medium hover:bg-blue-700"
              >
                🖨 印刷 / PDFとして保存
              </button>
            </div>
            <p className="text-xs text-gray-500">
              ダウンロードが動かない場合は「印刷 / PDFとして保存」をお使いください（Mac標準の「PDFとして保存」が使えます）
            </p>
          </div>

          {/* Hidden print layout used by html2canvas */}
          <PrintLayout ref={printRef} data={result} />
        </div>
      )}
    </main>
  );
}

const PrintLayout = React.forwardRef<HTMLDivElement, { data: JobData }>(function PrintLayout({ data }, ref) {
  const title = [data.companyName, data.jobTitle].filter(Boolean).join(" - ") || "求人票";
  const sections: { title: string; rows: Record<string, string> }[] = [
    { title: "募集概要", rows: data.overview || {} },
    { title: "仕事内容", rows: data.jobContent || {} },
    { title: "募集要項", rows: data.requirements || {} },
    { title: "仕事環境", rows: data.environment || {} },
  ].filter((s) => Object.keys(s.rows).length > 0);

  return (
    <div
      ref={ref}
      style={{
        display: "none",
        position: "absolute",
        left: "-10000px",
        top: 0,
        width: "794px", // ~A4 @ 96dpi
        padding: "32px",
        background: "#ffffff",
        color: "#222",
        fontFamily:
          '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Noto Sans JP", system-ui, sans-serif',
        fontSize: "12px",
        lineHeight: 1.6,
        boxSizing: "border-box",
      }}
    >
      <div style={{ background: "#1e40af", color: "#fff", padding: "16px 20px", borderRadius: 6, marginBottom: 20 }}>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>{title}</div>
        {data.summary ? <div style={{ fontSize: 12, opacity: 0.92 }}>{data.summary}</div> : null}
      </div>
      {sections.map((s) => (
        <div key={s.title} style={{ marginBottom: 16 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: "#1e40af",
              borderBottom: "2px solid #1e40af",
              paddingBottom: 4,
              marginBottom: 8,
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
                      width: "26%",
                      background: "#f3f4f6",
                      padding: "8px 10px",
                      fontWeight: 700,
                      fontSize: 11,
                      color: "#4b5563",
                      verticalAlign: "top",
                    }}
                  >
                    {k}
                  </td>
                  <td style={{ padding: "8px 10px", fontSize: 11, verticalAlign: "top", whiteSpace: "pre-wrap" }}>
                    {v || "—"}
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
