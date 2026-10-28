# Contract Review

Local web app for reading legal contracts such as lease agreements. Upload a PDF, Word (`.docx`), or text file. The app splits the document into clauses, flags common risk phrases, and lets you leave notes in the browser.

This is a review aid, not legal advice.

## Run it

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Use **Try sample lease** if you do not have a file handy.

## Layout

- `app/page.tsx` — home screen
- `components/ReviewWorkspace.tsx` — upload, clause list, notes
- `app/api/parse/route.ts` — file upload and text extraction
- `lib/review/parseDocument.ts` — PDF / DOCX / TXT parsing
- `lib/review/splitClauses.ts` — heading and numbered-clause splitting
- `lib/review/flagClauses.ts` — phrase flags (good first change)
- `lib/review/sampleLease.ts` — demo residential lease
