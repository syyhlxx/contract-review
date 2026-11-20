/**
 * Reads a PDF off the main thread.
 *
 * The route starts this file with node:worker_threads. PDF.js can spend a
 * long time in synchronous work. On the main thread that blocks every timer,
 * including the 60 second limit, so the page waits until the outer 3 minute
 * limit. In this worker the main thread stays free and can call terminate(),
 * which kills the worker even in the middle of that synchronous work.
 *
 * workerData.mode "hang-sync" is only for the unit test that checks the kill.
 */
import { parentPort, workerData } from "node:worker_threads";
import { extractText } from "unpdf";

if (workerData?.mode === "hang-sync") {
  while (true) {
    // Burn CPU until the parent terminates this worker.
  }
}

try {
  const bytes = new Uint8Array(workerData.bytes);
  const extracted = await extractText(bytes, { mergePages: true });
  const text = Array.isArray(extracted.text) ? extracted.text.join("\n") : String(extracted.text ?? "");
  parentPort.postMessage({
    ok: true,
    text,
    totalPages: typeof extracted.totalPages === "number" ? extracted.totalPages : null,
  });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  });
}
