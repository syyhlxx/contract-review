import { extractLeaseTerms, LeaseExtractError } from "@/lib/review/extractTerms";
import { FILE_READ_DEADLINE_MS, REQUEST_DEADLINE_MS } from "@/lib/review/limits";
import { parseDocument } from "@/lib/review/parseDocument";
import { readUploadedFile } from "@/lib/review/readUpload";
import {
  createExtractLog,
  deadlineDetails,
  DeadlineExceededError,
  withDeadline,
} from "@/lib/review/serverLog";
import type { ParsedContract } from "@/lib/review/types";

/**
 * POST /api/extract
 *
 * This is the route the Extract button calls. It is not /api/parse (that
 * one only reads a file) and not /api/test (that one takes JSON text).
 * There is no server action.
 *
 * The first thing this function does is record "POST /api/extract received".
 * That line is appended to logs/extract.log and also sent to stderr.
 * Turbopack often does not copy a route worker's stdout to the terminal
 * you are watching, which is why a previous run could time out with a
 * completely blank terminal. The page's error includes the same step trail.
 *
 * A PDF is read on a worker thread. PDF.js can block for minutes in
 * synchronous work. On this thread that would freeze the 60 second timer,
 * so the only error you would see is the outer 3 minute limit. The worker
 * can be killed while that work is still running.
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
  /** Override logs/extract.log. Tests pass a file of their own. */
  logFile?: string;
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
  const log = createExtractLog(limits?.logFile);

  // Before any await. The line is appended to logs/extract.log. The terminal
  // may not show a route worker's stdout; the file still has the step.
  log.mark("POST /api/extract received");

  try {
    const leaseTerms = await withDeadline(async (requestSignal) => {
      log.mark("reading upload");
      const { fileName, bytes } = await withDeadline(
        () => readUploadedFile(request),
        fileReadDeadlineMs,
        "reading the upload",
      );
      log.mark(`upload read: ${fileName} (${bytes.byteLength.toLocaleString("en-US")} bytes)`);

      log.mark(`reading text from ${fileName}`);
      const parsed = await withDeadline(
        (signal) =>
          parseDocument(fileName, bytes, {
            pdfTimeoutMs: fileReadDeadlineMs,
            signal,
          }),
        fileReadDeadlineMs,
        "reading the file",
      );
      read.parsed = parsed;
      const leaseText = parsed.text ?? "";
      const pages = parsed.pageCount == null ? "unknown pages" : `${parsed.pageCount} pages`;
      const clauseWord = parsed.clauses.length === 1 ? "clause" : "clauses";
      log.mark(
        `text extracted: ${leaseText.length.toLocaleString("en-US")} characters, ${pages}, ${parsed.clauses.length} ${clauseWord}`,
      );

      return extractLeaseTerms(leaseText, {
        log: log.mark,
        deadlineAt,
        requestSignal,
      });
    }, deadlineMs, "handling this upload");

    const parsed = read.parsed;
    log.mark(`POST /api/extract finished in ${elapsedSeconds(started)}`);
    return Response.json({
      fileName: parsed?.fileName,
      pageCount: parsed?.pageCount,
      clauses: parsed?.clauses,
      leaseTerms,
    });
  } catch (error) {
    const base = error instanceof Error ? error.message : "Could not extract lease terms.";
    // Build the page text before logging the failure, so "last logged step"
    // is the step that was in progress, not this failure line.
    const message = `${base} ${deadlineDetails(log)}`;
    log.mark(`POST /api/extract failed: ${base}`);
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
