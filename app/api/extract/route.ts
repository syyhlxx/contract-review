import { extractLeaseTerms, LeaseExtractError } from "@/lib/review/extractTerms";
import { FILE_READ_DEADLINE_MS, REQUEST_DEADLINE_MS } from "@/lib/review/limits";
import { parseDocument } from "@/lib/review/parseDocument";
import { readUploadedFile } from "@/lib/review/readUpload";
import { DeadlineExceededError, serverLog, withDeadline } from "@/lib/review/serverLog";
import type { ParsedContract } from "@/lib/review/types";

/**
 * POST /api/extract
 *
 * This is the route the Extract button calls. It is not /api/parse (that
 * one only reads a file) and not /api/test (that one takes JSON text).
 * There is no server action.
 *
 * The first thing this function does is write "POST /api/extract received"
 * to the terminal. Next.js prints its own request line only after this
 * function returns, so a hang with no log of our own looks like the click
 * did nothing. Reading the PDF happens before any model call, and that read
 * is logged on its own line so a stuck PDF is visible.
 *
 * File problems answer with status 400. A time limit answers with 504. Model
 * problems answer with the extraction error's status. When the file itself
 * was readable, the clauses are still included. A long lease that was only
 * partly read answers 200: `leaseTerms` holds the terms that succeeded and a
 * `warnings` list naming the sections that failed.
 */

export type ExtractRouteLimits = {
  /** Whole request, including the file read and every model call. */
  deadlineMs?: number;
  /** Reading the upload and pulling text out of it. */
  fileReadDeadlineMs?: number;
};

export async function POST(request: Request): Promise<Response> {
  return runExtract(request);
}

export async function runExtract(
  request: Request,
  limits?: ExtractRouteLimits,
): Promise<Response> {
  const deadlineMs = limits?.deadlineMs ?? REQUEST_DEADLINE_MS;
  const fileReadDeadlineMs = limits?.fileReadDeadlineMs ?? FILE_READ_DEADLINE_MS;
  const started = Date.now();
  const deadlineAt = started + deadlineMs;
  // A holder, not a `let` assigned inside the callback. TypeScript does not
  // notice an assignment that happens inside another function, and then treats
  // the variable as still null.
  const read: { parsed: ParsedContract | null } = { parsed: null };

  // Before any await. If the terminal never shows this line, the click did
  // not reach the server.
  serverLog("POST /api/extract received");

  try {
    const leaseTerms = await withDeadline(async (requestSignal) => {
      serverLog("reading upload");
      const { fileName, bytes } = await withDeadline(
        () => readUploadedFile(request),
        fileReadDeadlineMs,
        "reading the upload",
      );
      serverLog(`upload read: ${fileName} (${bytes.byteLength.toLocaleString("en-US")} bytes)`);

      serverLog(`reading text from ${fileName}`);
      const parsed = await withDeadline(
        () => parseDocument(fileName, bytes),
        fileReadDeadlineMs,
        "reading the file",
      );
      read.parsed = parsed;
      const leaseText = parsed.text ?? "";
      const pages = parsed.pageCount == null ? "unknown pages" : `${parsed.pageCount} pages`;
      const clauseWord = parsed.clauses.length === 1 ? "clause" : "clauses";
      serverLog(
        `text extracted: ${leaseText.length.toLocaleString("en-US")} characters, ${pages}, ${parsed.clauses.length} ${clauseWord}`,
      );

      return extractLeaseTerms(leaseText, {
        log: serverLog,
        deadlineAt,
        requestSignal,
      });
    }, deadlineMs, "handling this upload");

    const parsed = read.parsed;
    serverLog(`POST /api/extract finished in ${elapsedSeconds(started)}`);
    return Response.json({
      fileName: parsed?.fileName,
      pageCount: parsed?.pageCount,
      clauses: parsed?.clauses,
      leaseTerms,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not extract lease terms.";
    serverLog(`POST /api/extract failed: ${message}`);
    const parsed = read.parsed;
    const status =
      error instanceof LeaseExtractError
        ? error.status
        : error instanceof DeadlineExceededError
          ? error.status
          : parsed
            ? 502
            : 400;

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

function elapsedSeconds(started: number): string {
  const seconds = (Date.now() - started) / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
}
