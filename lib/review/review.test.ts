import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { POST as extractPost } from "../../app/api/extract/route";
import { POST as parsePost } from "../../app/api/parse/route";
import { GET as testGet, POST as testPost } from "../../app/api/test/route";
import { buildDemoPrompt, buildLeasePrompt, extractLeaseTerms, LeaseExtractError } from "./extractTerms";
import { MAX_LEASE_CHARS, MAX_UPLOAD_BYTES } from "./limits";
import {
  groupLeaseTerms,
  isUnaddressed,
  readLeaseTerms,
  termSource,
  type LeaseTerm,
} from "./leaseTermView";
import { parseDocument } from "./parseDocument";
import { readUploadedFile } from "./readUpload";
import { SAMPLE_LEASE } from "./sampleLease";

const LEASE = "Tenant shall pay $1,500 per month, due on the 1st. Security deposit is $1,500.";

test("prompt wrapper matches the original POST /api/test wording", async () => {
  const instructions = await readFile("prompts/extract-terms.md", "utf-8");
  const example = await readFile("prompts/example_output.json", "utf-8");
  const prompt = await buildLeasePrompt(LEASE);
  assert.equal(
    prompt,
    `${instructions}\n\nExample output:\n${example}\n\nLease:\n${LEASE}`,
  );

  const demo = await buildDemoPrompt(LEASE);
  assert.equal(demo, `${instructions}\n\n${example}\n\nLease text: ${LEASE}\n`);
});

