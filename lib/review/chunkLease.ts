import { CHUNK_OVERLAP_CHARS, MAX_CHUNK_CHARS } from "./limits";

/**
 * Split a lease into pieces that follow the document's own headings.
 *
 * A later retrieval step can store each chunk (and, later, an embedding of
 * `text`) and pull back the pieces that answer a question. This file only
 * splits and labels. It does not call a model, a database, or the network.
 *
 * Offsets are character indexes into the string you pass in. `startOffset`
 * is included and `endOffset` is excluded, the same rule as Java's
 * `String.substring(begin, end)`. For every chunk,
 * `text.slice(startOffset, endOffset) === chunk.text`.
 *
 * Headings this recognizes, each at the start of a line:
 *   ARTICLE 5, Article V, ART. 2
 *   Section 12, SECTION 12.1, Clause 4
 *   12. Assignment, 12) Assignment, 12 - Assignment
 *
 * Text before the first heading is its own chunk, with a null section.
 * A document with no headings is cut on paragraphs instead.
 * A section longer than the chunk size is cut on paragraphs, then sentences,
 * and neighboring pieces overlap a little so a sentence on the boundary is
 * not lost.
 */

export type LeaseChunk = {
  /** Stable for this text and these options. `chunk-0` is the first piece. */
  id: string;
  /** Position in reading order. The first chunk is 0. */
  index: number;
  /**
   * Section label copied from the heading, such as "ARTICLE 5",
   * "Section 12", or "12". Null for a preamble or a document with no headings.
   */
  section: string | null;
  /** Words that followed the label, such as "Assignment". Null when absent. */
  title: string | null;
  /** Exact slice of the original lease. Safe to embed later. */
  text: string;
  startOffset: number;
  endOffset: number;
};

/**
 * One model call. A short lease is a single batch holding every chunk.
 * A long lease is several batches, each small enough to send on its own.
 * Chunks that overlap (a section that had to be cut) are not packed back
 * together, or the model would see the long section again.
 */
export type LeaseChunkBatch = {
  index: number;
  text: string;
  startOffset: number;
  endOffset: number;
  /** `LeaseChunk.index` values whose text sits inside this batch. */
  chunkIndexes: number[];
};

export type ChunkLeaseOptions = {
  /** Maximum characters in one chunk. Defaults to MAX_CHUNK_CHARS. */
  maxChars?: number;
  /** Characters repeated when a section is cut. Defaults to CHUNK_OVERLAP_CHARS. */
  overlapChars?: number;
};

type LineSpan = { start: number; end: number };

type Heading = {
  start: number;
  section: string;
  title: string | null;
};

type Span = {
  start: number;
  end: number;
  section: string | null;
  title: string | null;
};

const ARTICLE =
  /^(article|art\.)\s+([0-9]+|[IVXLCDM]+)\b(.*)$/i;
const SECTION_WORD =
  /^(section|clause)\s+([0-9]+(?:\.[0-9]+)*|[IVXLCDM]+)\b(.*)$/i;
const NUMBERED =
  /^(\d+(?:\.\d+)*)[.)](?:\s+(\S.*))?$/;
const NUMBERED_DASH =
  /^(\d+(?:\.\d+)*)\s*[-–—]\s+(\S.*)$/;

/**
 * A readable citation for a chunk, such as "12. Assignment" or "ARTICLE 5. RENT".
 * The section and the title stay separate on the chunk itself. This string is
 * what extraction writes into a term's source when the model left the section blank.
 */
export function sectionCitation(chunk: {
  section: string | null;
  title: string | null;
}): string | null {
  if (!chunk.section) return null;
  const title = chunk.title?.trim() ?? "";
  if (!title) return chunk.section;
  if (chunk.section.toLowerCase().includes(title.toLowerCase())) return chunk.section;
  return `${chunk.section}. ${title}`;
}

export function chunkLease(text: string, options?: ChunkLeaseOptions): LeaseChunk[] {
  if (text.trim() === "") return [];

  const maxChars = clampMax(options?.maxChars ?? MAX_CHUNK_CHARS);
  const overlap = clampOverlap(options?.overlapChars ?? CHUNK_OVERLAP_CHARS, maxChars);
  const spans = spansFromHeadings(text, findHeadings(text));
  const chunks: LeaseChunk[] = [];

  for (const span of spans) {
    const windows = windowsFor(text, span.start, span.end, maxChars, overlap);
    for (const window of windows) {
      const index = chunks.length;
      chunks.push({
        id: `chunk-${index}`,
        index,
        section: span.section,
        title: span.title,
        text: text.slice(window.start, window.end),
        startOffset: window.start,
        endOffset: window.end,
      });
    }
  }

  return chunks;
}

/**
 * Pack chunks into model calls.
 *
 * If the whole lease already fits, the batch text is the original string.
 * Short leases therefore go out in one call, exactly as they did before
 * this splitter existed. Longer leases are packed in order until the next
 * chunk would pass `maxChars`.
 */
