"use client";

import { useState } from "react";
import {
  detailEntries,
  groupLeaseTerms,
  isUnaddressed,
  readLeaseTerms,
  sourceCaption,
  summaryText,
  termSource,
  type LeaseTerm,
} from "@/lib/review/leaseTermView";

/**
 * Draws the extraction result. This component does not call the server.
 * The parent already has the JSON; this file only decides how to show it.
 *
 * Categories follow the example (rent, term, renewal, termination, deposit,
 * pets). A term with no summary, details, or quote is shown as "Not addressed".
 * "Show raw JSON" reveals the object the model returned.
 */
export function LeaseTermsPanel({
  fileName,
  result,
}: {
  fileName: string;
  result: unknown;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const terms = readLeaseTerms(result);
  const groups = terms ? groupLeaseTerms(terms) : [];

  return (
    <section className="rounded-lg border border-stone-300 bg-white">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-200 px-5 py-4">
        <div>
          <h2 className="font-serif text-2xl tracking-tight">Extracted terms</h2>
          <p className="mt-1 text-sm text-stone-600">
            {fileName}. Each value is shown next to the lease quote it came from.
          </p>
        </div>
        <button
          type="button"
          aria-expanded={showRaw}
          onClick={() => setShowRaw((open) => !open)}
          className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm hover:bg-stone-50"
        >
          {showRaw ? "Hide raw JSON" : "Show raw JSON"}
        </button>
      </div>

      {showRaw ? (
        <pre className="max-h-96 overflow-auto border-b border-stone-200 bg-stone-900 p-4 text-xs leading-5 text-stone-100">
          {JSON.stringify(result, null, 2)}
        </pre>
      ) : null}

      {terms == null ? (
        <p className="px-5 py-4 text-sm text-red-800">
          The model response did not include a lease_terms list. Use Show raw JSON to see
          exactly what came back.
        </p>
      ) : (
        <ul className="divide-y divide-stone-200">
          {groups.map((group) => (
            <li key={group.category} className="px-5 py-4">
              <h3 className="font-serif text-xl">{group.label}</h3>
              {group.terms.length === 0 ? (
                <NotAddressed />
              ) : (
                <ul className="mt-3 space-y-4">
                  {group.terms.map((term, index) => (
                    <li key={`${group.category}-${index}`}>
                      <TermRow term={term} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NotAddressed() {
  return (
    <p className="mt-3 inline-flex rounded-md bg-stone-100 px-2.5 py-1 text-sm font-medium text-stone-600">
      Not addressed
    </p>
  );
}

function TermRow({ term }: { term: LeaseTerm }) {
  if (isUnaddressed(term)) {
    return <NotAddressed />;
  }

  const summary = summaryText(term.summary);
  const details = detailEntries(term.details);
  const source = termSource(term);
  const quote = source?.quote == null ? "" : String(source.quote).trim();
  const caption = sourceCaption(source);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <p className="text-xs font-medium tracking-wide text-stone-500 uppercase">Value</p>
        {summary ? <p className="mt-1 text-sm leading-6 text-stone-800">{summary}</p> : null}
        {details.length > 0 ? (
          <dl className="mt-3 space-y-1">
            {details.map((entry) => (
              <div key={entry.label} className="grid grid-cols-[8rem_minmax(0,1fr)] gap-2 text-sm">
                <dt className="text-stone-500">{entry.label}</dt>
                <dd className="text-stone-900">{entry.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {!summary && details.length === 0 ? (
          <p className="mt-1 text-sm text-stone-500">No value returned.</p>
        ) : null}
      </div>
      <div>
        <p className="text-xs font-medium tracking-wide text-stone-500 uppercase">Source quote</p>
        {quote ? (
          <blockquote className="mt-1 border-l-2 border-emerald-800 pl-3 text-sm leading-6 text-stone-800">
            <p className="whitespace-pre-wrap">&ldquo;{quote}&rdquo;</p>
            {caption ? <p className="mt-2 text-xs text-stone-500">{caption}</p> : null}
          </blockquote>
        ) : (
          <p className="mt-1 text-sm text-stone-500">No source quote was returned.</p>
        )}
      </div>
    </div>
  );
}