test("extraction errors and the mock stay off the network", async () => {
  const previousMock = process.env.GEMINI_MOCK;
  const previousKey = process.env.GEMINI_API_KEY;
  try {
    delete process.env.GEMINI_MOCK;
    delete process.env.GEMINI_API_KEY;

    await assert.rejects(
      () => extractLeaseTerms("   "),
      (error: unknown) => {
        assert.ok(error instanceof LeaseExtractError);
        assert.equal(error.status, 400);
        assert.equal(error.message, "leaseText is required");
        return true;
      },
    );

    await assert.rejects(
      () => extractLeaseTerms("a".repeat(MAX_LEASE_CHARS + 1)),
      (error: unknown) => {
        assert.ok(error instanceof LeaseExtractError);
        assert.equal(error.status, 400);
        assert.match(error.message, /too long to extract in one pass/);
        return true;
      },
    );

    await assert.rejects(
      () => extractLeaseTerms(LEASE),
      (error: unknown) => {
        assert.ok(error instanceof LeaseExtractError);
        assert.equal(error.status, 500);
        assert.match(error.message, /GEMINI_API_KEY/);
        return true;
      },
    );

    process.env.GEMINI_MOCK = "1";
    const result = (await extractLeaseTerms(SAMPLE_LEASE)) as { lease_terms: LeaseTerm[] };
    const terms = readLeaseTerms(result);
    assert.ok(terms);
    const pets = terms.find((term) => term.category === "pets");
    const rent = terms.find((term) => term.category === "rent");
    assert.ok(pets);
    assert.ok(rent);
    assert.equal(isUnaddressed(pets), true);
    assert.equal(isUnaddressed(rent), false);
    assert.match(termSource(rent)?.quote ?? "", /2,150/);

    await assert.rejects(
      () => extractLeaseTerms("[[mock-model-failure]]"),
      (error: unknown) => {
        assert.ok(error instanceof LeaseExtractError);
        assert.equal(error.status, 502);
        assert.match(error.message, /model request failed/i);
        return true;
      },
    );

    const missing = await testPost(new Request("http://local/api/test", { method: "POST", body: "{}" }));
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error, "leaseText is required");

    const extracted = await testPost(
      new Request("http://local/api/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leaseText: SAMPLE_LEASE }),
      }),
    );
    assert.equal(extracted.status, 200);
    const extractedBody = (await extracted.json()) as { lease_terms?: LeaseTerm[] };
    assert.equal(Array.isArray(extractedBody.lease_terms), true);

    const demo = await testGet();
    assert.equal(demo.status, 200);
    assert.equal(Array.isArray((await demo.json()).lease_terms), true);

    const fileForm = new FormData();
    fileForm.set(
      "file",
      new File([SAMPLE_LEASE], "lease.txt", { type: "text/plain" }),
    );
    const uploaded = await extractPost(
      new Request("http://local/api/extract", { method: "POST", body: fileForm }),
    );
    assert.equal(uploaded.status, 200);
    const uploadedBody = (await uploaded.json()) as {
      fileName?: string;
      clauses?: unknown[];
      leaseTerms?: { lease_terms?: LeaseTerm[] };
    };
    assert.equal(uploadedBody.fileName, "lease.txt");
    assert.ok((uploadedBody.clauses?.length ?? 0) > 0);
    const uploadedPets = uploadedBody.leaseTerms?.lease_terms?.find((term) => term.category === "pets");
    assert.ok(uploadedPets);
    assert.equal(isUnaddressed(uploadedPets), true);

    const badForm = new FormData();
    badForm.set("file", new File(["hello"], "photo.png", { type: "image/png" }));
    const bad = await extractPost(new Request("http://local/api/extract", { method: "POST", body: badForm }));
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /PDF, Word/);

    const emptyForm = new FormData();
    emptyForm.set("file", new File([], "empty.txt", { type: "text/plain" }));
    const empty = await extractPost(
      new Request("http://local/api/extract", { method: "POST", body: emptyForm }),
    );
    assert.equal(empty.status, 400);
    assert.match((await empty.json()).error, /empty/);

    const failForm = new FormData();
    failForm.set(
      "file",
      new File(["[[mock-model-failure]]\n\nTenant shall pay $100 rent each month."], "fail.txt", {
        type: "text/plain",
      }),
    );
    const failed = await extractPost(
      new Request("http://local/api/extract", { method: "POST", body: failForm }),
    );
    assert.equal(failed.status, 502);
    const failedBody = (await failed.json()) as { error?: string; clauses?: unknown[] };
    assert.match(failedBody.error ?? "", /model request failed/i);
    assert.ok((failedBody.clauses?.length ?? 0) > 0);

    const parseForm = new FormData();
    parseForm.set("file", new File([SAMPLE_LEASE], "lease.txt", { type: "text/plain" }));
    const parsed = await parsePost(
      new Request("http://local/api/parse", { method: "POST", body: parseForm }),
    );
    assert.equal(parsed.status, 200);
    const parsedBody = (await parsed.json()) as { text?: string; clauses?: unknown[] };
    assert.match(parsedBody.text ?? "", /Maple Street/);
    assert.ok((parsedBody.clauses?.length ?? 0) > 0);
  } finally {
    if (previousMock === undefined) delete process.env.GEMINI_MOCK;
    else process.env.GEMINI_MOCK = previousMock;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test("groups categories and marks missing ones for the page", () => {
  const terms = readLeaseTerms({
    lease_terms: [
      {
        category: "rent",
        summary: "Rent is $1,250 per month.",
        details: { amount: 1250, currency: "USD", frequency: null },
        source: { section: "2.1", page: 2, quote: "Tenant shall pay..." },
      },
      { category: "pets", summary: null, details: null, source: null },
      { category: "parking", summary: "One space included.", details: null, source: { quote: "One space." } },
    ],
  });
  assert.ok(terms);
  const groups = groupLeaseTerms(terms);
  assert.deepEqual(
    groups.map((group) => group.category),
    ["rent", "term", "renewal", "termination", "deposit", "pets", "parking"],
  );
  const rent = groups[0];
  assert.equal(rent?.label, "Rent");
  assert.equal(isUnaddressed(rent?.terms[0] as LeaseTerm), false);
  const term = groups.find((group) => group.category === "term");
  assert.deepEqual(term?.terms, []);
  const pets = groups.find((group) => group.category === "pets");
  assert.equal(isUnaddressed(pets?.terms[0] as LeaseTerm), true);
  assert.equal(readLeaseTerms({ nope: true }), null);
});

test("parseDocument reads text and rejects bad files", async () => {
  const parsed = await parseDocument(
    "lease.txt",
    new TextEncoder().encode("Tenant shall pay $1500 per month.\n\nThe term starts January 1 and ends December 31."),
  );
  assert.match(parsed.text ?? "", /\$1500/);
  assert.ok(parsed.clauses.length > 0);

  await assert.rejects(
    () => parseDocument("notes.png", new TextEncoder().encode("hello")),
    /PDF, Word/,
  );
  await assert.rejects(
    () => parseDocument("blank.txt", new TextEncoder().encode("  \n")),
    /No readable text/,
  );
  await assert.rejects(
    () => parseDocument("bad.pdf", new TextEncoder().encode("not a pdf")),
    /Could not read that file/,
  );
  await assert.rejects(
    () => parseDocument("big.txt", new Uint8Array(MAX_UPLOAD_BYTES + 1)),
    /10 MB/,
  );
});

test("readUploadedFile checks the form field", async () => {
  const missing = new Request("http://local/api/extract", {
    method: "POST",
    body: new FormData(),
  });
  await assert.rejects(() => readUploadedFile(missing), /Choose a contract file/);

  const emptyForm = new FormData();
  emptyForm.set("file", new File([], "empty.txt", { type: "text/plain" }));
  const empty = new Request("http://local/api/extract", { method: "POST", body: emptyForm });
  await assert.rejects(() => readUploadedFile(empty), /empty/);

  const okForm = new FormData();
  okForm.set("file", new File(["Tenant shall pay rent."], "lease.txt", { type: "text/plain" }));
  const ok = new Request("http://local/api/extract", { method: "POST", body: okForm });
  const upload = await readUploadedFile(ok);
  assert.equal(upload.fileName, "lease.txt");
  assert.match(new TextDecoder().decode(upload.bytes), /rent/);
});
