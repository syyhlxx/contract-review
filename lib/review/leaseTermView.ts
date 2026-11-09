/**
 * Helpers for drawing the model's JSON on the page.
 *
 * These functions do not check that the model followed the prompt.
 * They only group what came back so the page can show each category,
 * the value, the source quote, and "Not addressed" when a term is missing.
 */

export const LEASE_CATEGORIES = [
  "rent",
  "term",
  "renewal",
  "termination",
  "deposit",
  "pets",
] as const;

const CATEGORY_LABELS: Record<string, string> = {
  rent: "Rent",
  term: "Lease term",
  renewal: "Renewal",
  termination: "Termination",
  deposit: "Security deposit",
  pets: "Pets",
};

export type LeaseTermSource = {
  section?: string | number | null;
  page?: string | number | null;
  quote?: string | null;
};

export type LeaseTerm = {
  category?: unknown;
  summary?: unknown;
  details?: unknown;
  source?: unknown;
};

export type TermGroup = {
  category: string;
  label: string;
  terms: LeaseTerm[];
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? formatDetailLabel(category);
}

export function formatDetailLabel(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim();
  if (!words) return key;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function isBlank(value: unknown): boolean {
  return value == null || (typeof value === "string" && value.trim() === "");
}

function detailsAreEmpty(details: unknown): boolean {
  if (details == null) return true;
  if (typeof details !== "object" || Array.isArray(details)) return false;
  const values = Object.values(details as Record<string, unknown>);
  if (values.length === 0) return true;
  return values.every((value) => isBlank(value));
}

export function termSource(term: LeaseTerm): LeaseTermSource | null {
  const source = term.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  return source as LeaseTermSource;
}

/** A term the lease does not mention: no summary, no details, and no quote. */
export function isUnaddressed(term: LeaseTerm): boolean {
  const quote = termSource(term)?.quote;
  const quoteBlank = quote == null || String(quote).trim() === "";
  return isBlank(term.summary) && detailsAreEmpty(term.details) && quoteBlank;
}

export function summaryText(summary: unknown): string | null {
  if (typeof summary === "string") {
    const trimmed = summary.trim();
    return trimmed || null;
  }
  if (typeof summary === "number" || typeof summary === "boolean") return String(summary);
  return null;
}

export function formatDetailValue(value: unknown): string | null {
  if (isBlank(value)) return null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value.trim();
  return JSON.stringify(value);
}

export function detailEntries(details: unknown): { label: string; value: string }[] {
  if (!details || typeof details !== "object" || Array.isArray(details)) return [];
  const entries: { label: string; value: string }[] = [];
  for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
    const formatted = formatDetailValue(value);
    if (formatted == null) continue;
    entries.push({ label: formatDetailLabel(key), value: formatted });
  }
  return entries;
}

export function sourceCaption(source: LeaseTermSource | null | undefined): string | null {
  if (!source) return null;
  const bits: string[] = [];
  if (!isBlank(source.section)) bits.push(`Section ${String(source.section).trim()}`);
  if (!isBlank(source.page)) bits.push(`page ${String(source.page).trim()}`);
  return bits.length > 0 ? bits.join(", ") : null;
}

/**
 * Pull `lease_terms` out of the model JSON.
 * Returns null when the response is not the expected object, so the page
 * can show an error and the raw JSON instead of a blank list.
 */
export function readLeaseTerms(payload: unknown): LeaseTerm[] | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const terms = (payload as { lease_terms?: unknown }).lease_terms;
  if (!Array.isArray(terms)) return null;
  return terms.filter(
    (item): item is LeaseTerm => !!item && typeof item === "object" && !Array.isArray(item),
  );
}

function categoryKey(term: LeaseTerm): string {
  const raw = term.category == null ? "" : String(term.category).trim().toLowerCase();
  return raw || "other";
}

/**
 * Known categories come first, in the same order as the example output,
 * even when the model left one out. Anything else is appended after.
 */
export function groupLeaseTerms(terms: LeaseTerm[]): TermGroup[] {
  const byCategory = new Map<string, LeaseTerm[]>();
  for (const term of terms) {
    const key = categoryKey(term);
    const list = byCategory.get(key) ?? [];
    list.push(term);
    byCategory.set(key, list);
  }

  const groups: TermGroup[] = [];
  for (const category of LEASE_CATEGORIES) {
    groups.push({
      category,
      label: categoryLabel(category),
      terms: byCategory.get(category) ?? [],
    });
    byCategory.delete(category);
  }
  for (const [category, list] of byCategory) {
    groups.push({ category, label: categoryLabel(category), terms: list });
  }
  return groups;
}
