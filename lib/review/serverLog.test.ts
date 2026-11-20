import assert from "node:assert/strict";
import test from "node:test";
import { POST, runExtract } from "../../app/api/extract/route";
import { DeadlineExceededError, withDeadline } from "./serverLog";

test("withDeadline rejects and aborts a call that does not finish", async () => {
  let aborted = false;
  await assert.rejects(
    () =>
      withDeadline(
        (signal) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              resolve(undefined);
            });
          }),
        30,
        "reading the file",
      ),
    (error: unknown) => {
      assert.ok(error instanceof DeadlineExceededError);
      assert.equal(error.status, 504);
      assert.match(error.message, /reading the file/);
      assert.match(error.message, /npm run dev/);
      assert.match(
        new DeadlineExceededError(60_000, "reading the file").message,
        /Stopped after 60 seconds while reading the file/,
      );
      return true;
    },
  );
  assert.equal(aborted, true);
});

test("POST /api/extract logs the file read and the one batch before it returns", async () => {
  const previousMock = process.env.GEMINI_MOCK;
  process.env.GEMINI_MOCK = "1";
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding, callback?: (error?: Error | null) => void) => {
    lines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return original(chunk, encoding, callback);
  }) as typeof process.stdout.write;

  try {
    const form = new FormData();
    form.set(
      "file",
      new File(
        ["Tenant shall pay $1,500 per month, due on the 1st. Security deposit is $1,500.\n"],
        "lease.txt",
        { type: "text/plain" },
      ),
    );
    const response = await POST(
      new Request("http://local/api/extract", { method: "POST", body: form }),
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { leaseTerms?: { lease_terms?: unknown[] } };
    assert.ok(Array.isArray(body.leaseTerms?.lease_terms));
  } finally {
    process.stdout.write = original;
    if (previousMock === undefined) delete process.env.GEMINI_MOCK;
    else process.env.GEMINI_MOCK = previousMock;
  }

  const text = lines.join("");
  assert.match(text, /POST \/api\/extract received/);
  assert.match(text, /reading upload/);
  assert.match(text, /upload read: lease\.txt/);
  assert.match(text, /reading text from lease\.txt/);
  assert.match(text, /text extracted: .+ characters, unknown pages, 1 clause/);
  assert.match(text, /split into 1 chunk and 1 batch/);
  assert.match(text, /batch 1\/1 sent/);
  assert.match(text, /batch 1\/1 finished/);
  assert.match(text, /POST \/api\/extract finished/);
});

test("a hung upload is answered instead of waiting forever", async () => {
  const body = new ReadableStream({
    start() {
      // Never enqueue or close. formData() waits on this body.
    },
  });
  const request = new Request("http://local/api/extract", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit);

  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding, callback?: (error?: Error | null) => void) => {
    lines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return original(chunk, encoding, callback);
  }) as typeof process.stdout.write;

  try {
    const response = await runExtract(request, { fileReadDeadlineMs: 40, deadlineMs: 500 });
    assert.equal(response.status, 504);
    const payload = (await response.json()) as { error?: string };
    assert.match(payload.error ?? "", /reading the upload/);
    assert.match(payload.error ?? "", /npm run dev/);
  } finally {
    process.stdout.write = original;
  }

  const text = lines.join("");
  assert.match(text, /POST \/api\/extract received/);
  assert.match(text, /reading upload/);
  assert.match(text, /POST \/api\/extract failed/);
});
