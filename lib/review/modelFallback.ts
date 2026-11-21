import {
  callGeminiWithRetry,
  describeGeminiFailure,
  retryWaitMs,
  type GeminiFailure,
} from "./geminiRetry";
import { DeadlineExceededError } from "./serverLog";

/**
 * Models the upload will try, in order.
 *
 * The primary is Gemini 3.8 Flash, which is what this app already called.
 * It is often overloaded (503 / 504) even when the key's quota is fresh.
 * `gemini-flash-latest` is not a fallback: as of late 2026 it resolves to
 * `gemini-3.8-flash`, the same model.
 *
 * The fallbacks are different, lighter models that accept generateContent:
 * Gemini 3.6 Flash, then Gemini 3.5 Flash-Lite (the budget model). Both are
 * stable ids in the Gemini API, not aliases of 3.8.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

export const DEFAULT_GEMINI_FALLBACKS = ["gemini-3.6-flash", "gemini-3.5-flash-lite"] as const;

/**
 * Read GEMINI_MODEL and GEMINI_FALLBACK_MODELS.
 *
 * GEMINI_FALLBACK_MODELS is a comma-separated list. An empty value means
 * "no fallback" (retry the primary only). When the variable is unset, the
 * defaults above are used. The API key is never read here.
 */
type GeminiEnv = { GEMINI_MODEL?: string; GEMINI_FALLBACK_MODELS?: string };

export function loadGeminiModels(env: GeminiEnv = process.env as GeminiEnv): string[] {
  const primary = (env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL).trim() || DEFAULT_GEMINI_MODEL;
  const configured = env.GEMINI_FALLBACK_MODELS;
  const fallbackSource = configured === undefined ? DEFAULT_GEMINI_FALLBACKS.join(",") : configured;
  const models = [primary];
  for (const part of fallbackSource.split(",")) {
    const name = part.trim();
    if (!name || models.includes(name)) continue;
    models.push(name);
  }
  return models;
}

/**
 * Which model the rest of this upload will call.
 * `index` only moves forward. That is the circuit breaker: once 3.8 Flash
 * has failed over, later batches do not go back to it.
 */
export type ModelCircuit = {
  models: string[];
  index: number;
  consecutive500: number;
  consecutive429: number;
};

export function createModelCircuit(models: string[]): ModelCircuit {
  return {
    models: models.length > 0 ? models : [DEFAULT_GEMINI_MODEL],
    index: 0,
    consecutive500: 0,
    consecutive429: 0,
  };
}

export function currentModel(circuit: ModelCircuit): string {
  return circuit.models[circuit.index] ?? circuit.models[0];
}

export type FailureDecision = "retry-same" | "switch" | "stop";

/**
 * Decide what to do after one attempt fails.
 *
 * 503 / UNAVAILABLE and 504 / DEADLINE_EXCEEDED mean this model is overloaded
 * or already out of time. Switch immediately. Do not spend the rest of the
 * retries on it.
 *
 * 500 / INTERNAL switches on the second one in a row ("repeated").
 * 429 still backs off once on this model. A second 429 tries the next model,
 * because the limit is often per model.
 * A dropped connection or our own timeout stays on the same model.
 * A 400-class error (other than 429) stops. Another try will fail the same way.
 *
 * When there is no next model, an overload is retried on the last model
 * instead of switching.
 */
export function decideAfterFailure(circuit: ModelCircuit, failure: GeminiFailure): FailureDecision {
  if (!failure.retryable) return "stop";

  const code = failure.label;
  const reason = failure.reason;
  let switchNow = false;

  if (code === "503" || code === "UNAVAILABLE" || reason.includes("UNAVAILABLE")) {
    switchNow = true;
  } else if (code === "504" || code === "DEADLINE_EXCEEDED" || reason.includes("DEADLINE_EXCEEDED")) {
    switchNow = true;
  } else if (code === "500" || code === "INTERNAL" || reason.startsWith("500")) {
    circuit.consecutive500 += 1;
    switchNow = circuit.consecutive500 >= 2;
  } else if (code === "429" || code === "RESOURCE_EXHAUSTED" || reason.includes("RESOURCE_EXHAUSTED")) {
    circuit.consecutive429 += 1;
    switchNow = circuit.consecutive429 >= 2;
  }

  if (!switchNow) return "retry-same";
  if (circuit.index >= circuit.models.length - 1) return "retry-same";

  circuit.index += 1;
  circuit.consecutive500 = 0;
  circuit.consecutive429 = 0;
  return "switch";
}

export function noteModelSuccess(circuit: ModelCircuit): void {
  circuit.consecutive500 = 0;
  circuit.consecutive429 = 0;
}

/**
 * Call `call` until a model answers, or every model has been given up on.
 * `circuit` is shared by every batch in one upload, so a switch sticks.
 */
export async function callWithModelFallback(args: {
  prompt: string;
  circuit: ModelCircuit;
  call: (prompt: string, signal: AbortSignal, model: string) => Promise<string>;
  maxAttempts: number;
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  log: (line: string) => void;
  stop?: () => boolean;
}): Promise<{ text: string; model: string }> {
  const maxAttempts = Math.max(1, Math.floor(args.maxAttempts));
  let attemptsOnModel = 0;

  for (;;) {
    if (args.stop?.()) throw new DeadlineExceededError(0, "extracting lease terms");

    const model = currentModel(args.circuit);
    attemptsOnModel += 1;
    try {
      const text = await callGeminiWithRetry(args.prompt, {
        call: (prompt, signal) => args.call(prompt, signal, model),
        maxAttempts: 1,
        timeoutMs: args.timeoutMs,
        sleep: args.sleep,
        random: args.random,
        log: args.log,
        stop: args.stop,
      });
      noteModelSuccess(args.circuit);
      return { text, model };
    } catch (error) {
      if (error instanceof DeadlineExceededError) throw error;
      if (error instanceof Error && error.name === "LeaseExtractError") throw error;

      const failure = describeGeminiFailure(error);
      const before = model;
      const decision = decideAfterFailure(args.circuit, failure);
      const switched = decision === "switch";
      const triesUsedUp = !switched && (decision === "stop" || attemptsOnModel >= maxAttempts);

      if (triesUsedUp) {
        const noun = attemptsOnModel === 1 ? "attempt" : "attempts";
        throw new Error(
          `The model request failed after ${attemptsOnModel} ${noun}. ${detailOf(error)}`,
        );
      }

      if (switched) {
        attemptsOnModel = 0;
        args.log(
          `fallback: ${before} returned ${failure.label}, switching to ${currentModel(args.circuit)} for the rest of this upload`,
        );
        continue;
      }

      const waitMs = retryWaitMs(attemptsOnModel, failure.retryAfterMs, args.random);
      args.log(`retry ${attemptsOnModel} after ${failure.label}, waiting ${formatWait(waitMs)}`);
      await args.sleep(waitMs);
    }
  }
}

function detailOf(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown model error";
  const jsonAt = message.indexOf("{");
  const detail = jsonAt >= 0 ? message.slice(jsonAt) : message;
  const oneLine = detail.replace(/\s+/g, " ").trim();
  return oneLine.length > 400 ? `${oneLine.slice(0, 397)}…` : oneLine;
}

function formatWait(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round((ms / 1000) * 10) / 10;
  return Number.isInteger(seconds) ? `${seconds.toFixed(0)}s` : `${seconds.toFixed(1)}s`;
}
