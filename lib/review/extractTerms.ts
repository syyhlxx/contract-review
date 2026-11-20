import { GoogleGenAI } from "@google/genai";
import { readFile } from "fs/promises";
import path from "path";
import { batchChunks, chunkLease, sectionCitation, type LeaseChunk, type LeaseChunkBatch } from "./chunkLease";
import {
  callGeminiWithRetry,
  describeGeminiFailure,
  GEMINI_MAX_ATTEMPTS,
  GEMINI_REQUEST_TIMEOUT_MS,
  type GeminiTextCall,
} from "./geminiRetry";
import { readLeaseTerms, type LeaseTerm } from "./leaseTermView";
import { MAX_LEASE_CHARS, MAX_MODEL_BATCH_CHARS, MODEL_BATCH_CONCURRENCY } from "./limits";
import { mergeLeaseTerms } from "./mergeLeaseTerms";

/**
 * Turns lease text into the JSON object the model returns.
 *
 * The upload route and POST /api/test both call `extractLeaseTerms`.
 * The wording of the prompt matches the original /api/test POST handler.
 * Do not rephrase it here: the model is following those instructions.
 *
 * A lease that fits in one batch is still one model call on the full text.
 * A longer lease is split by `chunkLease` and each batch is sent through
 * that same prompt. The lists of terms are merged, and a term with a blank
 * section is labeled from the chunk its quote came from.
 *
 * Each call is retried when Gemini is temporarily unavailable, and each
 * call has its own time limit. If one batch still fails, the terms from the
 * batches that succeeded are returned with a warning. The page shows that
 * warning. The whole request fails only when every batch failed.
 */

const MODEL = "gemini-3.8-flash";

/**
 * A normal Error plus an HTTP status, so route handlers can tell
 * "the file was bad" (400) from "the model failed" (502).
 */
export class LeaseExtractError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "LeaseExtractError";
    this.status = status;
  }
}

async function readPromptFiles(): Promise<{ instructions: string; example: string }> {
  const promptsDir = path.join(process.cwd(), "prompts");
  const instructions = await readFile(path.join(promptsDir, "extract-terms.md"), "utf-8");
  const example = await readFile(path.join(promptsDir, "example_output.json"), "utf-8");
  return { instructions, example };
}

/**
 * Build the exact prompt string POST /api/test used to build inline.
 * `leaseText` is appended unchanged.
 */
export async function buildLeasePrompt(leaseText: string): Promise<string> {
  const { instructions, example } = await readPromptFiles();
  return `${instructions}\n\nExample output:\n${example}\n\nLease:\n${leaseText}`;
}

/**
 * The original GET /api/test demo used a different wrapper around the same
 * files. Kept so that demo request still sends the same words as before.
 */
export async function buildDemoPrompt(leaseText: string): Promise<string> {
  const { instructions, example } = await readPromptFiles();
  return `${instructions}

${example}

Lease text: ${leaseText}
`;
}

function assertLeaseText(leaseText: string): void {
  if (leaseText.trim() === "") {
    throw new LeaseExtractError("leaseText is required", 400);
  }

  // Chunking splits leases that fit under this ceiling. Anything longer is
  // refused so one upload cannot turn into an unbounded run of model calls.
  if (leaseText.length > MAX_LEASE_CHARS) {
    throw new LeaseExtractError(
      `This lease is too long to extract (${leaseText.length.toLocaleString()} characters). The limit is ${MAX_LEASE_CHARS.toLocaleString()} characters even after splitting it into sections. Try a shorter file.`,
      400,
    );
  }
}

/**
 * How many model calls the most recent `extractLeaseTerms` made.
 * Tests read this. It is not safe to read across two overlapping requests,
 * and the page never does.
 */
let modelCalls = 0;

export function lastModelCallCount(): number {
  return modelCalls;
}

