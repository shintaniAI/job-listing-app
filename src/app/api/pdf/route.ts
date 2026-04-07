import { NextRequest, NextResponse } from "next/server";
import React from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { JobPdfDocument } from "@/lib/pdf-template";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let parsed: any;
  try {
    parsed = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストボディが不正なJSONです" }, { status: 400 });
  }
  try {
    const { jobData } = parsed || {};
    if (!jobData || typeof jobData !== "object") {
      return NextResponse.json({ error: "データが必要です" }, { status: 400 });
    }

    // Exclude sources from PDF output
    const { sources: _omit, ...pdfData } = jobData;

    const element: any = React.createElement(JobPdfDocument as any, { data: pdfData });
    const pdfBuffer = await renderToBuffer(element);

    return new NextResponse(pdfBuffer as any, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="job_listing.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err: any) {
    console.error("PDF error:", err);
    return NextResponse.json(
      { error: "PDF生成に失敗しました: " + (err?.message || String(err)) },
      { status: 500 }
    );
  }
}
