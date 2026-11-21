import assert from "node:assert/strict";
import test from "node:test";
import { extractLeaseTerms } from "./extractTerms";
import {
  createModelCircuit,
  currentModel,
  decideAfterFailure,
  DEFAULT_GEMINI_FALLBACKS,
  DEFAULT_GEMINI_MODEL,
  loadGeminiModels,
} from "./modelFallback";
import { describeGeminiFailure } from "./geminiRetry";
import { readModelsUsed } from "./leaseTermView";

const RENT_JSON = JSON.stringify({
  lease_terms: [
    {
      category: "rent",
      summary: "Rent is $1,500 per month.",
      details: { amount: 1500 },
      source: { quote: "Tenant shall pay $1,500 per month, due on the 1st." },
    },
  ],
});

function geminiError(status: number, rpc: string, message: string): Error {
  const error = new Error(JSON.stringify({ error: { code: status, message, status: rpc } }));
  error.name = "ApiError";
  (error as Error & { status: number }).status = status;
  return error;
}

test("model list reads env vars and skips a fallback that repeats the primary", () => {
  assert.deepEqual(loadGeminiModels({}), [
    DEFAULT_GEMINI_MODEL,
    ...DEFAULT_GEMINI_FALLBACKS,
  ]);
  assert.deepEqual(
    loadGeminiModels({
      GEMINI_MODEL: "gemini-3.8-flash",
      GEMINI_FALLBACK_MODELS: "gemini-3.8-flash, gemini-3.5-flash-lite",
    }),
    ["gemini-3.8-flash", "gemini-3.5-flash-lite"],
  );
  assert.deepEqual(
    loadGeminiModels({ GEMINI_MODEL: "custom-model", GEMINI_FALLBACK_MODELS: "" }),
    ["custom-model"],
  );
});

test("503 and 504 switch immediately, 500 switches on the second, 429 backs off once", () => {
  const circuit = createModelCircuit(["primary", "fallback"]);

  const first500 = decideAfterFailure(circuit, describeGeminiFailure(geminiError(500, "INTERNAL", "boom")));
  assert.equal(first500, "retry-same");
  assert.equal(currentModel(circuit), "primary");

  const second500 = decideAfterFailure(circuit, describeGeminiFailure(geminiError(500, "INTERNAL", "boom")));
  assert.equal(second500, "switch");
  assert.equal(currentModel(circuit), "fallback");

  const again = createModelCircuit(["primary", "fallback"]);
  assert.equal(
    decideAfterFailure(again, describeGeminiFailure(geminiError(503, "UNAVAILABLE", "busy"))),
    "switch",
  );
  assert.equal(currentModel(again), "fallback");

  const deadline = createModelCircuit(["primary", "fallback"]);
  assert.equal(
    decideAfterFailure(
      deadline,
      describeGeminiFailure(geminiError(504, "DEADLINE_EXCEEDED", "deadline")),
    ),
    "switch",
  );

  const limited = createModelCircuit(["primary", "fallback"]);
  assert.equal(
    decideAfterFailure(limited, describeGeminiFailure(geminiError(429, "RESOURCE_EXHAUSTED", "slow down"))),
    "retry-same",
  );
  assert.equal(
    decideAfterFailure(limited, describeGeminiFailure(geminiError(429, "RESOURCE_EXHAUSTED", "slow down"))),
    "switch",
  );

  const rejected = createModelCircuit(["primary", "fallback"]);
  assert.equal(
    decideAfterFailure(rejected, describeGeminiFailure(geminiError(400, "INVALID_ARGUMENT", "bad"))),
    "stop",
  );
  assert.equal(currentModel(rejected), "primary");
});

test("a 503 switches the rest of the upload onto the fallback model", async () => {
  const previousMock = process.env.GEMINI_MOCK;
  const previousKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MOCK;
  delete process.env.GEMINI_API_KEY;

  const rent = `1. Rent\n\n${"Tenant shall pay $1,800 per month, due on the first day. ".repeat(6)}\n`;
  const deposit = `9. Deposit\n\n${"A security deposit of $900 is due before the tenant receives the keys. ".repeat(6)}\n`;
  const lease = `${rent}\n${deposit}`;
  const maxBatchChars = Math.max(rent.length, deposit.length);

  const seen: string[] = [];
  const logs: string[] = [];
  try {
    const result = await extractLeaseTerms(lease, {
      models: ["gemini-3.8-flash", "gemini-3.5-flash-lite"],
      maxBatchChars,
      concurrency: 1,
      random: () => 0,
      sleep: async () => {
        throw new Error("503 should switch without waiting");
      },
      log: (line) => logs.push(line),
      call: async (_prompt, _signal, model = "") => {
        seen.push(model);
        if (model === "gemini-3.8-flash") {
          throw geminiError(503, "UNAVAILABLE", "Deadline expired before operation could complete.");
        }
        return RENT_JSON;
      },
    });

    assert.deepEqual(seen, ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.5-flash-lite"]);
    assert.ok(
      logs.some((line) =>
        line.includes(
          "fallback: gemini-3.8-flash returned 503, switching to gemini-3.5-flash-lite for the rest of this upload",
        ),
      ),
    );
    assert.equal(
      logs.filter((line) => line.includes("switching to")).length,
      1,
    );
    assert.ok(logs.some((line) => line.includes("model gemini-3.8-flash")));
    assert.ok(logs.some((line) => line.includes("finished model gemini-3.5-flash-lite")));
    assert.deepEqual(readModelsUsed(result), ["gemini-3.5-flash-lite"]);
  } finally {
    if (previousMock === undefined) delete process.env.GEMINI_MOCK;
    else process.env.GEMINI_MOCK = previousMock;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});
