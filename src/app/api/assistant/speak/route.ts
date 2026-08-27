import { NextResponse } from "next/server";

import { getAssistantProfile } from "@/lib/auth";
import {
  elevenLabsSpeech,
  isElevenLabsConfigured,
} from "@/lib/ai/elevenlabs";
import { isOpenAIConfigured, openaiSpeech } from "@/lib/ai/openai";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST { text } -> audio/mpeg.
 *
 * TWO engines, one contract (0104). When ELEVENLABS_API_KEY is set, the
 * reply speaks with the JARVIS voice — Daniel, British, steady — and every
 * caller (spoken replies, the precached greeting and wake ack, ambient
 * alerts) gets it for free, because they all come through this one route.
 * Any ElevenLabs failure falls back to OpenAI TTS in the same request: a
 * different accent for one reply beats a silent assistant.
 *
 * The member's `voice_style` (0101) only applies on the OpenAI path —
 * ElevenLabs voices are tuned by fixed settings, not prose instructions.
 */
export async function POST(request: Request) {
  const profile = await getAssistantProfile();
  if (!profile) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isOpenAIConfigured() && !isElevenLabsConfigured()) {
    return NextResponse.json(
      {
        error:
          "Voice is not configured. Add ELEVENLABS_API_KEY or OPENAI_API_KEY.",
      },
      { status: 503 },
    );
  }

  try {
    const { text } = await request.json();
    if (!text || typeof text !== "string") {
      return NextResponse.json({ error: "No text provided." }, { status: 400 });
    }

    // Keep TTS payloads sane.
    const speakable = text.slice(0, 4000);

    // The JARVIS voice first. Null means "engine unavailable / failed", and
    // the OpenAI path below answers instead — same bytes contract.
    if (isElevenLabsConfigured()) {
      const audio = await elevenLabsSpeech(speakable);
      if (audio) {
        return new NextResponse(audio, {
          headers: {
            "Content-Type": "audio/mpeg",
            "Cache-Control": "no-store",
          },
        });
      }
    }
    if (!isOpenAIConfigured()) {
      return NextResponse.json(
        { error: "Could not generate speech." },
        { status: 502 },
      );
    }

    // The voice style is a nicety, never a blocker: a failed lookup just
    // means the default voice, not a silent assistant.
    let instructions: string | undefined;
    try {
      const supabase = await createClient();
      const { data } = await supabase
        .from("assistant_config")
        .select("voice_style")
        .eq("user_id", profile.id)
        .maybeSingle();
      instructions = data?.voice_style?.trim() || undefined;
    } catch {
      instructions = undefined;
    }

    const audio = await openaiSpeech(
      speakable,
      instructions ? { instructions } : undefined,
    );
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
