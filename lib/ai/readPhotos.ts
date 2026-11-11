import 'server-only';
// The model call behind AI photo reading. One request: the area's photos (numbered), what the
// estimator has entered, and a structured-output schema, so the answer always parses.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { modelReadSchema, PHOTO_READ_MODEL, PHOTO_READ_SYSTEM, readCostUsd, readRequestText, sanitizeRead, type PhotoRead, type ReadContext } from './photoRead';

export type ReadImage = { mediaType: 'image/jpeg' | 'image/png' | 'image/webp'; base64: string };

/** A failure the field app can show as-is. `code` lets the app tell "not set up" from "try again". */
export class PhotoReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: 'not_configured' | 'refused' | 'incomplete' | 'busy' | 'unreachable' | 'failed',
  ) {
    super(message);
  }
}

export function photoReadConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export interface ReadResult {
  read: PhotoRead;
  /** The model that answered (the fallback model when the first one declined). */
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export async function readPhotos(images: ReadImage[], ctx: ReadContext): Promise<ReadResult> {
  if (!photoReadConfigured()) {
    throw new PhotoReadError('AI photo reading needs an Anthropic API key. The owner adds it in Vercel as ANTHROPIC_API_KEY.', 503, 'not_configured');
  }
  const client = new Anthropic({ timeout: 240_000, maxRetries: 1 });

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  images.forEach((img, i) => {
    content.push({ type: 'text', text: `Photo ${i + 1}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
  });
  content.push({ type: 'text', text: readRequestText(ctx, images.length) });

  let message;
  try {
    // Streamed so a long think over six photos never hits an HTTP timeout; finalMessage() parses
    // the structured output. Effort "high": hazard spotting is worth the extra seconds. If the
    // model declines, the server retries once on Anthropic's recommended fallback model.
    const stream = client.beta.messages.stream({
      model: PHOTO_READ_MODEL,
      max_tokens: 64_000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'high', format: betaZodOutputFormat(modelReadSchema) },
      system: PHOTO_READ_SYSTEM,
      messages: [{ role: 'user', content }],
    });
    message = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      throw new PhotoReadError("The AI key isn't working. The owner needs to check ANTHROPIC_API_KEY in Vercel.", 503, 'not_configured');
    }
    if (e instanceof Anthropic.RateLimitError) throw new PhotoReadError('The AI is busy right now. Try again in a minute.', 429, 'busy');
    if (e instanceof Anthropic.APIConnectionError) throw new PhotoReadError("Couldn't reach the AI. Check the signal and try again.", 504, 'unreachable');
    if (e instanceof Anthropic.APIError) {
      console.error('[photo-read] API error', e.status, e.message);
      if ((e.status ?? 500) >= 500) throw new PhotoReadError('The AI had a problem. Try again in a minute.', 502, 'busy');
      throw new PhotoReadError(`The AI couldn't read these photos (${e.message}).`, 502, 'failed');
    }
    throw e;
  }

  if (message.stop_reason === 'refusal') {
    throw new PhotoReadError("The AI wouldn't read these photos. Try clearer photos of just the space.", 422, 'refused');
  }
  if (message.stop_reason === 'max_tokens' || !message.parsed_output) {
    throw new PhotoReadError('The AI answer came back incomplete. Try again.', 502, 'incomplete');
  }
  return {
    read: sanitizeRead(message.parsed_output),
    model: message.model,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    costUsd: readCostUsd(message.usage),
  };
}