export function batchChunks(
  text: string,
  chunks: LeaseChunk[],
  maxChars: number = MAX_CHUNK_CHARS,
): LeaseChunkBatch[] {
  if (chunks.length === 0) return [];

  const limit = clampMax(maxChars);
  if (text.length <= limit) {
    return [
      {
        index: 0,
        text,
        startOffset: 0,
        endOffset: text.length,
        chunkIndexes: chunks.map((chunk) => chunk.index),
      },
    ];
  }

  const batches: LeaseChunkBatch[] = [];
  let group: LeaseChunk[] = [];

  const flush = () => {
    if (group.length === 0) return;
    const startOffset = group[0].startOffset;
    const endOffset = group[group.length - 1].endOffset;
    batches.push({
      index: batches.length,
      text: text.slice(startOffset, endOffset),
      startOffset,
      endOffset,
      chunkIndexes: group.map((chunk) => chunk.index),
    });
    group = [];
  };

  for (const chunk of chunks) {
    if (group.length === 0) {
      group.push(chunk);
      continue;
    }
    const previous = group[group.length - 1];
    const overlaps = chunk.startOffset < previous.endOffset;
    const combinedLength = chunk.endOffset - group[0].startOffset;
    if (overlaps || combinedLength > limit) flush();
    group.push(chunk);
  }
  flush();
  return batches;
}

function findHeadings(text: string): Heading[] {
  const lines = lineSpans(text);
  const headings: Heading[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = text.slice(lines[i].start, lines[i].end);
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const match = matchHeading(trimmed);
    if (!match) continue;

    const lead = raw.length - raw.trimStart().length;
    let title = match.title;
    if (!title) title = lookAheadTitle(text, lines, i);

    headings.push({
      start: lines[i].start + lead,
      section: match.section,
      title,
    });
  }

  return headings;
}

function matchHeading(trimmed: string): { section: string; title: string | null } | null {
  const article = ARTICLE.exec(trimmed);
  // The character class used for Roman numerals also spells ordinary words
  // ("CIVIL", "MILL"). Only accept a token that is a real numeral.
  if (article && isHeadingNumber(article[2])) {
    return {
      section: `${article[1]} ${article[2]}`,
      title: titleFromRemainder(stripSeparator(article[3] ?? "")),
    };
  }

  const section = SECTION_WORD.exec(trimmed);
  if (section && isHeadingNumber(section[2])) {
    return {
      section: `${section[1]} ${section[2]}`,
      title: titleFromRemainder(stripSeparator(section[3] ?? "")),
    };
  }

  const numbered = NUMBERED.exec(trimmed);
  if (numbered) {
    const rest = numbered[2] ?? "";
    const title = titleFromRemainder(rest);
    // A long line that is really a sentence ("1. Tenant shall pay...") is
    // not a heading unless a short label comes first ("1. Term. Tenant...").
    if (trimmed.length > 120 && !title) return null;
    return { section: numbered[1], title };
  }

  const dashed = NUMBERED_DASH.exec(trimmed);
  if (dashed) {
    const title = titleFromRemainder(dashed[2]);
    if (!title) return null;
    return { section: dashed[1], title };
  }

  return null;
}

/** Digits ("12", "12.1") or a Roman numeral ("IV", "12" is already caught). */
function isHeadingNumber(token: string): boolean {
  if (/^\d+(?:\.\d+)*$/.test(token)) return true;
  return /^(?:M{0,4})(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/i.test(token);
}

function stripSeparator(rest: string): string {
  return rest.replace(/^\s*[:.)\-–—]+\s*/, "").trim();
}

/**
 * Pull a short label out of the words that follow a heading number.
 * "Assignment" and "Rent. Tenant shall pay..." both yield a title.
 * A full sentence with no label does not.
 */
function titleFromRemainder(rest: string): string | null {
  const trimmed = rest.trim();
  if (!trimmed) return null;
  const broken = /^(.{1,80}?)[.?!]\s+\S/.exec(trimmed);
  const candidate = broken ? broken[1].trim() : trimmed.replace(/[.?!]+$/, "").trim();
  return acceptTitle(candidate);
}

function lookAheadTitle(text: string, lines: LineSpan[], index: number): string | null {
  for (let j = index + 1; j < lines.length && j <= index + 3; j++) {
    const trimmed = text.slice(lines[j].start, lines[j].end).trim();
    if (!trimmed) continue;
    if (matchHeading(trimmed)) return null;
    return titleFromFollowingLine(trimmed);
  }
  return null;
}

function titleFromFollowingLine(trimmed: string): string | null {
  if (trimmed.length > 60) return null;
  // A body sentence usually has a period in the middle or more than a few words.
  if (/[.?!].+\S/.test(trimmed)) return null;
  const stripped = trimmed.replace(/[:.\-–—]+$/, "").trim();
  return acceptTitle(stripped);
}

