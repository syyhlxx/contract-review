import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { batchChunks, chunkLease, sectionCitation, type LeaseChunk } from "./chunkLease";
import { mergeLeaseTerms } from "./mergeLeaseTerms";
import { isUnaddressed, readLeaseTerms, termSource } from "./leaseTermView";

const FIXTURE = "lib/review/fixtures/sample-lease.txt";

function assertSlices(text: string, chunks: LeaseChunk[]): void {
  chunks.forEach((chunk, index) => {
    assert.equal(chunk.index, index);
    assert.equal(chunk.id, `chunk-${index}`);
    assert.equal(text.slice(chunk.startOffset, chunk.endOffset), chunk.text);
    assert.ok(chunk.startOffset < chunk.endOffset);
    if (index > 0) assert.ok(chunk.startOffset >= chunks[index - 1].startOffset);
  });
}

/** Every non-whitespace character of `text` appears in at least one chunk. */
function assertCovered(text: string, chunks: LeaseChunk[]): void {
  const covered = new Array<boolean>(text.length).fill(false);
  for (const chunk of chunks) {
    for (let i = chunk.startOffset; i < chunk.endOffset; i++) covered[i] = true;
  }
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue;
    assert.equal(covered[i], true, `character ${i} (${JSON.stringify(text[i])}) is not in any chunk`);
  }
}

test("numbered sections and article headings in the sample lease", async () => {
  const text = await readFile(FIXTURE, "utf-8");
  const chunks = chunkLease(text);

  assertSlices(text, chunks);
  assertCovered(text, chunks);

  const preamble = chunks[0];
  assert.equal(preamble.section, null);
  assert.equal(preamble.title, null);
  assert.match(preamble.text, /Maple Street/);

  const article1 = chunks.find((chunk) => chunk.section === "ARTICLE 1");
  const article4 = chunks.find((chunk) => chunk.section === "ARTICLE IV");
  const article5 = chunks.find((chunk) => chunk.section === "ARTICLE 5");
  const deposit = chunks.find((chunk) => chunk.section === "Section 8");
  const assignment = chunks.find((chunk) => chunk.section === "12");
  const early = chunks.find((chunk) => chunk.section === "Section 14");

  assert.ok(article1);
  assert.equal(article1.title, "Parties");
  assert.match(article1.text, /only parties/);

  assert.ok(article4);
  assert.equal(article4.title, "QUIET ENJOYMENT");
  assert.match(article4.text, /quietly enjoy/);

  assert.ok(article5);
  assert.equal(article5.title, "RENT");
  assert.match(article5.text, /\$2,150\.00/);
  assert.equal(sectionCitation(article5), "ARTICLE 5. RENT");

  assert.ok(deposit);
  assert.equal(deposit.title, "Security Deposit");
  assert.match(deposit.text, /\$3,225\.00/);

  assert.ok(assignment);
  assert.equal(assignment.title, "Assignment");
  assert.match(assignment.text, /shall not assign/);
  assert.equal(sectionCitation(assignment), "12. Assignment");

  assert.ok(early);
  assert.equal(early.title, "Early Termination");
  assert.match(early.text, /remaining rent/);

  // The fixture is short, so each heading is one chunk and one model batch.
  assert.equal(chunks.length, 7);
  const batches = batchChunks(text, chunks);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.text, text);
});

test("article headings keep roman numerals and same-line titles", () => {
  const text = [
    "ARTICLE I. Parties",
    "Landlord leases the unit to Tenant.",
    "",
    "ARTICLE V - Rent",
    "Tenant pays rent on the first day.",
  ].join("\n");

  const chunks = chunkLease(text);
  assertSlices(text, chunks);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.section, "ARTICLE I");
  assert.equal(chunks[0]?.title, "Parties");
  assert.equal(chunks[1]?.section, "ARTICLE V");
  assert.equal(chunks[1]?.title, "Rent");
  assert.ok((chunks[0]?.endOffset ?? 0) <= (chunks[1]?.startOffset ?? 0));
});

test("a document with no headings falls back to paragraphs", () => {
  const paragraphs = [
    "The tenant pays the sum due on the first day of each month without any deduction at all.",
    "The landlord provides quiet enjoyment of the unit for the full length of the agreement.",
    "The parties may sign an amendment only in a writing signed by both of them.",
    "Notices under this agreement must be sent by certified mail to the addresses above.",
  ];
  const text = paragraphs.join("\n\n");
  const maxChars = 160;
  const chunks = chunkLease(text, { maxChars, overlapChars: 40 });

  assert.ok(chunks.length >= 2, `expected several chunks, got ${chunks.length}`);
  assertSlices(text, chunks);
  assertCovered(text, chunks);
  for (const chunk of chunks) {
    assert.equal(chunk.section, null);
    assert.equal(chunk.title, null);
    assert.ok(chunk.text.length <= maxChars, `chunk ${chunk.index} is ${chunk.text.length} characters`);
  }

  let overlapped = 0;
  for (let i = 1; i < chunks.length; i++) {
    const previous = chunks[i - 1];
    const current = chunks[i];
    if (current.startOffset < previous.endOffset) overlapped += 1;
  }
  assert.ok(overlapped > 0, "paragraph splits should overlap a little");
});

