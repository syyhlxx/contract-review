import mammoth from "mammoth";
import { extractText } from "unpdf";
import { MAX_UPLOAD_BYTES } from "./limits";
import { splitClauses } from "./splitClauses";
import type { ParsedContract } from "./types";

function extensionOf(fileName: string): string {
  const parts = fileName.toLowerCase().split(".");
  return parts.length > 1 ? (parts.pop() as string) : "";
}

export async function parseDocument(
  fileName: string,
  bytes: Uint8Array,
): Promise<ParsedContract> {
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error("File is larger than 10 MB.");
  }

  const ext = extensionOf(fileName);
  if (ext !== "pdf" && ext !== "docx" && ext !== "txt") {
    throw new Error("Use a PDF, Word (.docx), or plain text file.");
  }

  let text = "";
  let pageCount: number | null = null;

  try {
    if (ext === "pdf") {
      const extracted = await extractText(bytes, { mergePages: true });
      text = extracted.text;
      pageCount = extracted.totalPages;
    } else if (ext === "docx") {
      const result = await mammoth.extractRawText({
        buffer: Buffer.from(bytes),
      });
      text = result.value;
    } else {
      text = new TextDecoder("utf-8").decode(bytes);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message.replace(/\s+/g, " ").trim() : "";
    const brief = detail.length > 180 ? `${detail.slice(0, 177)}…` : detail;
    throw new Error(
      brief
        ? `Could not read that file. It may be damaged or image-only. ${brief}`
        : "Could not read that file. It may be damaged or image-only.",
    );
  }

  const cleaned = text.replace(/\u0000/g, "").replace(/\r\n/g, "\n").trim();
  const clauses = splitClauses(cleaned);
  if (clauses.length === 0) {
    throw new Error(
      "No readable text was found in that file. It may be empty, damaged, or a scanned image without text.",
    );
  }

  return { fileName, pageCount, clauses, text: cleaned };
}
