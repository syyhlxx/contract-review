import {
  sectionCitation,
  type LeaseChunk,
  type LeaseChunkBatch,
} from "./chunkLease";
import {
  isUnaddressed,
  LEASE_CATEGORIES,
  termSource,
  type LeaseTerm,
  type LeaseTermSource,
} from "./leaseTermView";

/**
 * Fold several model responses into one `{ lease_terms: [...] }` object.
 *
 * Each batch is one model call. The model is asked for every category every
 * time, so a batch that does not mention rent still comes back with a blank
 * rent entry. Those blanks are dropped. A category nobody mentioned is
 * added back once, with nulls, so the page can show "Not addressed".
 *
 * When a real finding has no section, the section is copied from the chunk
 * the quote was found in. The model's own section is kept when it gave one:
 * it may be more specific ("12.1") than the heading we detected ("12").
 *
 * This does not rank chunks or answer questions. That is the later retrieval step.
 */

export function mergeLeaseTerms(
  batchTerms: LeaseTerm[][],
  batches: LeaseChunkBatch[],
  chunks: LeaseChunk[],
): { lease_terms: LeaseTerm[] } {
  const byCategory = new Map<string, LeaseTerm[]>();
  const extras: string[] = [];

  for (let i = 0; i < batchTerms.length; i++) {
    const batch = batches[i];
    const inBatch = batch
      ? chunks.filter((chunk) => batch.chunkIndexes.includes(chunk.index))
      : [];

    for (const term of batchTerms[i] ?? []) {
      if (isUnaddressed(term)) continue;
      const cited = citeTerm(term, inBatch);
      const key = categoryKey(cited);
      const list = byCategory.get(key);
      if (list) {
        list.push(cited);
      } else {
        byCategory.set(key, [cited]);
        if (!isKnownCategory(key)) extras.push(key);
      }
    }
  }

  const lease_terms: LeaseTerm[] = [];
  for (const category of LEASE_CATEGORIES) {
    const found = dedupeTerms(byCategory.get(category) ?? []);
    if (found.length === 0) {
      lease_terms.push({ category, summary: null, details: null, source: null });
    } else {
      lease_terms.push(...found);
    }
  }
  for (const category of extras) {
    lease_terms.push(...dedupeTerms(byCategory.get(category) ?? []));
  }
  return { lease_terms };
}

/**
 * Point a term at the chunk it came from.
 * A quote that appears in the chunk text is the best evidence. If the quote
 * is missing or was paraphrased, and this batch covers only one section,
 * that section is used. A batch that covers several sections is not guessed.
 */
function citeTerm(term: LeaseTerm, batchChunks: LeaseChunk[]): LeaseTerm {
  const source = termSource(term);
  if (sectionAlreadySet(source)) return term;

  const quote = source?.quote == null ? "" : String(source.quote);
  const quoted = batchChunks.filter((chunk) => chunkContainsQuote(chunk, quote));
  if (quoted.length > 0) return withSection(term, sectionCitation(quoted[0]));

  const labels = uniqueLabels(batchChunks);
  if (labels.length === 1) return withSection(term, labels[0]);
  return term;
}

function withSection(term: LeaseTerm, citation: string | null): LeaseTerm {
  if (!citation) return term;
  const source = termSource(term);
  return {
    ...term,
    source: {
      ...(source ?? {}),
      section: citation,
    },
  };
}

function chunkContainsQuote(chunk: LeaseChunk, quote: string): boolean {
  const raw = quote.trim();
  if (raw.length < 8) return false;
  if (chunk.text.includes(raw)) return true;

  const normChunk = chunk.text.replace(/\s+/g, " ");
  const normQuote = raw.replace(/\s+/g, " ");
  if (normChunk.includes(normQuote)) return true;
  // Models sometimes add an ellipsis or drop a few words at the end.
  if (normQuote.length >= 48 && normChunk.includes(normQuote.slice(0, 48))) return true;
  return false;
}

function uniqueLabels(chunks: LeaseChunk[]): string[] {
  const labels: string[] = [];
  for (const chunk of chunks) {
    const label = sectionCitation(chunk);
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

/**
 * The same sentence can sit in two chunks when a long section overlaps.
 * Keep the earlier copy and list both sections if they differ.
 */
function dedupeTerms(terms: LeaseTerm[]): LeaseTerm[] {
  const kept: LeaseTerm[] = [];
  for (const term of terms) {
    const match = kept.find((existing) => sameFinding(existing, term));
    if (!match) {
      // Copy so joining a section later does not rewrite the model object.
      kept.push({ ...term });
      continue;
    }
    const section = joinSections(termSource(match)?.section, termSource(term)?.section);
    if (!section) continue;
    const source = termSource(match);
    match.source = { ...(source ?? {}), section };
  }
  return kept;
}

function sameFinding(left: LeaseTerm, right: LeaseTerm): boolean {
  const leftQuote = normalize(termSource(left)?.quote);
  const rightQuote = normalize(termSource(right)?.quote);
  if (leftQuote && rightQuote) return leftQuote === rightQuote;
  if (leftQuote || rightQuote) return false;
  const leftSummary = normalize(left.summary);
  const rightSummary = normalize(right.summary);
  return leftSummary !== "" && leftSummary === rightSummary;
}

function joinSections(left: unknown, right: unknown): string | null {
  const a = sectionText(left);
  const b = sectionText(right);
  if (!a) return b || null;
  if (!b || a === b) return a;
  const parts = a.split("; ").map((part) => part.trim());
  if (parts.includes(b)) return a;
  return `${a}; ${b}`;
}

function sectionText(value: unknown): string {
  if (value == null) return "";
  return String(value).trim();
}

function sectionAlreadySet(source: LeaseTermSource | null): boolean {
  if (!source || source.section == null) return false;
  if (typeof source.section === "string") return source.section.trim() !== "";
  return true;
}

function categoryKey(term: LeaseTerm): string {
  if (term.category == null) return "other";
  const key = String(term.category).trim().toLowerCase();
  return key || "other";
}

function isKnownCategory(key: string): boolean {
  for (const category of LEASE_CATEGORIES) {
    if (category === key) return true;
  }
  return false;
}

function normalize(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
