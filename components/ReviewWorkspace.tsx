"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { SAMPLE_LEASE, SAMPLE_LEASE_NAME } from "@/lib/review/sampleLease";
import { splitClauses } from "@/lib/review/splitClauses";
import type { Clause, ClauseNote, ParsedContract, ReviewStatus } from "@/lib/review/types";

const NOTES_KEY = "contract-review.notes.v1";

const EMPTY_NOTE: ClauseNote = { status: "unreviewed", text: "" };

function loadNotes(): Record<string, Record<string, ClauseNote>> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(NOTES_KEY);
    return raw ? (JSON.parse(raw) as Record<string, Record<string, ClauseNote>>) : {};
  } catch {
    return {};
  }
}

function noteKey(fileName: string, clauseId: string) {
  return `${fileName}::${clauseId}`;
}

export function ReviewWorkspace() {
  const [contract, setContract] = useState<ParsedContract | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, Record<string, ClauseNote>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"all" | "flagged">("all");

  useEffect(() => {
    setNotes(loadNotes());
  }, []);

  useEffect(() => {
    window.localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
  }, [notes]);

  const selected = contract?.clauses.find((clause) => clause.id === selectedId) ?? null;
  const visible = useMemo(() => {
    if (!contract) return [];
    if (filter === "flagged") {
      return contract.clauses.filter((clause) => clause.flags.length > 0);
    }
    return contract.clauses;
  }, [contract, filter]);

  const flaggedCount = contract?.clauses.filter((c) => c.flags.length > 0).length ?? 0;

  function applyContract(next: ParsedContract) {
    setContract(next);
    setSelectedId(next.clauses[0]?.id ?? null);
    setError(null);
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.set("file", file);
      const response = await fetch("/api/parse", { method: "POST", body });
      const payload = (await response.json()) as ParsedContract & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Could not parse that file.");
      }
      applyContract(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  function loadSample() {
    applyContract({
      fileName: SAMPLE_LEASE_NAME,
      pageCount: null,
      clauses: splitClauses(SAMPLE_LEASE),
    });
  }

  function updateNote(clause: Clause, patch: Partial<ClauseNote>) {
    if (!contract) return;
    setNotes((current) => {
      const forFile = current[contract.fileName] ?? {};
      const existing = forFile[clause.id] ?? EMPTY_NOTE;
      return {
        ...current,
        [contract.fileName]: {
          ...forFile,
          [clause.id]: { ...existing, ...patch },
        },
      };
    });
  }

  const currentNote =
    contract && selected
      ? (notes[contract.fileName]?.[selected.id] ?? EMPTY_NOTE)
      : EMPTY_NOTE;

  return (
    <div className="min-h-full bg-[#f4efe6] text-stone-900">
      <header className="border-b border-stone-300/80 bg-[#fbf8f2]">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-medium tracking-[0.18em] text-emerald-900 uppercase">
              Local review desk
            </p>
            <h1 className="mt-1 font-serif text-3xl tracking-tight">Contract Review</h1>
            <p className="mt-2 max-w-xl text-sm text-stone-600">
              Upload a lease or other agreement. Clauses are split for reading, common
              risk phrases are flagged, and your notes stay in this browser. This is a
              review aid, not legal advice.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="inline-flex cursor-pointer items-center rounded-md bg-emerald-900 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800">
              {busy ? "Reading…" : "Upload PDF or DOCX"}
              <input
                className="hidden"
                type="file"
                accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
                disabled={busy}
                onChange={(event) => {
                  void onFile(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
            </label>
            <button
              type="button"
              className="rounded-md border border-stone-400 bg-white px-4 py-2 text-sm hover:bg-stone-50"
              onClick={loadSample}
            >
              Try sample lease
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-6">
        {error ? (
          <p className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        ) : null}

        {!contract ? (
          <EmptyState onSample={loadSample} onFile={onFile} busy={busy} />
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
            <aside className="rounded-lg border border-stone-300 bg-white">
              <div className="border-b border-stone-200 px-4 py-3">
                <p className="truncate text-sm font-medium">{contract.fileName}</p>
                <p className="text-xs text-stone-500">
                  {contract.clauses.length} clauses
                  {contract.pageCount ? ` · ${contract.pageCount} pages` : ""}
                  {flaggedCount ? ` · ${flaggedCount} flagged` : ""}
                </p>
                <div className="mt-3 flex gap-1 text-xs">
                  <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
                    All
                  </FilterChip>
                  <FilterChip
                    active={filter === "flagged"}
                    onClick={() => setFilter("flagged")}
                  >
                    Flagged
                  </FilterChip>
                </div>
              </div>
              <ul className="max-h-[70vh] overflow-auto">
                {visible.map((clause) => {
                  const note = notes[contract.fileName]?.[clause.id] ?? EMPTY_NOTE;
                  const active = clause.id === selectedId;
                  return (
                    <li key={clause.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(clause.id)}
                        className={`w-full border-b border-stone-100 px-4 py-3 text-left text-sm hover:bg-stone-50 ${
                          active ? "bg-emerald-50" : ""
                        }`}
                      >
                        <span className="line-clamp-2 font-medium">{clause.heading}</span>
                        <span className="mt-1 flex flex-wrap gap-1">
                          {clause.flags.slice(0, 2).map((flag) => (
                            <span
                              key={noteKey(flag.id, clause.id)}
                              className={`rounded px-1.5 py-0.5 text-[11px] ${
                                flag.severity === "concern"
                                  ? "bg-red-100 text-red-800"
                                  : "bg-amber-100 text-amber-900"
                              }`}
                            >
                              {flag.label}
                            </span>
                          ))}
                          {note.status !== "unreviewed" ? (
                            <span className="rounded bg-stone-200 px-1.5 py-0.5 text-[11px] capitalize">
                              {note.status}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </aside>

            {selected ? (
              <section className="rounded-lg border border-stone-300 bg-white p-6">
                <h2 className="font-serif text-2xl">{selected.heading}</h2>
                {selected.flags.length > 0 ? (
                  <ul className="mt-4 space-y-2">
                    {selected.flags.map((flag) => (
                      <li
                        key={flag.id}
                        className={`rounded-md px-3 py-2 text-sm ${
                          flag.severity === "concern"
                            ? "bg-red-50 text-red-950"
                            : "bg-amber-50 text-amber-950"
                        }`}
                      >
                        <strong>{flag.label}.</strong> {flag.why}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-4 text-sm text-stone-500">
                    No built-in flags on this clause. Read it anyway.
                  </p>
                )}
                <p className="mt-6 whitespace-pre-wrap font-serif text-[17px] leading-7 text-stone-800">
                  {selected.body}
                </p>
                <div className="mt-8 border-t border-stone-200 pt-4">
                  <p className="text-sm font-medium">Your review</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(
                      [
                        ["unreviewed", "Unreviewed"],
                        ["ok", "Looks ok"],
                        ["question", "Question"],
                        ["concern", "Concern"],
                      ] as [ReviewStatus, string][]
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => updateNote(selected, { status: value })}
                        className={`rounded-md border px-3 py-1.5 text-sm ${
                          currentNote.status === value
                            ? "border-emerald-800 bg-emerald-900 text-white"
                            : "border-stone-300 bg-white hover:bg-stone-50"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <textarea
                    className="mt-3 min-h-28 w-full rounded-md border border-stone-300 p-3 text-sm"
                    placeholder="Questions, missing terms, or what to ask counsel…"
                    value={currentNote.text}
                    onChange={(event) =>
                      updateNote(selected, { text: event.target.value })
                    }
                  />
                </div>
              </section>
            ) : null}
          </div>
        )}
      </main>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-1 ${
        active ? "bg-emerald-900 text-white" : "bg-stone-100 text-stone-700"
      }`}
    >
      {children}
    </button>
  );
}

function EmptyState({
  onSample,
  onFile,
  busy,
}: {
  onSample: () => void;
  onFile: (file: File | undefined) => Promise<void>;
  busy: boolean;
}) {
  return (
    <div
      className="rounded-lg border border-dashed border-stone-400 bg-white/70 px-6 py-16 text-center"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        void onFile(event.dataTransfer.files[0]);
      }}
    >
      <p className="font-serif text-2xl">Drop a lease here</p>
      <p className="mt-2 text-sm text-stone-600">PDF, Word (.docx), or .txt, up to 10 MB.</p>
      <button
        type="button"
        className="mt-6 text-sm text-emerald-900 underline"
        onClick={onSample}
        disabled={busy}
      >
        Or open the sample residential lease
      </button>
    </div>
  );
}