function acceptTitle(candidate: string): string | null {
  if (!candidate || candidate.length > 80) return null;
  const words = candidate.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 8) return null;
  if (
    words.length > 4 &&
    /^(the|this|tenant|landlord|if|either|any|all|a|an)\b/i.test(candidate)
  ) {
    return null;
  }
  return candidate;
}

function spansFromHeadings(text: string, headings: Heading[]): Span[] {
  if (headings.length === 0) {
    const only = trimRange(text, 0, text.length);
    return only ? [{ ...only, section: null, title: null }] : [];
  }

  const spans: Span[] = [];
  if (headings[0].start > 0) {
    const preamble = trimRange(text, 0, headings[0].start);
    if (preamble) spans.push({ ...preamble, section: null, title: null });
  }

  for (let i = 0; i < headings.length; i++) {
    const end = i + 1 < headings.length ? headings[i + 1].start : text.length;
    const range = trimRange(text, headings[i].start, end);
    if (!range) continue;
    spans.push({
      ...range,
      section: headings[i].section,
      title: headings[i].title,
    });
  }

  return spans;
}

/**
 * Cut [start, end) into windows of at most `maxChars`.
 * Windows after the first one start `overlap` characters before the
 * previous window ended, so the shared words appear in both pieces.
 */
function windowsFor(
  text: string,
  start: number,
  end: number,
  maxChars: number,
  overlap: number,
): Array<{ start: number; end: number }> {
  const windows: Array<{ start: number; end: number }> = [];
  let cursor = start;

  while (cursor < end) {
    let windowEnd = Math.min(cursor + maxChars, end);
    if (windowEnd < end) windowEnd = snapEnd(text, cursor, windowEnd);

    const reachedEnd = windowEnd >= end;
    const trimmed = trimRange(text, cursor, windowEnd);
    if (!trimmed) {
      if (windowEnd <= cursor) break;
      cursor = windowEnd;
      continue;
    }

    windows.push(trimmed);
    if (reachedEnd) break;

    let next = trimmed.end - overlap;
    if (next < start) next = start;
    if (next > trimmed.start && next < trimmed.end && !isWordBoundary(text, next)) {
      let wordStart = next;
      while (wordStart > trimmed.start && !isWordBoundary(text, wordStart)) wordStart--;
      if (wordStart > trimmed.start) next = wordStart;
    }
    // Guarantee forward progress. A chunk shorter than the overlap would
    // otherwise start the next loop at the same place.
    if (next <= trimmed.start) next = trimmed.end;
    cursor = next;
  }

  return windows;
}

/**
 * Prefer to end a window on a blank line. If the section has no blank line
 * in range, end on a newline, then a sentence, then a space. Never end in
 * the first half of the window, or every chunk would be a short fragment.
 */
function snapEnd(text: string, start: number, hardEnd: number): number {
  const min = start + Math.floor((hardEnd - start) * 0.5);
  const paragraph = lastParagraphBreak(text, min, hardEnd);
  if (paragraph >= 0) return paragraph;

  const region = text.slice(min, hardEnd);
  const line = region.lastIndexOf("\n");
  if (line >= 0) return min + line;

  const sentence = Math.max(
    region.lastIndexOf(". "),
    region.lastIndexOf(".\n"),
    region.lastIndexOf("? "),
    region.lastIndexOf("! "),
  );
  if (sentence >= 0) return min + sentence + 1;

  const space = region.lastIndexOf(" ");
  if (space >= 0) return min + space;
  return hardEnd;
}

function lastParagraphBreak(text: string, from: number, to: number): number {
  let found = -1;
  for (let i = from; i < to - 1; i++) {
    if (text[i] !== "\n" && text[i] !== "\r") continue;
    let j = i + 1;
    if (text[i] === "\r" && text[j] === "\n") j++;
    let k = j;
    while (k < to && (text[k] === " " || text[k] === "\t")) k++;
    if (k < to && (text[k] === "\n" || text[k] === "\r")) found = i;
  }
  return found;
}

function lineSpans(text: string): LineSpan[] {
  const lines: LineSpan[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "\n" && ch !== "\r") continue;
    lines.push({ start, end: i });
    if (ch === "\r" && text[i + 1] === "\n") i++;
    start = i + 1;
  }
  lines.push({ start, end: text.length });
  return lines;
}

function trimRange(
  text: string,
  start: number,
  end: number,
): { start: number; end: number } | null {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  if (start >= end) return null;
  return { start, end };
}

function isWordBoundary(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return true;
  return /\s/.test(text[index]) || /\s/.test(text[index - 1]);
}

function clampMax(value: number): number {
  if (!Number.isFinite(value) || value < 40) return 40;
  return Math.floor(value);
}

function clampOverlap(value: number, maxChars: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  const cap = Math.floor(maxChars / 4);
  return Math.min(Math.floor(value), cap);
}
