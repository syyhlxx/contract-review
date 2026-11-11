import { MAX_UPLOAD_BYTES } from "./limits";

/**
 * Read the file a browser sent to a route handler.
 *
 * The browser packs the file into FormData, a list of named fields.
 * The upload box uses the field name "file". This checks that the field
 * is present, that the file is not empty, and that it is within the size
 * limit, then returns the raw bytes for the parser.
 */
export async function readUploadedFile(
  request: Request,
): Promise<{ fileName: string; bytes: Uint8Array }> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new Error("Could not read the upload. Try a smaller PDF, Word, or text file.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new Error("Choose a contract file to review.");
  }
  if (file.size === 0) {
    throw new Error("That file is empty. Choose a lease that contains text.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("File is larger than 10 MB.");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  return { fileName: file.name, bytes };
}
