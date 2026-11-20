/**
 * Retry a single Gemini call when the failure is temporary.
 *
 * A temporary failure is one the same request may succeed on if we wait and
 * try again: the service is busy (503 UNAVAILABLE), the quota is used up
 * (429 RESOURCE_EXHAUSTED), the server had an internal error (500), or the
 * connection dropped. A 400-class error means the request itself is wrong.
 * Sending it again will fail the same way, so those are not retried, except
 * 429, which is the "too many requests" case.
 *
 * This is an ordinary loop around a remote call. `await` pauses this function
 * the way a blocking call pauses one thread, but it does not freeze the
 * server: Node runs other requests while this one is waiting. There is no
 * shared lock. JavaScript runs one function until it hits `await`.
 *
 * The Gemini SDK can retry on its own, and it can wait for the server's
 * deadline (several minutes) when no timeout is set. We do not use that.
 * Each attempt has its own time limit, the wait between attempts is decided
 * here, and every retry is written to the server log.
 */

import { DeadlineExceededError } from "./serverLog";

/** First try plus three retries. Four total. */
export const GEMINI_MAX_ATTEMPTS = 4;

/**
 * How long one attempt may run before we cancel it and retry.
 * A one-to-two page batch normally answers in a few seconds. 45 seconds is
 * long enough for a slow answer and short enough that a hung call does not
 * sit there for the several minutes Gemini's own deadline allows.
 */
export const GEMINI_REQUEST_TIMEOUT_MS = 45_000;

/** First retry waits about this long. Each later retry doubles it. */
export const GEMINI_RETRY_BASE_MS = 1_000;

/** The doubled wait never grows past this. */
export const GEMINI_RETRY_MAX_MS = 30_000;

/**
 * A Retry-After hint longer than this is cut down. A hint of 32 seconds is
 * honored. A hint of many minutes is not, so one lease cannot stall the page.
 */
export const GEMINI_MAX_HINT_WAIT_MS = 60_000;

/**
 * HTTP statuses worth sending again.
 * 502 and 504 are included with 500 and 503: they are temporary gateway
 * failures, the same class of problem. 408 is not included. It is a 4xx
 * status, and 429 is the only 4xx we retry.
 */
const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504]);

/**
 * Google's status names for the same temporary failures, used when the
 * response has a name but no HTTP code.
 */
const RETRYABLE_RPC = new Set([
  "UNAVAILABLE",
  "RESOURCE_EXHAUSTED",
  "INTERNAL",
  "DEADLINE_EXCEEDED",
  "ABORTED",
]);

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * What one attempt at Gemini looks like.
 * `signal` is aborted when the time limit fires, which cancels the HTTP
 * request. Tests pass a function with this same shape and never open a socket.
 */
export type GeminiTextCall = (prompt: string, signal: AbortSignal) => Promise<string>;

export type GeminiRetryOptions = {
  call: GeminiTextCall;
  maxAttempts?: number;
  timeoutMs?: number;
  /** Stand-in for the pause between retries. Tests record the delay and return. */
  sleep?: (ms: number) => Promise<void>;
  /** Stand-in for Math.random(). Must return a number from 0 to 1. */
  random?: () => number;
  log?: (line: string) => void;
  /**
   * When this returns true, stop. The upload's overall time limit has run
   * out, so another retry would only keep the page spinning.
   */
  stop?: () => boolean;
};

/**
 * What `describeGeminiFailure` reads off an error.
 * `label` is the short token in the log line ("503", "timeout", "network").
 * `reason` is the phrase shown on the page next to a failed section.
 * `retryAfterMs` is the server's hint, when it sent one.
 */
export type GeminiFailure = {
  retryable: boolean;
  label: string;
  reason: string;
  retryAfterMs: number | null;
};

type GeminiErrorBody = {
  error?: {
    code?: unknown;
    message?: unknown;
    status?: unknown;
    details?: unknown;
  };
};

