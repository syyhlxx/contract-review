import { Worker } from "node:worker_threads";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FILE_READ_DEADLINE_MS } from "./limits";

export type PdfText = {
  text: string;
  totalPages: number | null;
};

export type ExtractPdfOptions = {
  /** Hard stop. The worker is terminated when this elapses. */
  timeoutMs?: number;
  /** Aborted by the route's deadline. Also terminates the worker. */
  signal?: AbortSignal;
  /** "hang-sync" is for the unit test. Production leaves this unset. */
  mode?: "extract" | "hang-sync";
};

/**
 * Pull text out of a PDF in a worker thread.
 *
 * The worker file is loaded from the project folder, not from the Next.js
 * bundle. Turbopack rewrites import paths, and a rewritten path would not
 * point at a file node can execute.
 */
export function extractPdfInWorker(
  bytes: Uint8Array,
  options?: ExtractPdfOptions,
): Promise<PdfText> {
  const timeoutMs = options?.timeoutMs ?? FILE_READ_DEADLINE_MS;
  const mode = options?.mode ?? "extract";
  const workerUrl = pathToFileURL(path.join(process.cwd(), "lib", "review", "pdfWorker.mjs"));
  let worker: Worker;
  try {
    worker = new Worker(workerUrl, {
      workerData: {
        mode,
        bytes: Buffer.from(bytes),
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return Promise.reject(new Error(`Could not start the PDF reader. ${detail}`));
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const stop = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);
      worker.terminate().catch(() => {
        // terminate() rejects if the worker is already gone.
      });
      reject(error);
    };

    const timer = setTimeout(() => {
      const seconds = Math.max(1, Math.round(timeoutMs / 1000));
      stop(new Error(`PDF parsing was stopped after ${seconds} seconds.`));
    }, timeoutMs);

    const onAbort = () => {
      stop(new Error("PDF parsing was stopped because the upload time limit ran out."));
    };

    if (options?.signal?.aborted) onAbort();
    else options?.signal?.addEventListener("abort", onAbort);

    worker.on("message", (message: { ok?: boolean; text?: string; totalPages?: number | null; message?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);
      if (message?.ok) {
        resolve({
          text: message.text ?? "",
          totalPages: message.totalPages ?? null,
        });
        return;
      }
      worker.terminate().catch(() => {});
      reject(new Error(message?.message || "Could not read that PDF."));
    });

    worker.on("error", (error) => {
      stop(error instanceof Error ? error : new Error(String(error)));
    });

    worker.on("exit", (code) => {
      if (settled) return;
      if (code === 0) return;
      stop(new Error(`PDF parser exited with code ${code}.`));
    });
  });
}
