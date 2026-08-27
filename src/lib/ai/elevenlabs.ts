import "server-only";

/**
 * ElevenLabs text-to-speech — the JARVIS voice (0104).
 *
 * OpenAI's six stock voices are fine assistants; none of them is a composed
 * British chief of staff, and the persona lives or dies on the voice. This
 * wraps exactly one endpoint (`/v1/text-to-speech/{voice}`) the same way
 * `openai.ts` wraps its API: plain fetch, no SDK, hard timeout, and a null
 * on any failure so the caller can fall back to OpenAI TTS — a wrong-accent
 * reply beats a silent one.
 *
 * The default voice is "Daniel — Steady Broadcaster" (British), chosen by
 * listening, not by vibes: steady, precise, unhurried — the register the
 * honorific prompt asks for in text. `ELEVENLABS_VOICE_ID` overrides it
 * ("George" `JBFqnCBsd6RMkjVDRZzb` is the warmer British alternative, and a
 * cloned custom voice drops in the same way).
 *
 * The settings are tuned for a butler, not an audiobook: stability up so the
 * delivery stays level across the day's hundred short utterances, a whisper
 * of style so it does not go robotic. Model default is turbo v2.5 — the
 * latency/quality point that suits sub-five-second assistant lines; flash is
 * faster but audibly cheaper, multilingual richer but slower.
 */

/** Daniel — Steady Broadcaster (premade, British). */
const DEFAULT_VOICE_ID = "onwK4e9ZLuTAKqWW03F9";
const DEFAULT_MODEL_ID = "eleven_turbo_v2_5";
const TIMEOUT_MS = 20_000;

export function isElevenLabsConfigured(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY?.trim());
}

/**
 * Synthesize `text` and return MP3 bytes, or null on ANY failure.
 *
 * Null — never throw: the speak route treats this as "use the fallback
 * engine", and a voice that can take the whole reply down with it would be
 * a worse trade than an accent.
 */
export async function elevenLabsSpeech(text: string): Promise<ArrayBuffer | null> {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key || !text.trim()) return null;

  const voiceId = process.env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_VOICE_ID;
  const modelId = process.env.ELEVENLABS_MODEL_ID?.trim() || DEFAULT_MODEL_ID;

  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
        voiceId,
      )}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: modelId,
          voice_settings: {
            stability: 0.55,
            similarity_boost: 0.75,
            style: 0.15,
            use_speaker_boost: true,
          },
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    const audio = await res.arrayBuffer();
    // An empty or trivially small body is an error page in disguise.
    return audio.byteLength > 256 ? audio : null;
  } catch {
    return null;
  }
}
