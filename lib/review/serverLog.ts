import { REQUEST_DEADLINE_MS } from "./limits";

/**
 * Write one progress line straight to the process output.
 *
 * Next.js prints its own "POST /api/extract 200" line only after the route
 * handler returns. `console.log` is also wrapped while a request is running.
 * Writing here shows each step while the handler is still working, which is
 * what you want when a PDF read or a model call is taking a long time.
 * A newline is enough for the terminal to display the line.
 */
export function serverLog(line: string): void {
  const text = line.endsWith("\n") ? line : `${line}\n`;
  try {
    process.stdout.write(text);
  } catch {
    console.log(line);
  }
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
    super(
      `${lead} Look at the terminal running npm run dev for the last step it printed.`,
    );
    this.name = "DeadlineExceededError";
  }
}

/**
 * Run `work` until it finishes or `ms` elapses, whichever comes first.
 *
 * The function passed in receives an AbortSignal. When the time is up, that
 * signal is aborted (so an HTTP call can be cancelled) and this function
 * rejects with DeadlineExceededError. The work's own later success or
 * failure is ignored, so it does not become an unhandled error.
 *
 * This is the same idea as a future with a deadline. The timer is not
 * unref'd: it has to stay alive or a hung call would never wake it.
 */
export async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  activity: string,
): Promise<T> {
  const controller = new AbortController();
  const limit = Number.isFinite(ms) && ms > 0 ? ms : REQUEST_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Set inside the timer, before abort, so a rejection caused by that abort
  // is still reported as the deadline and not as a generic abort.
  let timedOut = false;

  const pending = work(controller.signal).then(
    (value) => ({ kind: "ok" as const, value }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );

  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve({ kind: "timeout" });
    }, limit);
  });

  try {
    const outcome = await Promise.race([pending, timeout]);
    if (outcome.kind === "timeout" || timedOut) throw new DeadlineExceededError(limit, activity);
    if (outcome.kind === "error") throw outcome.error;
    return outcome.value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
