import {
  buildDemoPrompt,
  extractFromPrompt,
  extractLeaseTerms,
  LeaseExtractError,
} from "@/lib/review/extractTerms";

/**
 * /api/test is the original extraction endpoint.
 *
 * POST takes JSON { leaseText } and returns the model's JSON.
 * GET runs the same extractor on a short hard-coded sentence, using the
 * original demo prompt wording. The upload box does not call this URL;
 * it calls /api/extract, which uses the same POST prompt via extractLeaseTerms.
 */

const DEMO_LEASE =
  "Tenant shall pay $1,500 per month, due on the 1st. Security deposit is $1,500. No pets allowed.";

function errorResponse(error: unknown) {
  const status = error instanceof LeaseExtractError ? error.status : 500;
  const message = error instanceof Error ? error.message : "Could not extract lease terms.";
  return Response.json({ error: message }, { status });
}

export async function GET() {
  try {
    const prompt = await buildDemoPrompt(DEMO_LEASE);
    const result = await extractFromPrompt(DEMO_LEASE, prompt);
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: 'Send JSON like { "leaseText": "..." }.' },
        { status: 400 },
      );
    }

    const leaseText =
      body && typeof body === "object" ? (body as { leaseText?: unknown }).leaseText : undefined;

    if (typeof leaseText !== "string" || leaseText.trim() === "") {
      return Response.json({ error: "leaseText is required" }, { status: 400 });
    }

    const result = await extractLeaseTerms(leaseText);
    return Response.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