/**
 * Call Gemini, and on a temporary failure wait and try again.
 *
 * `LeaseExtractError` (see extractTerms.ts) is our own error: empty text, a
 * missing API key, a response that is not JSON. The class sets its `name`.
 * Those are not temporary, so they are thrown again immediately. Checking the
 * name avoids importing that class from here, which would be a cycle.
 */
export async function callGeminiWithRetry(
  prompt: string,
  options: GeminiRetryOptions,
): Promise<string> {
  const maxAttempts = clampAttempts(options.maxAttempts ?? GEMINI_MAX_ATTEMPTS);
  const timeoutMs = options.timeoutMs ?? GEMINI_REQUEST_TIMEOUT_MS;
  const sleep = options.sleep ?? delay;
  const random = options.random ?? Math.random;
  const log = options.log ?? ((line) => {
    // The route passes serverLog. This fallback is for a direct call.
    process.stdout.write(`${line}\n`);
  });

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.stop?.()) {
      throw new DeadlineExceededError(0, "extracting lease terms");
    }
    try {
      return await runOneAttempt(options.call, prompt, timeoutMs);
    } catch (error) {
      lastError = error;
      if (isOurExtractError(error) || isDeadlineError(error)) throw error;
      if (options.stop?.()) {
        throw new DeadlineExceededError(0, "extracting lease terms");
      }

      const failure = describeGeminiFailure(error);
      const retriesLeft = attempt < maxAttempts;
      if (!failure.retryable || !retriesLeft) {
        const noun = attempt === 1 ? "attempt" : "attempts";
        throw new Error(
          `The model request failed after ${attempt} ${noun}. ${briefError(error)}`,
        );
      }

      // `attempt` is the try that just failed, so the first failure is "retry 1".
      const waitMs = retryWaitMs(attempt, failure.retryAfterMs, random);
      log(`retry ${attempt} after ${failure.label}, waiting ${formatWait(waitMs)}`);
      await sleep(waitMs);
    }
  }

  // The loop either returns or throws. This line is here so TypeScript
  // knows the function does not fall off the end.
  throw lastError instanceof Error ? lastError : new Error("The model request failed.");
}

/**
 * One attempt. The timer and the call run together, like a Future with a
 * deadline. Whichever finishes first wins. The timer aborts `signal` so the
 * HTTP request does not keep running after we have given up on it.
 *
 * The call's failure is caught inside `pending`. A late rejection after the
 * timer has already won is then not an unhandled error.
 */
async function runOneAttempt(
  call: GeminiTextCall,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : GEMINI_REQUEST_TIMEOUT_MS;

  const pending = call(prompt, controller.signal).then(
    (text) => ({ kind: "ok" as const, text }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    // This timer is intentionally not unref'd. It is the deadline for the
    // attempt. If the call hangs, this timer is what wakes us up. The pause
    // between retries (delay) is unref'd so a shutdown is not held open by it.
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "timeout" });
    }, limit);
  });

  try {
    const outcome = await Promise.race([pending, timeout]);
    if (outcome.kind === "timeout") {
      throw new ModelTimeoutError(limit);
    }
    if (outcome.kind === "error") throw outcome.error;
    return outcome.text;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class ModelTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The model did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
    this.name = "ModelTimeoutError";
  }
}

/**
 * Decide whether an error is worth retrying, and pull out a log label,
 * a page-facing reason, and any retry hint.
 *
 * The Gemini SDK throws `ApiError`. Its `status` is the HTTP code, and its
 * `message` is the JSON body, for example
 * {"error":{"code":503,"message":"Deadline expired before operation could complete.","status":"UNAVAILABLE"}}.
 * A dropped connection is a TypeError ("fetch failed") or an error whose
 * `code` is ECONNRESET, ETIMEDOUT, and the like.
 */
