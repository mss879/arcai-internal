import { NextResponse } from "next/server";

import { getProfile } from "@/lib/auth";
import { isOpenAIConfigured, openaiTranscribe } from "@/lib/ai/openai";

export const runtime = "nodejs";

/** POST audio (multipart "audio") -> { text }. Speech-to-text via OpenAI. */
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
    const form = await request.formData();
    const file = form.get("audio");
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: "No audio provided." }, { status: 400 });
    }

    const name =
      file instanceof File && file.name ? file.name : "audio.webm";
    const text = await openaiTranscribe(file, name);
    return NextResponse.json({ text });
  } catch (error) {
    console.error("Transcribe error:", error);
    return NextResponse.json(
      { error: "Could not transcribe audio." },
      { status: 500 },
    );
  }
}
