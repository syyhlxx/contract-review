import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runExtract } from "../../app/api/extract/route";
import { extractPdfInWorker } from "./extractPdf";
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
      assert.match(error.message, /logs\/extract\.log/);
      assert.match(
        new DeadlineExceededError(60_000, "reading the file").message,
        /Stopped after 60 seconds while reading the file/,
      );
      return true;
    },
  );
  assert.equal(aborted, true);
});

test("a .txt upload is logged and extracted without the PDF worker", async () => {
  const previousMock = process.env.GEMINI_MOCK;
  process.env.GEMINI_MOCK = "1";
  const dir = await mkdtemp(path.join(tmpdir(), "extract-log-"));
  const logFile = path.join(dir, "extract.log");

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
    const response = await runExtract(
      new Request("http://local/api/extract", { method: "POST", body: form }),
      { logFile },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { leaseTerms?: { lease_terms?: unknown[] } };
    assert.ok(Array.isArray(body.leaseTerms?.lease_terms));
    const text = await readFile(logFile, "utf8");
    assert.match(text, /POST \/api\/extract received/);
    assert.match(text, /reading upload/);
    assert.match(text, /upload read: lease\.txt/);
    assert.match(text, /reading text from lease\.txt/);
    assert.match(text, /text extracted: .+ characters, unknown pages, 1 clause/);
    assert.match(text, /split into 1 chunk and 1 batch/);
    assert.match(text, /batch 1\/1 sent/);
    assert.match(text, /batch 1\/1 finished/);
    assert.match(text, /POST \/api\/extract finished/);
    assert.doesNotMatch(text, /PDF parsing was stopped/);
    assert.doesNotMatch(text, /reading the file/);
  } finally {
    if (previousMock === undefined) delete process.env.GEMINI_MOCK;
    else process.env.GEMINI_MOCK = previousMock;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a hung upload reports the last step instead of waiting forever", async () => {
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
  const dir = await mkdtemp(path.join(tmpdir(), "extract-log-"));
  const logFile = path.join(dir, "extract.log");

  try {
    const response = await runExtract(request, {
      fileReadDeadlineMs: 40,
      deadlineMs: 500,
      logFile,
    });
    assert.equal(response.status, 504);
    const payload = (await response.json()) as { error?: string };
    const error = payload.error ?? "";
    assert.match(error, /reading the upload/);
    assert.match(error, /Last logged step: "reading upload"/);
    assert.match(error, /Step trail:/);
    assert.match(error, /POST \/api\/extract received/);
    assert.match(error, new RegExp(logFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const text = await readFile(logFile, "utf8");
    assert.match(text, /POST \/api\/extract received/);
    assert.match(text, /reading upload/);
    assert.match(text, /POST \/api\/extract failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a PDF worker stuck in synchronous work is killed", async () => {
  const started = Date.now();
  await assert.rejects(
    () => extractPdfInWorker(new Uint8Array([1, 2, 3]), { timeoutMs: 200, mode: "hang-sync" }),
    /PDF parsing was stopped/,
  );
  assert.ok(Date.now() - started < 5_000, "the worker was not killed");
});