export function describeGeminiFailure(error: unknown): GeminiFailure {
  const http = readHttpStatus(error);
  const rpc = readRpcStatus(error);
  const timeout = isTimeout(error);
  const network = isNetworkError(error);

  let retryable = false;
  if (http != null && http >= 400 && http < 500) {
    retryable = http === 429;
  } else if (http != null && RETRYABLE_HTTP.has(http)) {
    retryable = true;
  } else if (http == null && rpc != null && RETRYABLE_RPC.has(rpc)) {
    retryable = true;
  } else if (http == null && (timeout || network)) {
    retryable = true;
  }

  return {
    retryable,
    label: failureLabel(http, rpc, timeout, network),
    reason: failureReason(http, rpc, timeout, network),
    retryAfterMs: retryable ? readRetryAfterMs(error) : null,
  };
}

/**
 * How long to wait before retry number `retryNumber` (1 is the first retry).
 *
 * The wait doubles each time, then a random factor between half and all of
 * that wait is kept. The random part is jitter: if every failed request
 * retried after the exact same delay, they would hit the quota together
 * again. `random` returns 0 to 1, the same contract as `Math.random()`.
 *
 * When the server sends a hint (RetryInfo.retryDelay, or a Retry-After
 * header, or "retry in 32s" in the message), the wait is at least that hint.
 * The hint does not replace a longer backoff, and it is capped at one minute.
 */
export function retryWaitMs(
  retryNumber: number,
  hintMs: number | null,
  random: () => number,
): number {
  const step = Math.max(1, Math.floor(retryNumber));
  const exponential = GEMINI_RETRY_BASE_MS * 2 ** (step - 1);
  const capped = Math.min(GEMINI_RETRY_MAX_MS, exponential);
  const roll = clampUnit(random());
  const jittered = Math.round(capped * (0.5 + roll * 0.5));
  if (hintMs == null || !Number.isFinite(hintMs) || hintMs <= 0) return jittered;
  return Math.min(GEMINI_MAX_HINT_WAIT_MS, Math.max(jittered, Math.round(hintMs)));
}

function failureLabel(
  http: number | null,
  rpc: string | null,
  timeout: boolean,
  network: boolean,
): string {
  if (http != null) return String(http);
  if (timeout) return "timeout";
  if (network) return "network";
  if (rpc) return rpc;
  return "error";
}

function failureReason(
  http: number | null,
  rpc: string | null,
  timeout: boolean,
  network: boolean,
): string {
  if (http != null && rpc) return `${http} ${rpc}`;
  if (http != null) return String(http);
  if (timeout) return "timed out";
  if (network) return "network error";
  if (rpc) return rpc;
  return "the model request failed";
}

function readHttpStatus(error: unknown): number | null {
  const fromBody = numericStatus(readErrorJson(error)?.error?.code);

  // LeaseExtractError.status is the status we send the browser (usually 502),
  // not Gemini's code. The Gemini code, when we have one, is in the message.
  if (error instanceof Error && error.name === "LeaseExtractError") return fromBody;

  if (fromBody != null) return fromBody;
  if (!error || typeof error !== "object") return null;
  const record = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  return numericStatus(record.status) ?? numericStatus(record.statusCode) ?? numericStatus(record.code);
}

function readRpcStatus(error: unknown): string | null {
  const status = readErrorJson(error)?.error?.status;
  if (typeof status !== "string") return null;
  const trimmed = status.trim();
  if (!trimmed || /^\d+$/.test(trimmed)) return null;
  return trimmed;
}

function readRetryAfterMs(error: unknown): number | null {
  const details = readErrorJson(error)?.error?.details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (!detail || typeof detail !== "object") continue;
      const delay = parseDurationMs((detail as { retryDelay?: unknown }).retryDelay);
      if (delay != null) return delay;
    }
  }

  const header = readHeader(error, "retry-after");
  if (header != null) {
    const seconds = Number(header.trim());
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  }

  const message = error instanceof Error ? error.message : "";
  const inline = /retry in\s+(\d+(?:\.\d+)?)(ms|s|m)\b/i.exec(message);
  if (!inline) return null;
  return durationFromParts(Number(inline[1]), inline[2].toLowerCase());
}

