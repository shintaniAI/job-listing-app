import { NextRequest, NextResponse } from "next/server";
import React from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { JobPdfDocument } from "@/lib/pdf-template";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { jobData } = await req.json();
    if (!jobData) {
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
