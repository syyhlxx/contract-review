import mammoth from "mammoth";
import { extractText } from "unpdf";
import { splitClauses } from "./splitClauses";
import type { ParsedContract } from "./types";

const MAX_BYTES = 10 * 1024 * 1024;

function extensionOf(fileName: string): string {
  const parts = fileName.toLowerCase().split(".");
  return parts.length > 1 ? (parts.pop() as string) : "";
}

export async function parseDocument(
  fileName: string,
  bytes: Uint8Array,
): Promise<ParsedContract> {
  if (bytes.byteLength > MAX_BYTES) {
    throw new Error("File is larger than 10 MB.");
  }

  const ext = extensionOf(fileName);
  let text = "";
  let pageCount: number | null = null;

  if (ext === "pdf") {
    const extracted = await extractText(bytes, { mergePages: true });
    text = extracted.text;
    pageCount = extracted.totalPages;
  } else if (ext === "docx") {
    const result = await mammoth.extractRawText({
      buffer: Buffer.from(bytes),
    });
    text = result.value;
  } else if (ext === "txt") {
    text = new TextDecoder("utf-8").decode(bytes);
  } else {
    throw new Error("Use a PDF, Word (.docx), or plain text file.");
  }

  const clauses = splitClauses(text);
  if (clauses.length === 0) {
    throw new Error("No readable text was found in that file.");
  }

  return { fileName, pageCount, clauses };
}