/**
 * Google's JSON encodes a duration as a string such as "32s" or "500ms",
 * or as an object `{ seconds, nanos }` from the protobuf form.
 */
function parseDurationMs(value: unknown): number | null {
  if (typeof value === "string") {
    const match = /^(\d+(?:\.\d+)?)(ms|s|m)$/i.exec(value.trim());
    if (!match) return null;
    return durationFromParts(Number(match[1]), match[2].toLowerCase());
  }

  if (!value || typeof value !== "object") return null;
  const seconds = (value as { seconds?: unknown }).seconds;
  const nanos = (value as { nanos?: unknown }).nanos;
  if (seconds == null && nanos == null) return null;
  const sec = typeof seconds === "number" ? seconds : typeof seconds === "string" ? Number(seconds) : 0;
  const nano = typeof nanos === "number" ? nanos : 0;
  if (!Number.isFinite(sec) || !Number.isFinite(nano)) return null;
  return Math.round(sec * 1000 + nano / 1_000_000);
}

function durationFromParts(amount: number, unit: string): number | null {
  if (!Number.isFinite(amount) || amount < 0) return null;
  if (unit === "ms") return Math.round(amount);
  if (unit === "s") return Math.round(amount * 1000);
  if (unit === "m") return Math.round(amount * 60_000);
  return null;
}

function readHeader(error: unknown, name: string): string | null {
  if (!error || typeof error !== "object") return null;
  const headers = (error as { headers?: unknown }).headers;
  if (!headers) return null;

  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get: (key: string) => unknown }).get(name);
    return typeof value === "string" ? value : null;
  }

  if (typeof headers !== "object") return null;
  const record = headers as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === name && typeof value === "string") return value;
  }
  return null;
}

function readErrorJson(error: unknown): GeminiErrorBody | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const start = message.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed: unknown = JSON.parse(message.slice(start));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as GeminiErrorBody;
  } catch {
    return null;
  }
}

function numericStatus(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 100 || value > 599) return null;
  return value;
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "ModelTimeoutError" || error.name === "AbortError" || error.name === "TimeoutError") {
    return true;
  }
  return /did not answer within|operation was aborted/i.test(error.message);
}

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error) || isTimeout(error)) return false;
  if (codeOf(error) != null && NETWORK_CODES.has(codeOf(error) as string)) return true;
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && codeOf(cause) != null && NETWORK_CODES.has(codeOf(cause) as string)) {
    return true;
  }
  return /fetch failed|network error|socket hang up|ECONNRESET|ETIMEDOUT|ECONNREFUSED/i.test(error.message);
}

function codeOf(error: Error): string | null {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function isOurExtractError(error: unknown): boolean {
  return error instanceof Error && error.name === "LeaseExtractError";
}

function isDeadlineError(error: unknown): boolean {
  return error instanceof DeadlineExceededError || (error instanceof Error && error.name === "DeadlineExceededError");
}

function briefError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown model error";
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > 400 ? `${oneLine.slice(0, 397)}…` : oneLine;
}

function formatWait(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  const rounded = Math.round(seconds * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded.toFixed(0)}s` : `${rounded.toFixed(1)}s`;
}

function clampAttempts(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.floor(value);
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    unrefTimer(setTimeout(resolve, ms));
  });
}

/**
 * Node's timer has `unref`, so a pending sleep does not keep the process
 * alive. In the DOM typings a timer id is a number and has no such method.
 * The cast is how those two descriptions of the same function are told apart.
 */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const candidate = timer as unknown as { unref?: () => void };
  if (typeof candidate.unref === "function") candidate.unref();
}
