import { parseDocument } from "@/lib/review/parseDocument";
import { readUploadedFile } from "@/lib/review/readUpload";

/**
 * POST /api/parse
 *
 * A route handler is a function Next.js runs on the server when a request
 * arrives at this URL. This one only reads the file. It does not call a model.
 * The upload box uses /api/extract, which calls this same file reader and
 * then the lease-term extraction.
 */
export async function POST(request: Request) {
  try {
    const { fileName, bytes } = await readUploadedFile(request);
    const parsed = await parseDocument(fileName, bytes);
    return Response.json(parsed);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not read that contract.";
    return Response.json({ error: message }, { status: 400 });
  }
}
