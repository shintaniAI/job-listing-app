export const MAX_REFERENCE_FILES = 5;
export const MAX_REFERENCE_FILE_SIZE_MB = 100;
export const MAX_REFERENCE_FILE_SIZE = MAX_REFERENCE_FILE_SIZE_MB * 1024 * 1024;
export const MAX_REFERENCE_TEXT_LENGTH = 50_000;

export type ReferenceDocument = {
  name: string;
  size: number;
  kind: "PDF" | "Excel";
  text: string;
  truncated: boolean;
};

type ExtractionResult = {
  text: string;
  truncated: boolean;
};

function getExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : "";
}

export function isSupportedReferenceFile(file: File): boolean {
  return [".pdf", ".xlsx", ".xls"].includes(getExtension(file.name));
}

async function extractPdfText(file: File): Promise<ExtractionResult> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url
  ).toString();

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    stopAtErrors: true,
  });
  const pdf = await loadingTask.promise;
  const pages: string[] = [];
  const pageLimit = Math.min(pdf.numPages, 200);
  let extractedCharacters = 0;

  for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => {
        if (!("str" in item)) return "";
        return `${item.str}${item.hasEOL ? "\n" : " "}`;
      })
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (pageText) {
      const formattedPage = `【PDF ${pageNumber}/${pdf.numPages}ページ】\n${pageText}`;
      pages.push(formattedPage);
      extractedCharacters += formattedPage.length;
    }
    if (extractedCharacters >= MAX_REFERENCE_TEXT_LENGTH) break;
  }

  const text = pages.join("\n\n");
  return {
    text,
    truncated: pdf.numPages > pageLimit || text.length > MAX_REFERENCE_TEXT_LENGTH,
  };
}

async function extractExcelText(file: File): Promise<ExtractionResult> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(await file.arrayBuffer(), {
    type: "array",
    cellDates: true,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    sheetRows: 5000,
  });

  const sheetNames = workbook.SheetNames.slice(0, 20);
  const sections: string[] = [];
  let extractedCharacters = 0;

  for (const sheetName of sheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false }).trim();
    if (csv) {
      const section = `【Excelシート: ${sheetName}】\n${csv}`;
      sections.push(section);
      extractedCharacters += section.length;
    }
    if (extractedCharacters >= MAX_REFERENCE_TEXT_LENGTH) break;
  }

  const text = sections.join("\n\n");
  return {
    text,
    truncated: workbook.SheetNames.length > sheetNames.length || text.length > MAX_REFERENCE_TEXT_LENGTH,
  };
}

export async function parseReferenceFile(file: File): Promise<ReferenceDocument> {
  if (!isSupportedReferenceFile(file)) {
    throw new Error(`${file.name}: PDFまたはExcel（.xlsx / .xls）を選択してください。`);
  }
  if (file.size > MAX_REFERENCE_FILE_SIZE) {
    throw new Error(`${file.name}: 1ファイル${MAX_REFERENCE_FILE_SIZE_MB}MB以下にしてください。`);
  }

  const extension = getExtension(file.name);
  const kind: ReferenceDocument["kind"] = extension === ".pdf" ? "PDF" : "Excel";
  const extraction = kind === "PDF" ? await extractPdfText(file) : await extractExcelText(file);
  const normalizedText = extraction.text.replace(/\u0000/g, "").trim();

  if (!normalizedText) {
    const detail = kind === "PDF" ? "画像PDFの可能性があります。OCR済みPDFを使用してください。" : "入力済みのセルが見つかりません。";
    throw new Error(`${file.name}: 文字を抽出できませんでした。${detail}`);
  }

  const truncated = extraction.truncated || normalizedText.length > MAX_REFERENCE_TEXT_LENGTH;
  return {
    name: file.name.slice(0, 200),
    size: file.size,
    kind,
    text: normalizedText.slice(0, MAX_REFERENCE_TEXT_LENGTH),
    truncated,
  };
}