/**
 * Options for `extractLeaseTerms`. Production calls it with no options.
 * Tests pass a fake `call` so they can throw a 503 or return JSON without
 * touching the network. `sleep` and `random` stand in for the pause and the
 * jitter, the same way a Java test passes a Clock.
 */
export type ExtractLeaseTermsOptions = {
  call?: GeminiTextCall;
  maxAttempts?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Defaults to console.log, which shows up in the `npm run dev` terminal. */
  log?: (line: string) => void;
  /** Lease characters per model call. Defaults to MAX_MODEL_BATCH_CHARS. */
  maxBatchChars?: number;
  /** Model calls in flight at once. Defaults to MODEL_BATCH_CONCURRENCY. */
  concurrency?: number;
};

type AttemptOptions = {
  call?: GeminiTextCall;
  maxAttempts: number;
  timeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log: (line: string) => void;
};

type BatchFailure = {
  label: string;
  reason: string;
  error: unknown;
};

type BatchRun = {
  terms: LeaseTerm[] | null;
  failure: BatchFailure | null;
};

/**
 * Stand-in for Gemini when GEMINI_MOCK=1. Tests and local UI checks use this
 * so they do not need an API key. It is not used in a normal run.
 */
function mockLeaseTerms(leaseText: string): unknown {
  if (leaseText.includes("[[mock-model-failure]]")) {
    throw new LeaseExtractError(
      "The model request failed. Please try again in a moment.",
      502,
    );
  }

  const sentences = leaseText
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 20);

  const findSentence = (pattern: RegExp): string | null =>
    sentences.find((sentence) => pattern.test(sentence)) ?? null;

  const money = (quote: string | null): number | null => {
    if (!quote) return null;
    const match = quote.match(/\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/);
    if (!match) return null;
    const value = Number(match[1].replace(/,/g, ""));
    return Number.isFinite(value) ? value : null;
  };

  const addressed = (
    category: string,
    quote: string | null,
    details: Record<string, unknown> | null,
  ) => {
    if (!quote) {
      return { category, summary: null, details: null, source: null };
    }
    return {
      category,
      summary: quote,
      details,
      source: { section: null, page: null, quote },
    };
  };

  // Word boundaries keep "rent" from matching inside "renew".
  const rentQuote = findSentence(/\brent\b|\$\s*[0-9]/i);
  const termQuote = findSentence(/\bterm\b|\bbegins?\b|\bends?\b/i);
  const renewalQuote = findSentence(/\brenew/i);
  const terminationQuote = findSentence(/\bterminat/i);
  const depositQuote = findSentence(/\bdeposit\b/i);
  const petsQuote = findSentence(/\bpets?\b|\banimals?\b/i);
  const rentAmount = money(rentQuote);
  const depositAmount = money(depositQuote);

  return {
    lease_terms: [
      addressed(
        "rent",
        rentQuote,
        rentAmount == null ? null : { amount: rentAmount, currency: "USD", frequency: "monthly" },
      ),
      addressed("term", termQuote, null),
      addressed("renewal", renewalQuote, null),
      addressed("termination", terminationQuote, null),
      addressed(
        "deposit",
        depositQuote,
        depositAmount == null
          ? null
          : { amount: depositAmount, currency: "USD", frequency: "one time" },
      ),
      addressed("pets", petsQuote, null),
    ],
  };
}

/**
 * Run extraction on text that already has a prompt wrapped around it.
 * GET /api/test uses this with the original demo prompt. It is one call,
 * with the same retry and time limit as a batch.
 */
export async function extractFromPrompt(leaseText: string, prompt: string): Promise<unknown> {
  assertLeaseText(leaseText);
  if (process.env.GEMINI_MOCK === "1") {
    return mockLeaseTerms(leaseText);
  }
  requireApiKey();
  const options = resolveOptions();
  options.log("demo request sent");
  modelCalls += 1;
  return parseModelText(await requestModel(prompt, options));
}

