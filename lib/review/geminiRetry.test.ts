import assert from "node:assert/strict";
import test from "node:test";
import { batchChunks, chunkLease } from "./chunkLease";
import { extractLeaseTerms, lastModelCallCount, LeaseExtractError } from "./extractTerms";
import { DeadlineExceededError } from "./serverLog";
import {
  describeGeminiFailure,
  GEMINI_MAX_ATTEMPTS,
  GEMINI_MAX_HINT_WAIT_MS,
  retryWaitMs,
  type GeminiTextCall,
} from "./geminiRetry";
import { isUnaddressed, readExtractionWarnings, readLeaseTerms, termSource } from "./leaseTermView";
import { MAX_CHUNK_CHARS, MAX_MODEL_BATCH_CHARS, MODEL_BATCH_CONCURRENCY } from "./limits";

const LEASE = "Tenant shall pay $1,500 per month, due on the 1st. Security deposit is $1,500.";

const RENT_SENTENCE = "Tenant shall pay $1,800 per month, due on the first day.";
const DEPOSIT_SENTENCE = "A security deposit of $900 is due before the tenant receives the keys.";

const RENT_JSON = JSON.stringify({
  lease_terms: [
    {
      category: "rent",
      summary: "Rent is $1,800 per month.",
      details: { amount: 1800, currency: "USD", frequency: "monthly" },
      source: { section: null, page: null, quote: RENT_SENTENCE },
    },
  ],
});

/**
 * The shape Gemini's SDK throws. `status` is the HTTP code. `message` is the
 * JSON body, which is what showed up after "The model request failed."
 */
function geminiError(
  status: number,
  rpc: string,
  message: string,
  details?: unknown[],
): Error {
  const body: {
    error: { code: number; message: string; status: string; details?: unknown[] };
  } = { error: { code: status, message, status: rpc } };
  if (details) body.error.details = details;
  const error = new Error(JSON.stringify(body));
  error.name = "ApiError";
  (error as Error & { status: number }).status = status;
  return error;
}

