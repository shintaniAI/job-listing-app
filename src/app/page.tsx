"use client";

import React, { useState, useRef, useEffect } from "react";

const STORAGE_KEY = "job-listing-app:state:v2";

type JobPosition = {
  jobTitle: string;
  summary: string;
  jobContent: Record<string, string>;
  requirements: Record<string, string>;
  salary: Record<string, string>;
  workConditions: Record<string, string>;
};

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
  positions?: JobPosition[];
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
const EMPTY_VALUES = new Set(["", "情報なし", "なし", "未記載", "—", "-", "N/A", "n/a", "該当なし", "未定"]);
function isEmptyValue(v: any): boolean {
  if (v === null || v === undefined) return true;
  const trimmed = String(v).trim();
  return EMPTY_VALUES.has(trimmed);
}
function filterEmptyRows(rows: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rows || {})) {
    if (!isEmptyValue(v)) out[k] = v;
  }
  return out;
}
// タイトル等のトップレベル文字列用: 「情報なし」等は空扱い
function cleanText(v: any): string {
  if (isEmptyValue(v)) return "";
  return String(v).trim();
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
  const [activePositionIndex, setActivePositionIndex] = useState(0);
  const [positionLoadingIdx, setPositionLoadingIdx] = useState<number | null>(null);

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

  // ポジション切替用: 表示するデータを合成
  const displayResult: JobData | null = React.useMemo(() => {
    if (!result) return null;
    const positions = result.positions;
    if (!positions || positions.length <= 1) return result;
    const idx = Math.min(activePositionIndex, positions.length - 1);
    const p = positions[idx];
    if (!p) return result;
    return {
      ...result,
      jobTitle: p.jobTitle || result.jobTitle,
      summary: p.summary || result.summary,
      jobContent: p.jobContent || result.jobContent,
      requirements: p.requirements || result.requirements,
      salary: p.salary || result.salary,
      workConditions: p.workConditions || result.workConditions,
    };
  }, [result, activePositionIndex]);

  // 選択中ポジションの詳細を後追いで生成
  const fetchPositionDetail = async (idx: number) => {
    if (!result || !result.positions) return;
    const p = result.positions[idx];
    if (!p) return;
    setPositionLoadingIdx(idx);
    setError("");
    try {
      const res = await fetch("/api/generate-position", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          positionTitle: p.jobTitle,
          companyName: result.companyName,
          sources: result.sources || [],
        }),
      });

      // JSONを安全にパース（Vercelのエラーページ対策）
      const raw = await res.text();
      let data: any = null;
      try {
        data = JSON.parse(raw);
      } catch {
        if (res.status === 504) {
          throw new Error("ポジション詳細の生成がタイムアウトしました (60秒超過)。\n再試行するか、別のポジションで試してください。");
        }
        if (res.status >= 500) {
          throw new Error(`サーバーエラー (${res.status})\n少し時間を置いて再試行してください。`);
        }
        throw new Error(`予期しないレスポンス (${res.status}): ${raw.slice(0, 200)}`);
      }
      if (!res.ok) throw new Error(data?.error || `ポジション詳細の生成に失敗しました (${res.status})`);

      const newPositions = [...(result.positions || [])];
      newPositions[idx] = {
        jobTitle: data.jobTitle || p.jobTitle,
        summary: data.summary || "",
        jobContent: data.jobContent || {},
        requirements: data.requirements || {},
        salary: data.salary || {},
        workConditions: data.workConditions || {},
      };
      setResult({ ...result, positions: newPositions });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setPositionLoadingIdx(null);
    }
  };

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

      // JSONを安全にパース（Vercelのエラーページ対策）
      const raw = await res.text();
      let data: any = null;
      try {
        data = JSON.parse(raw);
      } catch {
        if (res.status === 504) {
          throw new Error("処理がタイムアウトしました (60秒超過)。\n採用ページURLを直接入力すると安定します。\n例: https://open.talentio.com/...");
        }
        if (res.status >= 500) {
          throw new Error(`サーバーエラー (${res.status})\n少し時間を置いて再試行してください。`);
        }
        throw new Error(`予期しないレスポンス (${res.status}): ${raw.slice(0, 200)}`);
      }
      if (!res.ok) throw new Error(data?.error || `エラーが発生しました (${res.status})`);

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
        positions: Array.isArray(data.positions) ? data.positions : undefined,
        sources: data.sources || [],
      });
      setActivePositionIndex(0);

    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadPdf = async () => {
    if (!displayResult) return;
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

      const fileName = `求人票_${displayResult.companyName || "job"}${displayResult.jobTitle ? "_" + displayResult.jobTitle : ""}_${new Date().toISOString().slice(0, 10)}.pdf`;
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
    if (!displayResult) return;
    const title = [cleanText(displayResult.companyName), cleanText(displayResult.jobTitle)].filter(Boolean).join(" - ") || "求人票";
    const summaryClean = cleanText(displayResult.summary);
    const sections: { title: string; rows: Record<string, string> }[] = SECTION_DEFS
      .map(({ key, title }) => ({ title, rows: filterEmptyRows(((displayResult as any)[key] || {}) as Record<string, string>) }))
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
                  `<tr><th><div class="cell">${esc(k)}</div></th><td><div class="cell">${esc(v || "")}</div></td></tr>`
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
      body { font-family: "Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","Meiryo","Noto Sans JP",system-ui,sans-serif; color:#222; font-size:12px; line-height:1.5; letter-spacing:0.02em; margin:0; padding:24px; }
      .header { background:#1e40af; color:#fff; padding:16px 20px; border-radius:6px; margin-bottom:20px; }
      .header h1 { font-size:20px; margin:0 0 4px; line-height:1.4; }
      .header p { font-size:12px; margin:0; opacity:0.92; line-height:1.5; }
      .section { margin-bottom:18px; page-break-inside: avoid; }
      .section h2 { font-size:13px; color:#1e40af; border-bottom:2px solid #1e40af; padding-bottom:4px; margin:0 0 8px; line-height:1.4; }
      table { width:100%; border-collapse:collapse; table-layout:fixed; }
      th, td { padding:0; font-size:11px; border:1px solid #e5e7eb; height:1px; }
      th { width:26%; }
      th > .cell, td > .cell {
        display:flex; align-items:center; justify-content:flex-start;
        padding:12px 14px; min-height:40px; line-height:1.55;
        box-sizing:border-box;
      }
      th > .cell { background:#f3f4f6; color:#4b5563; font-weight:700; min-height:40px; }
      td > .cell { white-space:pre-wrap; word-break:break-word; }
    </style></head><body>
      <div class="header">
        <h1>${esc(title)}</h1>
        ${summaryClean ? `<p>${esc(summaryClean)}</p>` : ""}
      </div>
      ${
        result && result.positions && result.positions.length > 1
          ? `<p style="font-size:10px;color:#6b7280;margin:-12px 0 16px;">※ 本求人票は同社の募集ポジションのうち「${esc(
              displayResult.jobTitle
            )}」の内容です (全${result.positions.length}ポジション中)</p>`
          : ""
      }
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

  type SectionKey = "basicInfo" | "companyInfo" | "jobContent" | "requirements" | "salary" | "workConditions" | "holidays" | "benefits";

  // ポジション固有のセクションキー
  const POSITION_SECTIONS: SectionKey[] = ["jobContent", "requirements", "salary", "workConditions"];

  const hasMultiplePositions = (r: JobData | null) =>
    !!r && Array.isArray(r.positions) && r.positions.length > 1;

  // 複数ポジションモード時は positions[active] を編集
  const mutateSection = (
    section: SectionKey,
    mutator: (rows: Record<string, string>) => Record<string, string>
  ) => {
    if (!result) return;
    if (hasMultiplePositions(result) && POSITION_SECTIONS.includes(section)) {
      const positions = [...(result.positions || [])];
      const idx = Math.min(activePositionIndex, positions.length - 1);
      const current = { ...(positions[idx] as any) };
      current[section] = mutator(current[section] || {});
      positions[idx] = current;
      setResult({ ...result, positions });
    } else {
      setResult({ ...result, [section]: mutator((result as any)[section] || {}) });
    }
  };

  const updateField = (key: keyof JobData, value: string) => {
    if (!result) return;
    // jobTitle/summary も複数ポジション時は positions 側を更新
    if (hasMultiplePositions(result) && (key === "jobTitle" || key === "summary")) {
      const positions = [...(result.positions || [])];
      const idx = Math.min(activePositionIndex, positions.length - 1);
      positions[idx] = { ...positions[idx], [key]: value };
      setResult({ ...result, positions });
    } else {
      setResult({ ...result, [key]: value } as JobData);
    }
  };

  const updateSectionValue = (section: SectionKey, key: string, value: string) => {
    mutateSection(section, (src) => ({ ...src, [key]: value }));
  };

  const renameSectionKey = (section: SectionKey, oldKey: string, newKey: string) => {
    if (!newKey.trim() || oldKey === newKey) return;
    mutateSection(section, (src) => {
      if (newKey in src) return src; // 競合回避
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(src)) out[k === oldKey ? newKey : k] = v;
      return out;
    });
  };

  const deleteSectionRow = (section: SectionKey, key: string) => {
    mutateSection(section, (src) => {
      const out = { ...src };
      delete out[key];
      return out;
    });
  };

  const addSectionRow = (section: SectionKey) => {
    mutateSection(section, (src) => {
      let base = "新しい項目";
      let name = base;
      let i = 2;
      while (name in src) name = `${base}${i++}`;
      return { ...src, [name]: "" };
    });
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
          {/* ポジション切替タブ (2件以上のとき) */}
          {result.positions && result.positions.length > 1 && (
            <div className="bg-white rounded-xl border shadow-sm p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-gray-800">
                  📌 募集ポジション ({result.positions.length}件)
                </h3>
                <p className="text-xs text-gray-500">
                  タブで切替 / 詳細未生成のタブは「詳細を生成」ボタンで取得
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {result.positions.map((p, i) => {
                  const hasDetail = Object.keys(p.jobContent || {}).length > 0;
                  return (
                    <button
                      key={i}
                      onClick={() => setActivePositionIndex(i)}
                      className={`px-4 py-2 rounded-lg text-sm font-medium border transition ${
                        activePositionIndex === i
                          ? "bg-blue-600 text-white border-blue-600 shadow-sm"
                          : "bg-gray-50 text-gray-700 border-gray-200 hover:bg-gray-100"
                      }`}
                    >
                      {i + 1}. {p.jobTitle || "(職種未取得)"}
                      {!hasDetail && (
                        <span className={`ml-2 text-[10px] ${activePositionIndex === i ? "text-blue-100" : "text-amber-600"}`}>
                          ● 未生成
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              {/* 詳細生成ボタン */}
              {(() => {
                const active = result.positions[activePositionIndex];
                if (!active) return null;
                const hasDetail = Object.keys(active.jobContent || {}).length > 0;
                if (hasDetail) return null;
                const loading = positionLoadingIdx === activePositionIndex;
                return (
                  <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                    <p className="text-sm text-amber-800 mb-2">
                      「{active.jobTitle}」の詳細（仕事内容・応募資格・給与・勤務条件）はまだ生成されていません。
                    </p>
                    <button
                      type="button"
                      onClick={() => fetchPositionDetail(activePositionIndex)}
                      disabled={loading}
                      className="bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg"
                    >
                      {loading ? "🔄 生成中... (20〜40秒)" : "🚀 このポジションの詳細を生成"}
                    </button>
                  </div>
                );
              })()}
            </div>
          )}

          <div className="bg-white rounded-xl shadow-sm border p-6 space-y-6">
            <div className="border-b pb-4">
              <p className="text-sm text-blue-600 mb-3">
                ✏️ 各項目は直接編集できます。編集後の内容でPDFが生成されます。
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                <LabeledInput
                  label="会社名"
                  value={(displayResult || result).companyName}
                  onChange={(v) => updateField("companyName", v)}
                />
                <LabeledInput
                  label="職種"
                  value={(displayResult || result).jobTitle}
                  onChange={(v) => updateField("jobTitle", v)}
                />
              </div>

              <LabeledTextarea
                label="募集概要"
                value={(displayResult || result).summary}
                onChange={(v) => updateField("summary", v)}
                rows={3}
              />
            </div>

            {/* 8セクションの編集エリア */}
            {SECTION_DEFS.map(({ key, title }) => (
              <EditableSection
                key={key}
                title={title}
                rows={((displayResult || result)[key] as Record<string, string>) || {}}
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
          <PrintLayout ref={printRef} data={displayResult || result} />
        </div>
      )}
    </main>
  );
}

// 印刷レイアウトコンポーネント
const PrintLayout = React.forwardRef<HTMLDivElement, { data: JobData }>(function PrintLayout({ data }, ref) {
  const title = [cleanText(data.companyName), cleanText(data.jobTitle)].filter(Boolean).join(" - ") || "求人票";
  const summaryClean = cleanText(data.summary);
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
        lineHeight: 1.6,
        letterSpacing: "0.02em",
        boxSizing: "border-box",
      }}
    >
      {/* ヘッダー */}
      <div style={{ background: "#1e40af", color: "#fff", padding: "20px 24px", borderRadius: 6, marginBottom: 24 }}>
        <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 6, lineHeight: 1.4 }}>{title}</div>
        {summaryClean ? <div style={{ fontSize: 13, opacity: 0.92, lineHeight: 1.6 }}>{summaryClean}</div> : null}
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
              lineHeight: 1.6,
            }}
          >
            {s.title}
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <tbody>
              {Object.entries(s.rows).map(([k, v]) => (
                <tr key={k}>
                  <td
                    style={{
                      width: "28%",
                      padding: 0,
                      fontSize: 10,
                      border: "1px solid #e5e7eb",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "flex-start",
                        background: "#f9fafb",
                        color: "#374151",
                        fontWeight: 600,
                        padding: "12px 14px",
                        minHeight: "40px",
                        lineHeight: 1.55,
                        wordBreak: "break-word",
                        boxSizing: "border-box",
                      }}
                    >
                      {k}
                    </div>
                  </td>
                  <td
                    style={{
                      padding: 0,
                      fontSize: 10,
                      border: "1px solid #e5e7eb",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "flex-start",
                        padding: "12px 14px",
                        minHeight: "40px",
                        whiteSpace: "pre-wrap",
                        lineHeight: 1.55,
                        wordBreak: "break-word",
                        boxSizing: "border-box",
                      }}
                    >
                      {v || ""}
                    </div>
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