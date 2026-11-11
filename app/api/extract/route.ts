import { extractLeaseTerms, LeaseExtractError } from "@/lib/review/extractTerms";
import { parseDocument } from "@/lib/review/parseDocument";
import { readUploadedFile } from "@/lib/review/readUpload";
import type { ParsedContract } from "@/lib/review/types";

/**
 * POST /api/extract
 *
 * Route handler for the upload box. The browser sends one file. This
 * function reads the text, then calls the same extraction used by /api/test.
 *
 * File problems (wrong type, empty, unreadable, too big) answer with status
 * 400. Model problems answer with the extraction error's status and, when
 * the file itself was readable, still include the clauses so the page can
 * show them.
 */
export async function POST(request: Request) {
  let parsed: ParsedContract | null = null;

  try {
    const { fileName, bytes } = await readUploadedFile(request);
    parsed = await parseDocument(fileName, bytes);
    const leaseText = parsed.text ?? "";
    const leaseTerms = await extractLeaseTerms(leaseText);

    return Response.json({
      fileName: parsed.fileName,
      pageCount: parsed.pageCount,
      clauses: parsed.clauses,
      leaseTerms,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not extract lease terms.";
    const status = error instanceof LeaseExtractError ? error.status : parsed ? 502 : 400;

    if (parsed) {
      return Response.json(
        {
          error: message,
          fileName: parsed.fileName,
          pageCount: parsed.pageCount,
          clauses: parsed.clauses,
        },
        { status },
      );
    }

    return Response.json({ error: message }, { status });
  }
}