async function withModelEnv(run: () => Promise<void>): Promise<void> {
  const previousMock = process.env.GEMINI_MOCK;
  const previousKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MOCK;
  delete process.env.GEMINI_API_KEY;
  try {
    await run();
  } finally {
    if (previousMock === undefined) delete process.env.GEMINI_MOCK;
    else process.env.GEMINI_MOCK = previousMock;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
}

test("backoff doubles, and a retry hint is a minimum wait", () => {
  assert.equal(retryWaitMs(1, null, () => 0), 500);
  assert.equal(retryWaitMs(1, null, () => 1), 1_000);
  assert.equal(retryWaitMs(2, null, () => 1), 2_000);
  assert.equal(retryWaitMs(3, null, () => 1), 4_000);
  // 32s is the kind of Retry-After Gemini sends with a 429. It is kept.
  assert.equal(retryWaitMs(1, 32_000, () => 0), 32_000);
  // A hint of many minutes is cut so one lease cannot stall the page.
  assert.equal(retryWaitMs(1, 10 * 60_000, () => 0), GEMINI_MAX_HINT_WAIT_MS);
  // A hint shorter than the backoff does not make us retry sooner than the backoff.
  assert.equal(retryWaitMs(3, 100, () => 1), 4_000);
});

test("the deadline error from Gemini is a retryable 503, and a 400 is not", () => {
  const deadline = geminiError(503, "UNAVAILABLE", "Deadline expired before operation could complete.");
  const described = describeGeminiFailure(deadline);
  assert.equal(described.retryable, true);
  assert.equal(described.label, "503");
  assert.equal(described.reason, "503 UNAVAILABLE");

  // The same JSON, with no status field, which is how it looked inside the
  // old error string. The code is still read out of the message.
  const asText = new Error(
    'The model request failed. {"error":{"code":503,"message":"Deadline expired before operation could complete.","status":"UNAVAILABLE"}}',
  );
  assert.equal(describeGeminiFailure(asText).retryable, true);
  assert.equal(describeGeminiFailure(asText).label, "503");

  const rejected = geminiError(400, "INVALID_ARGUMENT", "Request contains an invalid argument.");
  assert.equal(describeGeminiFailure(rejected).retryable, false);
  assert.equal(describeGeminiFailure(rejected).label, "400");

  const hinted = geminiError(429, "RESOURCE_EXHAUSTED", "Resource exhausted", [
    { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "32s" },
  ]);
  assert.equal(describeGeminiFailure(hinted).retryAfterMs, 32_000);

  const header = geminiError(429, "RESOURCE_EXHAUSTED", "Resource exhausted");
  (header as Error & { headers: Record<string, string> }).headers = { "Retry-After": "20" };
  assert.equal(describeGeminiFailure(header).retryAfterMs, 20_000);

  const prose = geminiError(429, "RESOURCE_EXHAUSTED", "Resource exhausted. Please retry in 15s.");
  assert.equal(describeGeminiFailure(prose).retryAfterMs, 15_000);

  const objectDelay = geminiError(429, "RESOURCE_EXHAUSTED", "Resource exhausted", [
    { retryDelay: { seconds: 1, nanos: 500_000_000 } },
  ]);
  assert.equal(describeGeminiFailure(objectDelay).retryAfterMs, 1_500);

  const dropped = new TypeError("fetch failed");
  assert.equal(describeGeminiFailure(dropped).retryable, true);
  assert.equal(describeGeminiFailure(dropped).label, "network");

  const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  assert.equal(describeGeminiFailure(reset).retryable, true);

  // After the retries are used up, the failure is wrapped in our own error
  // with status 502. The page should still say what Gemini actually did.
  const wrappedTimeout = new LeaseExtractError(
    "The model request failed after 4 attempts. The model did not answer within 45 seconds.",
    502,
  );
  assert.equal(describeGeminiFailure(wrappedTimeout).label, "timeout");
  assert.equal(describeGeminiFailure(wrappedTimeout).reason, "timed out");

  const wrapped503 = new LeaseExtractError(
    `The model request failed after 4 attempts. ${JSON.stringify({
      error: { code: 503, message: "Deadline expired before operation could complete.", status: "UNAVAILABLE" },
    })}`,
    502,
  );
  assert.equal(describeGeminiFailure(wrapped503).reason, "503 UNAVAILABLE");
  assert.equal(describeGeminiFailure(wrapped503).label, "503");
});

test("a 503 is retried and the next response is used", async () => {
  await withModelEnv(async () => {
    let attempts = 0;
    const waits: number[] = [];
    const logs: string[] = [];
    const result = await extractLeaseTerms(LEASE, {
      random: () => 0,
      sleep: async (ms) => {
        waits.push(ms);
      },
      log: (line) => logs.push(line),
      call: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw geminiError(503, "UNAVAILABLE", "Deadline expired before operation could complete.");
        }
        return RENT_JSON;
      },
    });

    assert.equal(attempts, 2);
    assert.deepEqual(waits, [500]);
    assert.ok(logs.some((line) => line.startsWith("retry 1 after 503")));
    assert.ok(logs.some((line) => line.startsWith("batch 1/1 sent")));
    assert.ok(logs.some((line) => line === "batch 1/1 finished"));
    const terms = readLeaseTerms(result);
    assert.ok(terms);
    const rent = terms.find((term) => term.category === "rent");
    assert.ok(rent);
    assert.equal(isUnaddressed(rent), false);
    assert.deepEqual(readExtractionWarnings(result), []);
  });
});

