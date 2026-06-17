import { NextResponse } from "next/server";

import { getProfile } from "@/lib/auth";
import { isOpenAIConfigured, openaiSpeech } from "@/lib/ai/openai";

export const runtime = "nodejs";

/** POST { text } -> audio/mpeg. Text-to-speech via OpenAI. */
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isOpenAIConfigured()) {
    return NextResponse.json(
      { error: "Voice assistant is not configured. Add OPENAI_API_KEY." },
      { status: 503 },
    );
  }

  try {
    const { text } = await request.json();
    if (!text || typeof text !== "string") {
      return NextResponse.json({ error: "No text provided." }, { status: 400 });
    }

    // Keep TTS payloads sane.
    const audio = await openaiSpeech(text.slice(0, 4000));
    return new NextResponse(audio, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Speak error:", error);
    return NextResponse.json(
      { error: "Could not generate speech." },
      { status: 500 },
    );
  }
}
