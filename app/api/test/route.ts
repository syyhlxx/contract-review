import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function GET() {
  const response = await ai.models.generateContent({
    model: "gemini-3.8-flash",
    contents: "Say hello to a lawyer who codes.",
  });
  return Response.json({ reply: response.text });
}