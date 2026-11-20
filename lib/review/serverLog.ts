import fs from "node:fs";
import path from "node:path";
import { REQUEST_DEADLINE_MS } from "./limits";

/**
 * Where progress is written, relative to the project folder.
 * The dev-server terminal on Windows often never shows a route's stdout:
 * Turbopack runs the route in a worker and does not copy that stream to the
 * window you are watching. This file is the copy you can open.
 */
export const EXTRACT_LOG_PATH = path.join("logs", "extract.log");

export type ExtractLog = {
  /** Absolute path of the file this session appends to. */
  filePath: string;
  /** One step. Also written to the log file and to stderr. */
  mark: (step: string) => void;
  /** The last step that was logged. Empty if nothing has been logged. */
  last: () => string;
  /** How long since this session started, such as "60.0s". */
  elapsed: () => string;
  /** Every step, oldest first, with the time it was logged. */
  trail: () => string;
};

type MarkedStep = { elapsedMs: number; step: string };

/**
 * One upload's progress. `mark` writes a timestamped line to logs/extract.log
 * and tries to show the same line in the terminal.
 *
 * `fs.writeSync` on the stderr handle skips the buffer that `console.log`
 * and `process.stdout.write` use when the handle is a pipe. `console.error`
 * is also called because Next forwards console calls from the route worker
 * to the terminal; a raw write often stays inside the worker.
 */
export function createExtractLog(filePath = defaultLogFile()): ExtractLog {
  const started = Date.now();
  const steps: MarkedStep[] = [];

  const mark = (step: string) => {
    const elapsedMs = Date.now() - started;
    steps.push({ elapsedMs, step });
    const text = `${new Date().toISOString()} ${formatElapsed(elapsedMs)} ${step}\n`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, text);
    } catch {
      // The page still gets the step trail even if the disk write fails.
    }
    emitToTerminal(text);
  };

  return {
    filePath,
    mark,
    last: () => steps[steps.length - 1]?.step ?? "(no step was logged)",
    elapsed: () => formatElapsed(Date.now() - started),
    trail: () =>
      steps.length === 0
        ? "(no step was logged)"
        : steps.map((entry) => `${entry.step} (${formatElapsed(entry.elapsedMs)})`).join("; "),
  };
}

/**
 * Progress line for code that does not have the request's log session.
 * Writes to the same file. The upload route passes its session's `mark`
 * instead, so one request stays in order.
 */
export function serverLog(line: string): void {
  createExtractLog().mark(line);
}

function defaultLogFile(): string {
  const override = process.env.EXTRACT_LOG_PATH;
  if (override && override.trim() !== "") return path.resolve(override);
  return path.resolve(process.cwd(), EXTRACT_LOG_PATH);
}

function emitToTerminal(text: string): void {
  // console.error, not stdout. Next.js forwards console calls from the route
  // worker to the dev terminal. It does not forward raw stdout, which is why
  // process.stdout.write left the Windows terminal blank. The log file is
  // written separately and does not depend on that terminal.
  console.error(text.trimEnd());
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
}

/**
 * The work took longer than we allow. `status` is 504 so the page can tell
 * this apart from a bad file (400) and a model failure (502).
 */
export class DeadlineExceededError extends Error {
  readonly status = 504;

  constructor(ms: number, activity: string) {
    const seconds = Math.round(ms / 1000);
    const lead =
      seconds > 0
        ? `Stopped after ${seconds} seconds while ${activity}.`
        : `Stopped while ${activity} because the upload time limit ran out.`;
    super(`${lead} Look at logs/extract.log in the project folder.`);
    this.name = "DeadlineExceededError";
  }
}

/**
 * Sentence added to the error the page shows, so the owner does not have to
 * guess which step was last.
 */
export function deadlineDetails(log: ExtractLog): string {
  return `Last logged step: "${log.last()}" (${log.elapsed()} elapsed). Step trail: ${log.trail()}. Log file: ${log.filePath}`;
}

/**
 * Run `work` until it finishes or `ms` elapses, whichever comes first.
 *
 * The timer is armed before `work` is called. A long synchronous PDF parse
 * still blocks this thread until it returns, so the timer cannot fire during
 * that stretch. PDF parsing therefore runs in a worker thread, which this
 * thread can kill. See extractPdf.ts.
 *
 * An error raised by `work` is kept when it is already a DeadlineExceededError.
 * That is the more specific one (for example "reading the file" rather than
 * the outer "handling this upload").
 */
export async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  activity: string,
): Promise<T> {
  const controller = new AbortController();
  const limit = Number.isFinite(ms) && ms > 0 ? ms : REQUEST_DEADLINE_MS;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve({ kind: "timeout" });
    }, limit);
  });

  const pending = new Promise<{ kind: "ok"; value: T } | { kind: "error"; error: unknown }>(
    (resolve) => {
      Promise.resolve()
        .then(() => work(controller.signal))
        .then(
          (value) => resolve({ kind: "ok", value }),
          (error: unknown) => resolve({ kind: "error", error }),
        );
    },
  );

  try {
    const outcome = await Promise.race([pending, timeout]);
    if (outcome.kind === "error" && outcome.error instanceof DeadlineExceededError) {
      throw outcome.error;
    }
    if (outcome.kind === "timeout" || timedOut) throw new DeadlineExceededError(limit, activity);
    if (outcome.kind === "error") throw outcome.error;
    return outcome.value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