test("retries stop after the maximum number of attempts", async () => {
  await withModelEnv(async () => {
    let attempts = 0;
    const waits: number[] = [];
    const logs: string[] = [];
    await assert.rejects(
      () =>
        extractLeaseTerms(LEASE, {
          random: () => 1,
          sleep: async (ms) => {
            waits.push(ms);
          },
          log: (line) => logs.push(line),
          call: async () => {
            attempts += 1;
            throw geminiError(503, "UNAVAILABLE", "Deadline expired before operation could complete.");
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof LeaseExtractError);
        assert.equal(error.status, 502);
        assert.match(error.message, new RegExp(`after ${GEMINI_MAX_ATTEMPTS} attempts`));
        assert.match(error.message, /503/);
        assert.match(error.message, /Deadline expired/);
        return true;
      },
    );

    assert.equal(attempts, GEMINI_MAX_ATTEMPTS);
    assert.equal(waits.length, GEMINI_MAX_ATTEMPTS - 1);
    assert.deepEqual(waits, [1_000, 2_000, 4_000]);
    assert.equal(
      logs.filter((line) => line.startsWith("retry")).length,
      GEMINI_MAX_ATTEMPTS - 1,
    );
    assert.ok(logs.some((line) => line.startsWith("retry 1 after 503")));
    assert.ok(logs.some((line) => line.startsWith(`retry ${GEMINI_MAX_ATTEMPTS - 1} after 503`)));
  });
});

test("a 400 is not retried, and neither are other 4xx errors except 429", async () => {
  await withModelEnv(async () => {
    for (const status of [400, 401, 403, 404]) {
      let attempts = 0;
      const waits: number[] = [];
      const logs: string[] = [];
      await assert.rejects(
        () =>
          extractLeaseTerms(LEASE, {
            sleep: async (ms) => {
              waits.push(ms);
            },
            log: (line) => logs.push(line),
            call: async () => {
              attempts += 1;
              throw geminiError(status, "INVALID_ARGUMENT", "Request contains an invalid argument.", [
                { retryDelay: "32s" },
              ]);
            },
          }),
        (error: unknown) => {
          assert.ok(error instanceof LeaseExtractError);
          assert.match(error.message, /after 1 attempt/);
          assert.match(error.message, new RegExp(String(status)));
          return true;
        },
      );
      assert.equal(attempts, 1, `status ${status} was sent more than once`);
      assert.deepEqual(waits, []);
      assert.equal(
        logs.some((line) => line.startsWith("retry")),
        false,
        `status ${status} was retried`,
      );
    }
  });
});

test("a 500 and a dropped connection are retried", async () => {
  await withModelEnv(async () => {
    const cases: Array<{ label: string; error: Error }> = [
      { label: "500", error: geminiError(500, "INTERNAL", "Internal error") },
      { label: "network", error: new TypeError("fetch failed") },
    ];

    for (const item of cases) {
      let attempts = 0;
      const logs: string[] = [];
      const result = await extractLeaseTerms(LEASE, {
        random: () => 0,
        sleep: async () => {},
        log: (line) => logs.push(line),
        call: async () => {
          attempts += 1;
          if (attempts === 1) throw item.error;
          return RENT_JSON;
        },
      });
      assert.equal(attempts, 2, item.label);
      assert.ok(
        logs.some((line) => line.startsWith(`retry 1 after ${item.label}`)),
        logs.join("\n"),
      );
      assert.equal(readExtractionWarnings(result).length, 0);
    }
  });
});

test("a 429 waits for the server's retry hint", async () => {
  await withModelEnv(async () => {
    const waits: number[] = [];
    const logs: string[] = [];
    let attempts = 0;
    await extractLeaseTerms(LEASE, {
      random: () => 0,
      sleep: async (ms) => {
        waits.push(ms);
      },
      log: (line) => logs.push(line),
      call: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw geminiError(429, "RESOURCE_EXHAUSTED", "Resource exhausted", [
            { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "32s" },
          ]);
        }
        return RENT_JSON;
      },
    });
    assert.equal(attempts, 2);
    assert.deepEqual(waits, [32_000]);
    assert.ok(logs.some((line) => line.startsWith("retry 1 after 429")));
  });
});