test("an oversized section is split and keeps its label", () => {
  const paragraph = "Tenant shall keep the premises clean and shall not create a nuisance. "
    .repeat(4)
    .trim();
  const body = Array.from({ length: 12 }, () => paragraph).join("\n\n");
  const text = `ARTICLE 9. Repairs\n\n${body}`;
  const maxChars = 500;
  const chunks = chunkLease(text, { maxChars, overlapChars: 80 });

  assert.ok(chunks.length > 2, `expected the section to split, got ${chunks.length}`);
  assertSlices(text, chunks);
  assertCovered(text, chunks);
  assert.match(chunks[0]?.text ?? "", /^ARTICLE 9\. Repairs/);

  for (const chunk of chunks) {
    assert.equal(chunk.section, "ARTICLE 9");
    assert.equal(chunk.title, "Repairs");
    assert.ok(chunk.text.length <= maxChars, `chunk ${chunk.index} is ${chunk.text.length} characters`);
  }

  for (let i = 1; i < chunks.length; i++) {
    assert.ok(
      chunks[i].startOffset < chunks[i - 1].endOffset,
      `chunk ${i} does not overlap the previous piece`,
    );
    assert.ok(chunks[i].startOffset > chunks[i - 1].startOffset);
  }

  const batches = batchChunks(text, chunks, maxChars);
  assert.equal(batches.length, chunks.length);
  for (const batch of batches) {
    assert.ok(batch.text.length <= maxChars);
    assert.equal(text.slice(batch.startOffset, batch.endOffset), batch.text);
  }
});

test("short numbered clauses pack into fewer model batches", () => {
  const parts: string[] = [];
  for (let n = 1; n <= 10; n++) {
    parts.push(
      `${n}. Clause ${n}\n\nThis clause number ${n} says the parties will follow the house rules honestly.\n`,
    );
  }
  const text = parts.join("\n");
  const maxChars = 400;
  const chunks = chunkLease(text, { maxChars, overlapChars: 40 });
  const batches = batchChunks(text, chunks, maxChars);

  assert.ok(chunks.length >= 8);
  assert.ok(batches.length >= 2);
  assert.ok(batches.length < chunks.length);
  for (const batch of batches) {
    assert.ok(batch.text.length <= maxChars);
    assert.equal(text.slice(batch.startOffset, batch.endOffset), batch.text);
  }
});

test("a word made of roman letters is not a section number", () => {
  const text = [
    "ARTICLE CIVIL",
    "The civil article is a sentence, not a numbered heading.",
    "",
    "ARTICLE IV. Rent",
    "Tenant pays rent on the first day.",
  ].join("\n");
  const chunks = chunkLease(text);
  const labeled = chunks.filter((chunk) => chunk.section);
  assert.equal(labeled.length, 1);
  assert.equal(labeled[0]?.section, "ARTICLE IV");
  assert.equal(labeled[0]?.title, "Rent");
});

test("windows newlines keep offsets inside the original string", () => {
  const text = "ARTICLE 1. Parties\r\n\r\nLandlord is Oakridge.\r\n\r\nARTICLE 2. Rent\r\n\r\nTenant pays monthly.\r\n";
  const chunks = chunkLease(text);
  assertSlices(text, chunks);
  assert.equal(chunks[0]?.section, "ARTICLE 1");
  assert.equal(chunks[0]?.title, "Parties");
  assert.equal(chunks[1]?.section, "ARTICLE 2");
  assert.equal(chunks[1]?.title, "Rent");
  assert.match(chunks[0]?.text ?? "", /Oakridge/);
});

test("merge cites the section a quote came from and keeps a section the model set", () => {
  const text = [
    "2. Rent. Tenant shall pay $1,800 per month.",
    "",
    "9. Deposit. A security deposit is due before move-in.",
  ].join("\n");
  const chunks = chunkLease(text);
  const batches = batchChunks(text, chunks);

  const merged = mergeLeaseTerms(
    [
      [
        {
          category: "rent",
          summary: "Rent is $1,800 per month.",
          details: { amount: 1800 },
          source: { section: null, page: null, quote: "Tenant shall pay $1,800 per month." },
        },
        {
          category: "deposit",
          summary: "A deposit is due.",
          details: null,
          source: { section: "9.1", page: 4, quote: "A security deposit is due before move-in." },
        },
        { category: "pets", summary: null, details: null, source: null },
      ],
    ],
    batches,
    chunks,
  );

  const terms = readLeaseTerms(merged);
  assert.ok(terms);
  const rent = terms.find((term) => term.category === "rent");
  const deposit = terms.find((term) => term.category === "deposit");
  const pets = terms.find((term) => term.category === "pets");
  assert.ok(rent);
  assert.ok(deposit);
  assert.ok(pets);
  assert.equal(termSource(rent)?.section, "2. Rent");
  assert.equal(termSource(rent)?.quote, "Tenant shall pay $1,800 per month.");
  // The model named 9.1, which is more specific than the heading "9".
  assert.equal(termSource(deposit)?.section, "9.1");
  assert.equal(termSource(deposit)?.page, 4);
  assert.equal(isUnaddressed(pets), true);
});
