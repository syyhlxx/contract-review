# Contract Review

Local web app for reading legal contracts such as lease agreements. Upload a PDF, Word (`.docx`), or text file. The app splits the document into clauses, flags common risk phrases, and lets you leave notes in the browser.

This is a review aid, not legal advice.

## Run it

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Use **Try sample lease** if you do not have a file handy.

## See extraction progress (Windows and Mac)

`npm run dev` uses Turbopack. API routes run in a worker, and that worker's stdout does not show up in the terminal. Extraction still writes every step to `logs/extract.log`.

To watch those lines in the same window as the dev server:

```bash
npm run dev:log
```

That command starts Next and a small Node script that prints new lines from `logs/extract.log`. It does not use the Unix `tail` command, so it works in Windows PowerShell and on a Mac. Stop it with Ctrl+C.

`npm run dev:webpack` starts the dev server without Turbopack (`next dev --webpack`). Route `console.error` lines may then show up directly. The log file is still written. On Windows, prefer `npm run dev:log`.

## Gemini

Copy `.env.example` to `.env.local` and set `GEMINI_API_KEY`. Do not commit the key.

- `GEMINI_MODEL` — primary model. Default `gemini-3.8-flash`.
- `GEMINI_FALLBACK_MODELS` — comma-separated models used after the primary returns 503, 504, or a second 500. Default `gemini-3.6-flash,gemini-3.5-flash-lite`. Set it empty to keep retrying the primary only.

`gemini-flash-latest` is not a useful fallback. It currently points at `gemini-3.8-flash`, which is the model that has been returning 503.

## Layout

- `app/page.tsx` — home screen
- `components/ReviewWorkspace.tsx` — upload, clause list, notes
- `app/api/parse/route.ts` — file upload and text extraction
- `lib/review/parseDocument.ts` — PDF / DOCX / TXT parsing
- `lib/review/splitClauses.ts` — heading and numbered-clause splitting
- `lib/review/flagClauses.ts` — phrase flags (good first change)
- `lib/review/sampleLease.ts` — demo residential lease