test("a hung call hits the time limit and is retried", async () => {
  await withModelEnv(async () => {
    let attempts = 0;
    const logs: string[] = [];
    const call: GeminiTextCall = (_prompt, signal) => {
      attempts += 1;
      if (attempts === 1) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
          });
        });
      }
      return Promise.resolve(RENT_JSON);
    };

    const result = await extractLeaseTerms(LEASE, {
      call,
      timeoutMs: 30,
      random: () => 0,
      sleep: async () => {},
      log: (line) => logs.push(line),
    });

    assert.equal(attempts, 2);
    assert.ok(logs.some((line) => line.startsWith("retry 1 after timeout")), logs.join("\n"));
    assert.equal(readExtractionWarnings(result).length, 0);
  });
});

test("a response that is not JSON is not retried", async () => {
  await withModelEnv(async () => {
    let attempts = 0;
    await assert.rejects(
      () =>
        extractLeaseTerms(LEASE, {
          sleep: async () => {
            throw new Error("should not wait");
          },
          log: () => {},
          call: async () => {
            attempts += 1;
            return "this is not json";
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof LeaseExtractError);
        assert.equal(error.status, 502);
        assert.match(error.message, /not valid JSON/);
        return true;
      },
    );
    assert.equal(attempts, 1);
  });
});

test("a failed section is listed and the sections that succeeded are kept", async () => {
  await withModelEnv(async () => {
    const rent = `1. Rent\n\n${Array.from({ length: 6 }, () => RENT_SENTENCE).join(" ")}\n`;
    const deposit = `9. Deposit\n\n${Array.from({ length: 6 }, () => DEPOSIT_SENTENCE).join(" ")}\n`;
    const lease = `${rent}\n${deposit}`;
    const maxBatchChars = Math.max(rent.length, deposit.length);
    assert.ok(lease.length > maxBatchChars);
    assert.ok(rent.length <= maxBatchChars);
    assert.ok(deposit.length <= maxBatchChars);

    let attempts = 0;
    const logs: string[] = [];
    const result = await extractLeaseTerms(lease, {
      maxBatchChars,
      concurrency: 1,
      random: () => 0,
      sleep: async () => {},
      log: (line) => logs.push(line),
      call: async (prompt) => {
        attempts += 1;
        if (prompt.includes("9. Deposit")) {
          throw geminiError(503, "UNAVAILABLE", "Deadline expired before operation could complete.");
        }
        return RENT_JSON;
      },
    });

    assert.equal(lastModelCallCount(), 2);
    assert.equal(attempts, 1 + GEMINI_MAX_ATTEMPTS);
    assert.ok(logs.some((line) => line.startsWith("batch 1/2 sent")));
    assert.ok(logs.some((line) => line.startsWith("batch 2/2 sent")));
    assert.ok(logs.some((line) => line.startsWith("retry 1 after 503")));

    const terms = readLeaseTerms(result);
    assert.ok(terms);
    const rentTerm = terms.find((term) => term.category === "rent" && !isUnaddressed(term));
    assert.ok(rentTerm);
    assert.match(String(termSource(rentTerm)?.quote ?? ""), /1,800/);
    assert.equal(termSource(rentTerm)?.section, "1. Rent");
    const depositTerm = terms.find((term) => term.category === "deposit");
    assert.ok(depositTerm);
    assert.equal(isUnaddressed(depositTerm), true);

    const warnings = readExtractionWarnings(result);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /9\. Deposit/);
    assert.match(warnings[0] ?? "", /part 2 of 2/);
    assert.match(warnings[0] ?? "", /503 UNAVAILABLE/);
    assert.match(warnings[0] ?? "", /terms below are from the sections that succeeded/);
  });
});

