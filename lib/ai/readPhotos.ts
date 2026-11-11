import 'server-only';
// The model call behind AI photo reading. One request: the area's photos (numbered), what the
// estimator has entered, and a structured-output schema, so the answer is JSON of a known shape.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { modelReadSchema, PHOTO_READ_MODEL, PHOTO_READ_SYSTEM, readCostUsd, readRequestText, sanitizeRead, type PhotoRead, type ReadContext } from './photoRead';

export type ReadImage = { mediaType: 'image/jpeg' | 'image/png' | 'image/webp'; base64: string };

/** Tokens and cost of a call that reached the model, so even a failed read is logged and counted. */
export interface ReadUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** A failure the field app can show as-is. `code` lets the app tell "not set up" from "try again". */
export class PhotoReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: 'not_configured' | 'bad_key' | 'refused' | 'incomplete' | 'busy' | 'unreachable' | 'aborted' | 'failed',
    readonly usage: ReadUsage | null = null,
  ) {
    super(message);
  }
}

export function photoReadConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export interface ReadResult extends ReadUsage {
  read: PhotoRead;
}

/** Give up a little before the route's maxDuration (300 s), so the app gets a clear answer. */
const DEADLINE_MS = 250_000;

// Plain JSON-schema format, built from the zod schema by the SDK helper. Not the auto-parsing
// helper itself: that parses each text block on its own and throws when a fallback model
// continued the answer in a second block, so the answer is joined and parsed here instead.
const { type: FORMAT_TYPE, schema: FORMAT_SCHEMA } = betaZodOutputFormat(modelReadSchema);

function usageOf(message: Anthropic.Beta.BetaMessage): ReadUsage {
  return {
    model: message.model,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    costUsd: readCostUsd(message.usage as Parameters<typeof readCostUsd>[0], message.model),
  };
}

export async function readPhotos(images: ReadImage[], ctx: ReadContext, signal?: AbortSignal): Promise<ReadResult> {
  if (!photoReadConfigured()) {
    throw new PhotoReadError('AI photo reading needs an Anthropic API key. The owner adds it in Vercel as ANTHROPIC_API_KEY.', 503, 'not_configured');
  }
  // `timeout` covers waiting for the response to start; the deadline below covers the stream.
  const client = new Anthropic({ timeout: 60_000, maxRetries: 1 });
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  images.forEach((img, i) => {
    content.push({ type: 'text', text: `Photo ${i + 1}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
  });
  content.push({ type: 'text', text: readRequestText(ctx, images.length) });

  let message: Anthropic.Beta.BetaMessage;
  try {
    // Streamed so a long think over six photos never hits an HTTP timeout. Effort "high": hazard
    // spotting is worth the extra seconds. If the model declines, the server retries on
    // Anthropic's recommended fallback model within the same call.
    const stream = client.beta.messages.stream(
      {
        model: PHOTO_READ_MODEL,
        max_tokens: 32_000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'high', format: { type: FORMAT_TYPE, schema: FORMAT_SCHEMA } },
        system: PHOTO_READ_SYSTEM,
        messages: [{ role: 'user', content }],
      },
      { signal: abort },
    );
    message = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.APIUserAbortError || (e as Error).name === 'AbortError') {
      if (deadline.aborted) throw new PhotoReadError('The AI took too long. Try again with fewer photos.', 504, 'incomplete');
      throw new PhotoReadError('Stopped.', 499, 'aborted');
    }
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      throw new PhotoReadError("The AI key was rejected. The owner needs to check ANTHROPIC_API_KEY in Vercel.", 503, 'bad_key');
    }
    if (e instanceof Anthropic.RateLimitError) throw new PhotoReadError('The AI is busy right now. Try again in a minute.', 429, 'busy');
    if (e instanceof Anthropic.APIConnectionError) throw new PhotoReadError("Couldn't reach the AI. Check the signal and try again.", 504, 'unreachable');
    if (e instanceof Anthropic.APIError) {
      console.error('[photo-read] API error', e.status, e.message);
      if ((e.status ?? 500) >= 500) throw new PhotoReadError('The AI had a problem. Try again in a minute.', 502, 'busy');
      throw new PhotoReadError("The AI couldn't read these photos. Try again with fewer or smaller photos.", 502, 'failed');
    }
    throw e;
  }

  const usage = usageOf(message);
  if (message.stop_reason === 'refusal') {
    throw new PhotoReadError("The AI wouldn't read these photos. Try clearer photos of just the space.", 422, 'refused', usage);
  }
  if (message.stop_reason === 'max_tokens') {
    throw new PhotoReadError('The AI answer came back incomplete. Try again.', 502, 'incomplete', usage);
  }
  // After a mid-answer fallback the JSON is split across text blocks (the declined start, then
  // the fallback model's continuation); joined in order they make the whole answer.
  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  let parsed;
  try {
    parsed = modelReadSchema.safeParse(JSON.parse(text));
  } catch {
    parsed = null;
  }
  if (!parsed?.success) {
    console.error('[photo-read] unparseable answer', message.stop_reason, text.slice(0, 200));
    throw new PhotoReadError('The AI answer came back incomplete. Try again.', 502, 'incomplete', usage);
  }
  return { read: sanitizeRead(parsed.data), ...usage };
}
