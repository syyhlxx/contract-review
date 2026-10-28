import { parseDocument } from "@/lib/review/parseDocument";

export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get("file");

  if (!(file instanceof File)) {
    return Response.json({ error: "Choose a contract file to review." }, { status: 400 });
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = await parseDocument(file.name, bytes);
    return Response.json(parsed);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not read that contract.";
    return Response.json({ error: message }, { status: 400 });
  }
}