test("a 10-page lease is sent in small batches, one at a time", async () => {
  await withModelEnv(async () => {
    const parts: string[] = [];
    for (let n = 1; n <= 10; n++) {
      const sentence = `The parties confirm clause ${n} and will follow the house rules. `;
      parts.push(`${n}. Clause ${n}\n\n${sentence.repeat(50)}\n`);
    }
    const lease = parts.join("\n");
    assert.ok(lease.length >= 25_000, `lease is ${lease.length} characters`);
    assert.ok(lease.length <= 40_000, `lease is ${lease.length} characters`);

    const chunks = chunkLease(lease, { maxChars: MAX_MODEL_BATCH_CHARS });
    const batches = batchChunks(lease, chunks, MAX_MODEL_BATCH_CHARS);
    assert.ok(batches.length >= 6, `expected several batches, got ${batches.length}`);
    for (const batch of batches) {
      assert.ok(
        batch.text.length <= MAX_MODEL_BATCH_CHARS,
        `batch ${batch.index} is ${batch.text.length} characters`,
      );
    }
    assert.ok(MAX_MODEL_BATCH_CHARS < MAX_CHUNK_CHARS);
    assert.ok(MODEL_BATCH_CONCURRENCY <= 2);

    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const result = await extractLeaseTerms(lease, {
      log: () => {},
      sleep: async () => {},
      call: async (prompt) => {
        calls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const leaseText = prompt.slice(prompt.lastIndexOf("Lease:\n") + "Lease:\n".length);
        assert.ok(
          leaseText.length <= MAX_MODEL_BATCH_CHARS,
          `model call saw ${leaseText.length} characters of lease text`,
        );
        await Promise.resolve();
        inFlight -= 1;
        return JSON.stringify({ lease_terms: [] });
      },
    });

    assert.equal(calls, batches.length);
    assert.equal(maxInFlight, MODEL_BATCH_CONCURRENCY);
    assert.deepEqual(readExtractionWarnings(result), []);
  });
});

test("no batch is sent after the upload time limit", async () => {
  await withModelEnv(async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        extractLeaseTerms(LEASE, {
          deadlineAt: 0,
          now: () => 1,
          log: () => {},
          sleep: async () => {
            throw new Error("should not wait");
          },
          call: async () => {
            calls += 1;
            return RENT_JSON;
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof DeadlineExceededError);
        assert.match(error.message, /npm run dev/);
        return true;
      },
    );
    assert.equal(calls, 0);
  });
});

test("terms already read are kept when the upload time limit runs out", async () => {
  await withModelEnv(async () => {
    const rent = `1. Rent\n\n${Array.from({ length: 6 }, () => RENT_SENTENCE).join(" ")}\n`;
    const deposit = `9. Deposit\n\n${Array.from({ length: 6 }, () => DEPOSIT_SENTENCE).join(" ")}\n`;
    const lease = `${rent}\n${deposit}`;
    const maxBatchChars = Math.max(rent.length, deposit.length);
    let now = 1_000;
    let calls = 0;
    const result = await extractLeaseTerms(lease, {
      maxBatchChars,
      concurrency: 1,
      deadlineAt: 5_000,
      now: () => now,
      random: () => 0,
      sleep: async () => {},
      log: () => {},
      call: async () => {
        calls += 1;
        now = 9_000;
        return RENT_JSON;
      },
    });

    assert.equal(calls, 1);
    const terms = readLeaseTerms(result);
    assert.ok(terms?.some((term) => term.category === "rent" && !isUnaddressed(term)));
    const warnings = readExtractionWarnings(result);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /9\. Deposit/);
    assert.match(warnings[0] ?? "", /time limit/);
  });
});

test("GEMINI_MOCK=1 does not call the model client", async () => {
  await withModelEnv(async () => {
    process.env.GEMINI_MOCK = "1";
    let called = false;
    const result = await extractLeaseTerms(LEASE, {
      call: async () => {
        called = true;
        return RENT_JSON;
      },
    });
    assert.equal(called, false);
    const terms = readLeaseTerms(result);
    assert.ok(terms);
    const rent = terms.find((term) => term.category === "rent");
    assert.ok(rent);
    assert.equal(isUnaddressed(rent), false);
    assert.deepEqual(readExtractionWarnings(result), []);
  });
});