/**
 * Extract lease terms from plain text.
 * Returns `{ lease_terms: [...] }`. When some sections could not be read,
 * `warnings` is also set. There is no schema validation: the page shows
 * whatever came back, and treats null summary/details/source as "Not addressed".
 *
 * Text that fits in one batch is one call. Longer text is split along
 * headings (see chunkLease) at MAX_MODEL_BATCH_CHARS, and the results are
 * merged into that same shape.
 */
export async function extractLeaseTerms(
  leaseText: string,
  options?: ExtractLeaseTermsOptions,
): Promise<{ lease_terms: LeaseTerm[]; warnings?: string[] }> {
  assertLeaseText(leaseText);
  modelCalls = 0;

  const usingMock = process.env.GEMINI_MOCK === "1";
  if (!usingMock && !options?.call) requireApiKey();

  const attempt = resolveOptions(options);
  const maxBatchChars = options?.maxBatchChars ?? MAX_MODEL_BATCH_CHARS;
  const chunks = chunkLease(leaseText, { maxChars: maxBatchChars });
  const batches = batchChunks(leaseText, chunks, maxBatchChars);
  if (batches.length === 0) {
    throw new LeaseExtractError("leaseText is required", 400);
  }

  const atOnce = Math.min(Math.max(options?.concurrency ?? MODEL_BATCH_CONCURRENCY, 1), batches.length);
  const batchWord = batches.length === 1 ? "batch" : "batches";
  attempt.log(
    `Extracting lease in ${batches.length} ${batchWord} (limit ${maxBatchChars} characters, ${atOnce} at a time).`,
  );

  // A failed batch returns a failure object. It does not throw, so the other
  // batches still finish. mapPool would stop the whole lease if the worker threw.
  const runs = await mapPool(batches, atOnce, (batch) =>
    extractBatch(batch, chunks, batches.length, attempt),
  );

  const okTerms: LeaseTerm[][] = [];
  const okBatches: LeaseChunkBatch[] = [];
  const failures: BatchFailure[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (run.failure || !run.terms) {
      failures.push(
        run.failure ?? {
          label: `part ${i + 1} of ${runs.length}, no section heading`,
          reason: "the response did not include lease terms",
          error: null,
        },
      );
      continue;
    }
    okTerms.push(run.terms);
    okBatches.push(batches[i]);
  }

  if (okTerms.length === 0) throw failureToError(failures);

  const merged = mergeLeaseTerms(okTerms, okBatches, chunks);
  if (failures.length === 0) return merged;
  return { ...merged, warnings: [formatWarning(failures)] };
}

function resolveOptions(options?: ExtractLeaseTermsOptions): AttemptOptions {
  return {
    call: options?.call,
    maxAttempts: options?.maxAttempts ?? GEMINI_MAX_ATTEMPTS,
    timeoutMs: options?.timeoutMs ?? GEMINI_REQUEST_TIMEOUT_MS,
    sleep: options?.sleep,
    random: options?.random,
    log: options?.log ?? ((line) => console.log(line)),
  };
}

function requireApiKey(): void {
  if (process.env.GEMINI_API_KEY) return;
  throw new LeaseExtractError(
    "The extraction service is not configured. Set GEMINI_API_KEY and try again.",
    500,
  );
}

async function runExtraction(leaseText: string, options: AttemptOptions): Promise<unknown> {
  modelCalls += 1;
  if (process.env.GEMINI_MOCK === "1") {
    return mockLeaseTerms(leaseText);
  }
  const prompt = await buildLeasePrompt(leaseText);
  return parseModelText(await requestModel(prompt, options));
}

/**
 * One model call, with retries. The SDK is told not to retry on its own
 * (`attempts: 1` counts the first try only) and to abort at our time limit.
 * `callGeminiWithRetry` does the retries so the log shows each one, and so
 * a Retry-After hint is honored. The SDK's retry does not read that hint.
 */
