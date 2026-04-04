import { NextRequest, NextResponse } from "next/server";
import ReactPDF from "@react-pdf/renderer";
import { JobPdfDocument } from "@/lib/pdf-template";

export async function POST(req: NextRequest) {
  try {
    const { jobData } = await req.json();
    if (!jobData) {
      return NextResponse.json({ error: "データが必要です" }, { status: 400 });
    }

    const stream = await ReactPDF.renderToStream(JobPdfDocument({ data: jobData }));

    const chunks: Buffer[] = [];
    for await (const chunk of stream as any) {
      chunks.push(Buffer.from(chunk));
    }
    const pdfBuffer = Buffer.concat(chunks);

    return new NextResponse(pdfBuffer, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="job_listing.pdf"`,
      },
    });
  } catch (err: any) {
    console.error("PDF error:", err);
    return NextResponse.json({ error: "PDF生成に失敗しました: " + err.message }, { status: 500 });
  }
}
