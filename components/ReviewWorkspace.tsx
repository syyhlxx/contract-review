"use client";

import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from "react";
import { LeaseTermsPanel } from "@/components/LeaseTermsPanel";
import { MAX_UPLOAD_BYTES } from "@/lib/review/limits";
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

type ExtractPayload = {
  error?: string;
  fileName?: string;
  pageCount?: number | null;
  clauses?: Clause[];
  leaseTerms?: unknown;
};

const FILE_ACCEPT =
  ".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain";

export function ReviewWorkspace() {
  // These are remembered values. Changing one redraws the page.
  // pendingFile is the lease the user picked. Nothing is sent until they click.
  // leaseTerms is the model's JSON after a successful extraction.
  // busy is true while the server is working, which is how the loading state is shown.
  const [contract, setContract] = useState<ParsedContract | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Notes live in this browser. The initializer reads them once. On the server
  // there is no localStorage, so the first render stays on the empty screen.
  const [notes, setNotes] = useState<Record<string, Record<string, ClauseNote>>>(loadNotes);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "flagged">("all");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [leaseTerms, setLeaseTerms] = useState<unknown>(null);
  const [dragActive, setDragActive] = useState(false);

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
  }

  function stageFile(file: File | undefined) {
    if (!file || busy) return;
    setPendingFile(file);
    setError(null);
  }

  // Click handler for "Extract lease terms".
  // The server reads the file, then runs the same Gemini extraction as /api/test.
  async function extractPending() {
    const file = pendingFile;
    if (!file || busy) return;

    if (file.size === 0) {
      setError(`${file.name}: That file is empty. Choose a lease that contains text.`);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`${file.name}: File is larger than 10 MB.`);
      return;
    }

    setBusy(true);
    setError(null);
    setStatus(`Reading ${file.name} and extracting lease terms…`);

    try {
      // FormData is the browser's package for sending a file.
      // The field name "file" has to match what the route handler reads.
      const body = new FormData();
      body.set("file", file);

      // await pauses this function until the server answers, without freezing the page.
      const response = await fetch("/api/extract", { method: "POST", body });
      const payload = await readExtractPayload(response);
      const parsed = hasContract(payload);

      if (parsed) {
        applyContract({
          fileName: payload.fileName as string,
          pageCount: payload.pageCount ?? null,
          clauses: payload.clauses as Clause[],
        });
      }

      if (!response.ok) {
        if (parsed) setLeaseTerms(null);
        throw new Error(payload.error || "Could not extract lease terms.");
      }

      if (payload.leaseTerms == null) {
        setLeaseTerms(null);
        throw new Error("The model did not return lease terms.");
      }

      setLeaseTerms(payload.leaseTerms);
    } catch (err) {
      const message =
        err instanceof TypeError
          ? "Could not reach the server. Check your connection and try again."
          : err instanceof Error
            ? err.message
            : "Upload failed.";
      setError(`${file.name}: ${message}`);
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  function loadSample() {
    setError(null);
    setLeaseTerms(null);
    applyContract({
      fileName: SAMPLE_LEASE_NAME,
      pageCount: null,
      clauses: splitClauses(SAMPLE_LEASE),
    });
  }

  const dropProps = {
    onDragOver: (event: DragEvent) => {
      event.preventDefault();
      if (!busy) setDragActive(true);
    },
    onDragLeave: (event: DragEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setDragActive(false);
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      setDragActive(false);
      stageFile(event.dataTransfer.files[0]);
    },
  };

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
    <div className="min-h-full bg-[#f4efe6] text-stone-900" {...dropProps}>
      <header
        className={`border-b border-stone-300/80 bg-[#fbf8f2] ${
          dragActive ? "ring-2 ring-emerald-800 ring-inset" : ""
        }`}
      >
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-medium tracking-[0.18em] text-emerald-900 uppercase">
              Local review desk
            </p>
            <h1 className="mt-1 font-serif text-3xl tracking-tight">Contract Review</h1>
            <p className="mt-2 max-w-xl text-sm text-stone-600">
              Choose a lease, then extract the key terms. Each value is shown next to
              the quote it came from. You can still read the clauses and leave notes in
              this browser. This is a review aid, not legal advice.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label
              className={`inline-flex cursor-pointer items-center rounded-md border border-stone-400 bg-white px-4 py-2 text-sm hover:bg-stone-50 ${
                busy ? "pointer-events-none opacity-60" : ""
              }`}
            >
              Choose a file
              <input
                className="hidden"
                type="file"
                accept={FILE_ACCEPT}
                disabled={busy}
                onChange={(event) => {
                  stageFile(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
            </label>
            {pendingFile ? (
              <span
                className="max-w-48 truncate text-sm text-stone-600"
                title={pendingFile.name}
              >
                {pendingFile.name}
              </span>
            ) : null}
            <button
              type="button"
              disabled={!pendingFile || busy}
              onClick={() => void extractPending()}
              className="rounded-md bg-emerald-900 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-500"
            >
              {busy ? "Extracting…" : "Extract lease terms"}
            </button>
            <button
              type="button"
              className="rounded-md border border-stone-400 bg-white px-4 py-2 text-sm hover:bg-stone-50"
              onClick={loadSample}
              disabled={busy}
            >
              Try sample lease
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-6" aria-busy={busy}>
        {error ? (
          <p
            role="alert"
            className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
          >
            {error}
          </p>
        ) : null}
        {status ? (
          <p role="status" className="mb-4 text-sm text-stone-600">
            {status}
          </p>
        ) : null}

        {!contract ? (
          <EmptyState
            onSample={loadSample}
            onFile={stageFile}
            onExtract={() => void extractPending()}
            busy={busy}
            pendingFile={pendingFile}
            dragActive={dragActive}
          />
        ) : (
          <div className="space-y-6">
            {leaseTerms != null ? (
              <LeaseTermsPanel fileName={contract.fileName} result={leaseTerms} />
            ) : null}
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
  onExtract,
  busy,
  pendingFile,
  dragActive,
}: {
  onSample: () => void;
  onFile: (file: File | undefined) => void;
  onExtract: () => void;
  busy: boolean;
  pendingFile: File | null;
  dragActive: boolean;
}) {
  return (
    <div
      className={`rounded-lg border border-dashed px-6 py-16 text-center ${
        dragActive ? "border-emerald-800 bg-emerald-50/70" : "border-stone-400 bg-white/70"
      }`}
    >
      <p className="font-serif text-2xl">Drop a lease here</p>
      <p className="mt-2 text-sm text-stone-600">
        PDF, Word (.docx), or .txt, up to 10 MB. Choose a file, then click Extract lease terms.
      </p>
      {pendingFile ? (
        <p className="mt-4 text-sm font-medium text-stone-800">{pendingFile.name}</p>
      ) : null}
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <label
          className={`inline-flex cursor-pointer items-center rounded-md border border-stone-400 bg-white px-4 py-2 text-sm hover:bg-stone-50 ${
            busy ? "pointer-events-none opacity-60" : ""
          }`}
        >
          Choose a file
          <input
            className="hidden"
            type="file"
            accept={FILE_ACCEPT}
            disabled={busy}
            onChange={(event) => {
              onFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </label>
        <button
          type="button"
          disabled={!pendingFile || busy}
          onClick={onExtract}
          className="rounded-md bg-emerald-900 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-500"
        >
          {busy ? "Extracting…" : "Extract lease terms"}
        </button>
      </div>
      <button
        type="button"
        className="mt-6 text-sm text-emerald-900 underline disabled:text-stone-400"
        onClick={onSample}
        disabled={busy}
      >
        Or open the sample residential lease
      </button>
    </div>
  );
}

function hasContract(payload: ExtractPayload): boolean {
  return typeof payload.fileName === "string" && Array.isArray(payload.clauses);
}

async function readExtractPayload(response: Response): Promise<ExtractPayload> {
  const raw = await response.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ExtractPayload;
  } catch {
    throw new Error(
      response.status === 413
        ? "File is larger than 10 MB."
        : "The server returned an unexpected response. Try again.",
    );
  }
}
