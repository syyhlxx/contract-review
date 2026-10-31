import { GoogleGenAI } from "@google/genai";
import { readFile} from "fs/promises";
import path from "path";


const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function GET() {
  const instructions = await readFile(path.join(process.cwd(), "prompts", "extract-terms.md"), "utf-8");
  const example = await readFile(path.join(process.cwd(), "prompts", "example_output.json"), "utf-8");
  const leaseText = "Tenant shall pay $1,500 per month, due on the 1st. Security deposit is $1,500. No pets allowed.";

const prompt = `${instructions}

${example}

Lease text: ${leaseText}
`;  
const response = await ai.models.generateContent({
  model: "gemini-3.8-flash",
  contents: prompt,
  config: { responseMimeType: "application/json" },
});
return Response.json(JSON.parse(response.text ?? "{}"));
}



 
export async function POST(request: Request) {
  const { prompt, model } = await request.json();

  const response = await ai.models.generateContent({
    model: model || "gemini-3.8-flash",
    contents: prompt,
  });

  return Response.json({ reply: response.text });
}