import { NextRequest, NextResponse } from "next/server";
import { PDFDocument, rgb, PDFFont, PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import path from "path";
import fs from "fs/promises";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

type Listing = { title: string; url: string; rawText: string };
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

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 42;
const CONTENT_W = A4.w - MARGIN * 2;

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  const lines = (text || "").replace(/\r/g, "").split("\n");
  for (const rawLine of lines) {
    if (rawLine === "") {
      out.push("");
      continue;
    }
    let current = "";
    for (const ch of Array.from(rawLine)) {
      const test = current + ch;
      let w: number;
      try {
        w = font.widthOfTextAtSize(test, size);
      } catch {
        // unknown glyph fallback
        current = test;
        continue;
      }
      if (w > maxWidth && current) {
        out.push(current);
        current = ch;
      } else {
        current = test;
      }
    }
    if (current) out.push(current);
  }
  return out;
}

function sanitize(s: string): string {
  // Remove control chars except newline/tab
  return (s || "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
}

export async function POST(req: NextRequest) {
  const rl = checkRateLimit(req, { scope: "pdf", limit: 20, windowMs: 60_000 });
  if (!rl.ok) return rateLimitResponse(rl);

  let data: SearchResult;
  try {
    data = (await req.json()) as SearchResult;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!data || !Array.isArray(data.sources)) {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  try {
    const fontDir = path.join(process.cwd(), "public", "fonts");
    const regularBytes = await fs.readFile(path.join(fontDir, "NotoSansJP-Regular.ttf"));
    const boldBytes = await fs.readFile(path.join(fontDir, "NotoSansJP-Bold.ttf"));

    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const font = await pdf.embedFont(regularBytes, { subset: true });
    const bold = await pdf.embedFont(boldBytes, { subset: true });

    let page: PDFPage = pdf.addPage([A4.w, A4.h]);
    let y = A4.h - MARGIN;

    const newPage = () => {
      page = pdf.addPage([A4.w, A4.h]);
      y = A4.h - MARGIN;
    };
    const ensure = (needed: number) => {
      if (y - needed < MARGIN + 24) newPage();
    };

    const drawText = (
      text: string,
      opts: {
        font?: PDFFont;
        size?: number;
        color?: [number, number, number];
        x?: number;
        maxWidth?: number;
        lineGap?: number;
      } = {}
    ) => {
      const f = opts.font ?? font;
      const size = opts.size ?? 10;
      const color = opts.color ?? [0.07, 0.09, 0.15];
      const x = opts.x ?? MARGIN;
      const maxWidth = opts.maxWidth ?? CONTENT_W;
      const lineGap = opts.lineGap ?? 2;
      const lineH = size + lineGap;
      const lines = wrapText(sanitize(text), f, size, maxWidth);
      for (const ln of lines) {
        ensure(lineH);
        page.drawText(ln, {
          x,
          y: y - size,
          size,
          font: f,
          color: rgb(color[0], color[1], color[2]),
        });
        y -= lineH;
      }
    };

    const hr = (color: [number, number, number] = [0.9, 0.91, 0.93]) => {
      ensure(6);
      page.drawLine({
        start: { x: MARGIN, y: y - 2 },
        end: { x: A4.w - MARGIN, y: y - 2 },
        thickness: 0.6,
        color: rgb(...color),
      });
      y -= 6;
    };

    // ===== Title =====
    drawText("求人媒体 横断検索 レポート", { font: bold, size: 18 });
    y -= 4;
    drawText(
      `生成日時: ${new Date(data.generatedAt || Date.now()).toLocaleString("ja-JP")}`,
      { size: 9, color: [0.4, 0.4, 0.45] }
    );
    y -= 6;

    // Filter box
    const filterEntries: Array<[string, string | undefined]> = [
      ["会社名", data.companyName],
      ["職種", data.jobTitle],
      ["勤務地", data.workLocation],
      ["雇用形態", data.employmentType],
      ["給与", data.salary],
      ["キーワード", data.keywords],
    ];
    const filters: Array<[string, string]> = filterEntries
      .filter((e): e is [string, string] => !!e[1]);

    // Background
    const boxTop = y;
    const filterLineH = 14;
    const boxH = 12 + 16 + filters.length * filterLineH + 8;
    ensure(boxH + 10);
    page.drawRectangle({
      x: MARGIN,
      y: y - boxH,
      width: CONTENT_W,
      height: boxH,
      color: rgb(0.94, 0.97, 1.0),
      borderColor: rgb(0.72, 0.83, 0.97),
      borderWidth: 0.8,
    });
    y -= 12;
    drawText("【絞り込み条件】", {
      font: bold,
      size: 10,
      color: [0.11, 0.31, 0.85],
      x: MARGIN + 10,
      maxWidth: CONTENT_W - 20,
    });
    y -= 2;
    for (const [k, v] of filters) {
      ensure(filterLineH);
      page.drawText(sanitize(`${k}:`), {
        x: MARGIN + 14,
        y: y - 10,
        size: 9.5,
        font: bold,
        color: rgb(0.22, 0.25, 0.32),
      });
      const keyW = bold.widthOfTextAtSize(`${k}: `, 9.5);
      // value may need wrapping
      const valueLines = wrapText(sanitize(v || ""), font, 9.5, CONTENT_W - 20 - keyW);
      valueLines.forEach((ln, idx) => {
        page.drawText(ln, {
          x: MARGIN + 14 + (idx === 0 ? keyW : 0),
          y: y - 10 - idx * filterLineH,
          size: 9.5,
          font,
          color: rgb(0.07, 0.09, 0.15),
        });
      });
      y -= filterLineH * Math.max(1, valueLines.length);
    }
    y = boxTop - boxH - 14;

    // ===== Sources =====
    for (const src of data.sources) {
      if (y < MARGIN + 140) newPage();
      // header bar
      const hH = 26;
      ensure(hH + 6);
      page.drawRectangle({
        x: MARGIN,
        y: y - hH,
        width: CONTENT_W,
        height: hH,
        color: rgb(0.15, 0.39, 0.92),
      });
      page.drawText(sanitize(`■ ${src.media}`), {
        x: MARGIN + 12,
        y: y - 17,
        size: 12,
        font: bold,
        color: rgb(1, 1, 1),
      });
      const rightText = sanitize(`${src.domain}  /  ${src.listings.length} 件ヒット`);
      const rtw = font.widthOfTextAtSize(rightText, 9);
      page.drawText(rightText, {
        x: MARGIN + CONTENT_W - rtw - 12,
        y: y - 16,
        size: 9,
        font,
        color: rgb(0.86, 0.92, 1),
      });
      y -= hH + 8;

      if (src.searchUrl) {
        drawText(`検索URL: ${src.searchUrl}`, {
          size: 8,
          color: [0.15, 0.39, 0.92],
        });
      }
      if (src.listings.length === 0) {
        y -= 2;
        drawText(src.note || "掲載なし／検索不可", {
          size: 10,
          color: [0.42, 0.45, 0.5],
        });
        y -= 10;
        continue;
      }
      src.listings.forEach((l, i) => {
        ensure(40);
        y -= 4;
        drawText(`求人 #${i + 1}  ${l.title || "（タイトルなし）"}`, {
          font: bold,
          size: 11,
        });
        if (l.url) {
          drawText(l.url, { size: 8, color: [0.15, 0.39, 0.92] });
        }
        y -= 2;
        hr();
        y -= 2;
        drawText(l.rawText || "（本文なし）", {
          size: 9.5,
          color: [0.12, 0.15, 0.22],
          lineGap: 3,
        });
        y -= 8;
      });
      y -= 6;
    }

    // Page numbers
    const pages = pdf.getPages();
    pages.forEach((p, i) => {
      const label = `${i + 1} / ${pages.length}`;
      const w = font.widthOfTextAtSize(label, 8);
      p.drawText(label, {
        x: (A4.w - w) / 2,
        y: 20,
        size: 8,
        font,
        color: rgb(0.6, 0.62, 0.67),
      });
    });

    const bytes = await pdf.save();
    const filename = encodeURIComponent(
      `求人まとめ_${data.companyName}_${data.jobTitle || ""}.pdf`
    );
    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err: any) {
    console.error("pdf error:", err);
    return NextResponse.json(
      { error: err?.message || "PDF生成に失敗しました" },
      { status: 500 }
    );
  }
}