async function requestModel(prompt: string, options: AttemptOptions): Promise<string> {
  const call =
    options.call ??
    ((text, signal) => generateWithGemini(text, signal, options.timeoutMs));

  try {
    return await callGeminiWithRetry(prompt, {
      call,
      maxAttempts: options.maxAttempts,
      timeoutMs: options.timeoutMs,
      sleep: options.sleep,
      random: options.random,
      log: options.log,
    });
  } catch (error) {
    if (error instanceof LeaseExtractError) throw error;
    const message = error instanceof Error ? error.message : "The model request failed.";
    throw new LeaseExtractError(message, 502);
  }
}

async function generateWithGemini(
  prompt: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new LeaseExtractError(
      "The extraction service is not configured. Set GEMINI_API_KEY and try again.",
      500,
    );
  }

  // Same call the original route made: one model, JSON mime type, no schema.
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      abortSignal: signal,
      httpOptions: {
        timeout: timeoutMs,
        retryOptions: { attempts: 1 },
      },
    },
  });
  return response.text ?? "{}";
}

function parseModelText(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new LeaseExtractError(
      "The model returned a response that was not valid JSON.",
      502,
    );
  }
}

async function extractBatch(
  batch: LeaseChunkBatch,
  chunks: LeaseChunk[],
  batchCount: number,
  options: AttemptOptions,
): Promise<BatchRun> {
  const label = batchSectionLabel(batch, chunks, batchCount);
  const name = `batch ${batch.index + 1}/${batchCount}`;
  options.log(`${name} sent (${batch.text.length} characters of lease text)`);

  try {
    const payload = await runExtraction(batch.text, options);
    const terms = readLeaseTerms(payload);
    if (!terms) {
      const error = new LeaseExtractError(
        `The model returned a response that did not include lease terms (${label}).`,
        502,
      );
      options.log(`${name} failed (the response did not include lease terms)`);
      return {
        terms: null,
        failure: { label, reason: "the response did not include lease terms", error },
      };
    }
    options.log(`${name} ok`);
    return { terms, failure: null };
  } catch (error) {
    const reason = describeGeminiFailure(error).reason;
    options.log(`${name} failed (${reason})`);
    return { terms: null, failure: { label, reason, error } };
  }
}

/**
 * A name a person can match to the lease: "9. Deposit, part 2 of 4".
 * A piece with no heading (the text before the first section, or a lease
 * that has no headings) says so, instead of inventing a section number.
 */
function batchSectionLabel(
  batch: LeaseChunkBatch,
  chunks: LeaseChunk[],
  batchCount: number,
): string {
  const labels: string[] = [];
  for (const chunk of chunks) {
    if (!batch.chunkIndexes.includes(chunk.index)) continue;
    const label = sectionCitation(chunk);
    if (label && !labels.includes(label)) labels.push(label);
  }
  const part = `part ${batch.index + 1} of ${batchCount}`;
  if (labels.length === 0) return `${part}, no section heading`;
  return `${labels.join(", ")}, ${part}`;
}

function formatWarning(failures: BatchFailure[]): string {
  const list = failures.map((failure) => `${failure.label} — ${failure.reason}`).join("; ");
  return `Some sections could not be read after several tries, so their terms may be missing. The terms below are from the sections that succeeded. Failed sections: ${list}.`;
}

function failureToError(failures: BatchFailure[]): LeaseExtractError {
  if (failures.length === 1 && failures[0].error instanceof LeaseExtractError) {
    return failures[0].error;
  }
  const list = failures.map((failure) => `${failure.label} — ${failure.reason}`).join("; ");
  return new LeaseExtractError(`The model request failed. ${list}`, 502);
}

/**
 * Run `worker` on each item, a few at a time.
 *
 * JavaScript runs this function until it hits `await`, then runs another
 * one. The cursor increment below finishes before any await, so the workers
 * do not need a lock to share it.
 */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Math.min(Math.max(limit, 1), items.length);
  await Promise.all(Array.from({ length: workers }, () => run()));
  return results;
}
