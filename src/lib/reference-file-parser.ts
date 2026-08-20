export const MAX_REFERENCE_FILES = 5;
export const MAX_REFERENCE_FILE_SIZE_MB = 100;
export const MAX_REFERENCE_FILE_SIZE = MAX_REFERENCE_FILE_SIZE_MB * 1024 * 1024;
export const MAX_REFERENCE_TEXT_LENGTH = 50_000;
export const MAX_REFERENCE_OCR_PAGES = 20;

export type ReferenceFileProgress = {
  phase: "extracting" | "loading-ocr" | "ocr";
  page: number;
  totalPages: number;
  progress?: number;
};

export type ReferenceDocument = {
  name: string;
  size: number;
  kind: "PDF" | "Excel";
  text: string;
  truncated: boolean;
  usedOcr: boolean;
};

type ExtractionResult = {
  text: string;
  truncated: boolean;
  usedOcr?: boolean;
};

type ProgressHandler = (progress: ReferenceFileProgress) => void;

function getExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : "";
}

function normalizeOcrText(text: string): string {
  return text
    .replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々])[ \t]+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々])/gu, "$1")
    .replace(/(\d)[ \t]+(?=[万億円年月日時分秒])/g, "$1");
}

export function isSupportedReferenceFile(file: File): boolean {
  return [".pdf", ".xlsx", ".xls"].includes(getExtension(file.name));
}

async function extractPdfText(file: File, onProgress?: ProgressHandler): Promise<ExtractionResult> {
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
  let ocrPageCount = 0;
  let skippedOcrPages = false;
  let ocrWorker: Awaited<ReturnType<typeof import("tesseract.js")["createWorker"]>> | null = null;
  let activeOcrPage = 0;

  try {
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      onProgress?.({ phase: "extracting", page: pageNumber, totalPages: pdf.numPages });
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      let pageText = content.items
        .map((item) => {
          if (!("str" in item)) return "";
          return `${item.str}${item.hasEOL ? "\n" : " "}`;
        })
        .join("")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      if (pageText.replace(/\s/g, "").length < 20) {
        if (ocrPageCount >= MAX_REFERENCE_OCR_PAGES) {
          skippedOcrPages = true;
        } else {
          activeOcrPage = pageNumber;
          if (!ocrWorker) {
            onProgress?.({ phase: "loading-ocr", page: pageNumber, totalPages: pdf.numPages });
            try {
              const Tesseract = await import("tesseract.js");
              ocrWorker = await Tesseract.createWorker(["jpn", "eng"], Tesseract.OEM.LSTM_ONLY, {
                logger: (message) => {
                  if (message.status !== "recognizing text") return;
                  onProgress?.({
                    phase: "ocr",
                    page: activeOcrPage,
                    totalPages: pdf.numPages,
                    progress: message.progress,
                  });
                },
              });
            } catch {
              throw new Error("OCRエンジンを読み込めませんでした。通信環境を確認して、もう一度お試しください。");
            }
          }

          const baseViewport = page.getViewport({ scale: 1 });
          const scale = Math.min(2, 2000 / Math.max(baseViewport.width, baseViewport.height));
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.ceil(viewport.width));
          canvas.height = Math.max(1, Math.ceil(viewport.height));
          const canvasContext = canvas.getContext("2d", { alpha: false });
          if (!canvasContext) throw new Error("OCR用の画像を作成できませんでした。");

          try {
            await page.render({ canvas, canvasContext, viewport, background: "white" }).promise;
            onProgress?.({ phase: "ocr", page: pageNumber, totalPages: pdf.numPages, progress: 0 });
            const recognition = await ocrWorker.recognize(canvas);
            const ocrText = normalizeOcrText(recognition.data.text)
              .replace(/[ \t]+\n/g, "\n")
              .replace(/\n{3,}/g, "\n\n")
              .trim();
            if (ocrText.length > pageText.length) pageText = ocrText;
            ocrPageCount += 1;
          } finally {
            canvas.width = 1;
            canvas.height = 1;
          }
        }
      }

      if (pageText) {
        const sourceLabel = ocrPageCount > 0 && activeOcrPage === pageNumber ? "・OCR" : "";
        const formattedPage = `【PDF ${pageNumber}/${pdf.numPages}ページ${sourceLabel}】\n${pageText}`;
        pages.push(formattedPage);
        extractedCharacters += formattedPage.length;
      }
      if (extractedCharacters >= MAX_REFERENCE_TEXT_LENGTH) break;
    }
  } finally {
    if (ocrWorker) await ocrWorker.terminate();
    await loadingTask.destroy();
  }

  const text = pages.join("\n\n");
  return {
    text,
    truncated:
      pdf.numPages > pageLimit ||
      skippedOcrPages ||
      extractedCharacters >= MAX_REFERENCE_TEXT_LENGTH ||
      text.length > MAX_REFERENCE_TEXT_LENGTH,
    usedOcr: ocrPageCount > 0,
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

export async function parseReferenceFile(file: File, onProgress?: ProgressHandler): Promise<ReferenceDocument> {
  if (!isSupportedReferenceFile(file)) {
    throw new Error(`${file.name}: PDFまたはExcel（.xlsx / .xls）を選択してください。`);
  }
  if (file.size > MAX_REFERENCE_FILE_SIZE) {
    throw new Error(`${file.name}: 1ファイル${MAX_REFERENCE_FILE_SIZE_MB}MB以下にしてください。`);
  }

  const extension = getExtension(file.name);
  const kind: ReferenceDocument["kind"] = extension === ".pdf" ? "PDF" : "Excel";
  const extraction = kind === "PDF" ? await extractPdfText(file, onProgress) : await extractExcelText(file);
  const normalizedText = extraction.text.replace(/\u0000/g, "").trim();

  if (!normalizedText) {
    const detail = kind === "PDF" ? "画像が不鮮明か、OCR対象ページに文字が見つかりませんでした。" : "入力済みのセルが見つかりません。";
    throw new Error(`${file.name}: 文字を抽出できませんでした。${detail}`);
  }

  const truncated = extraction.truncated || normalizedText.length > MAX_REFERENCE_TEXT_LENGTH;
  return {
    name: file.name.slice(0, 200),
    size: file.size,
    kind,
    text: normalizedText.slice(0, MAX_REFERENCE_TEXT_LENGTH),
    truncated,
    usedOcr: extraction.usedOcr || false,
  };
}
