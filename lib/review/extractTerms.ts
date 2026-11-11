import { GoogleGenAI } from "@google/genai";
import { readFile } from "fs/promises";
import path from "path";
import { MAX_LEASE_CHARS } from "./limits";

/**
 * Turns lease text into the JSON object the model returns.
 *
 * The upload route and POST /api/test both call `extractLeaseTerms`.
 * The wording of the prompt matches the original /api/test POST handler.
 * Do not rephrase it here: the model is following those instructions.
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

  // Chunker plug-in: a long lease would be split into sections here, each
  // section sent through the same prompt, and the lease_terms lists merged.
  // Until that exists, refuse oversized text instead of sending it.
  if (leaseText.length > MAX_LEASE_CHARS) {
    throw new LeaseExtractError(
      `This lease is too long to extract in one pass (${leaseText.length.toLocaleString()} characters). The limit is ${MAX_LEASE_CHARS.toLocaleString()} characters. Try a shorter file.`,
      400,
    );
  }
}

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

function briefError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown model error";
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > 280 ? `${oneLine.slice(0, 277)}…` : oneLine;
}

async function runModel(prompt: string): Promise<unknown> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new LeaseExtractError(
      "The extraction service is not configured. Set GEMINI_API_KEY and try again.",
      500,
    );
  }

  // Same call the original route made: one model, JSON mime type, no schema.
  let raw: string;
  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: { responseMimeType: "application/json" },
    });
    raw = response.text ?? "{}";
  } catch (error) {
    if (error instanceof LeaseExtractError) throw error;
    throw new LeaseExtractError(`The model request failed. ${briefError(error)}`, 502);
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new LeaseExtractError(
      "The model returned a response that was not valid JSON.",
      502,
    );
  }
}

/**
 * Run extraction on text that already has a prompt wrapped around it.
 * GET /api/test uses this with the original demo prompt.
 */
export async function extractFromPrompt(leaseText: string, prompt: string): Promise<unknown> {
  assertLeaseText(leaseText);
  if (process.env.GEMINI_MOCK === "1") {
    return mockLeaseTerms(leaseText);
  }
  return runModel(prompt);
}

/**
 * Extract lease terms from plain text.
 * Returns the parsed JSON object (expected shape: { lease_terms: [...] }).
 * There is no schema validation: the page shows whatever came back, and
 * treats null summary/details/source as "Not addressed".
 */
export async function extractLeaseTerms(leaseText: string): Promise<unknown> {
  assertLeaseText(leaseText);
  if (process.env.GEMINI_MOCK === "1") {
    return mockLeaseTerms(leaseText);
  }
  const prompt = await buildLeasePrompt(leaseText);
  return runModel(prompt);
}
