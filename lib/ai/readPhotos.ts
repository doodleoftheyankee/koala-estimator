import 'server-only';
// The model call behind AI photo reading. One request: the area's photos (numbered), what the
// estimator has entered, and a structured-output schema, so the answer is JSON of a known shape.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { getVercelOidcToken } from '@vercel/oidc';
import { modelReadSchema, PHOTO_READ_SYSTEM, readCostUsd, readRequestText, sanitizeRead, type PhotoRead, type ReadContext } from './photoRead';
import { canonicalModel, pickBackend, type AiBackend } from './backend';

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
    readonly code: 'not_configured' | 'bad_key' | 'no_credit' | 'refused' | 'incomplete' | 'busy' | 'unreachable' | 'aborted' | 'failed',
    readonly usage: ReadUsage | null = null,
  ) {
    super(message);
  }
}

export function photoReadConfigured(): boolean {
  return pickBackend(process.env) !== null;
}

/** Which service reads photos here ("anthropic" or "gateway"), or null when none is set up. */
export function photoReadBackend(): AiBackend['kind'] | null {
  return pickBackend(process.env)?.kind ?? null;
}

async function clientFor(backend: AiBackend): Promise<Anthropic> {
  // `timeout` covers waiting for the response to start; the deadline in readPhotos covers the stream.
  if (backend.kind === 'anthropic') return new Anthropic({ timeout: 60_000, maxRetries: 1 });
  const apiKey = backend.auth === 'key' ? process.env.AI_GATEWAY_API_KEY! : await getVercelOidcToken().catch(() => process.env.VERCEL_OIDC_TOKEN ?? '');
  if (!apiKey) throw new PhotoReadError("AI photo reading couldn't sign in to the Vercel AI Gateway. Check that OIDC is enabled for the project.", 503, 'not_configured');
  return new Anthropic({ apiKey, baseURL: backend.baseURL, timeout: 60_000, maxRetries: 1 });
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

function usageOf(message: Anthropic.Beta.BetaMessage | Anthropic.Message): ReadUsage {
  const model = canonicalModel(message.model);
  return {
    model,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    costUsd: readCostUsd(message.usage as Parameters<typeof readCostUsd>[0], model),
  };
}

export async function readPhotos(images: ReadImage[], ctx: ReadContext, signal?: AbortSignal): Promise<ReadResult> {
  const backend = pickBackend(process.env);
  if (!backend) {
    throw new PhotoReadError('AI photo reading needs an Anthropic API key or the Vercel AI Gateway. The owner sets it up in Vercel.', 503, 'not_configured');
  }
  const client = await clientFor(backend);
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  images.forEach((img, i) => {
    content.push({ type: 'text', text: `Photo ${i + 1}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
  });
  content.push({ type: 'text', text: readRequestText(ctx, images.length) });
  const format = { type: FORMAT_TYPE, schema: FORMAT_SCHEMA };

  let message: Anthropic.Beta.BetaMessage | Anthropic.Message;
  try {
    // Streamed so a long think over six photos never hits an HTTP timeout. Effort "high": hazard
    // spotting is worth the extra seconds. Direct to Anthropic, a declined request is retried on
    // Anthropic's recommended fallback model in the same call; the AI Gateway fails over between
    // Claude providers on its own and takes the standard request shape.
    if (backend.kind === 'anthropic') {
      message = await client.beta.messages
        .stream(
          {
            model: backend.model,
            max_tokens: 32_000,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            output_config: { effort: 'high', format },
            system: PHOTO_READ_SYSTEM,
            messages: [{ role: 'user', content }],
          },
          { signal: abort },
        )
        .finalMessage();
    } else {
      message = await client.messages
        .stream(
          {
            model: backend.model,
            max_tokens: 32_000,
            output_config: { effort: 'high', format },
            system: PHOTO_READ_SYSTEM,
            messages: [{ role: 'user', content: content as Anthropic.ContentBlockParam[] }],
          },
          { signal: abort },
        )
        .finalMessage();
    }
  } catch (e) {
    if (e instanceof PhotoReadError) throw e;
    if (e instanceof Anthropic.APIUserAbortError || (e as Error).name === 'AbortError') {
      if (deadline.aborted) throw new PhotoReadError('The AI took too long. Try again with fewer photos.', 504, 'incomplete');
      throw new PhotoReadError('Stopped.', 499, 'aborted');
    }
    if (e instanceof Anthropic.APIError) console.error('[photo-read] API error', backend.kind, e.status, e.message);
    const outOfCredit = e instanceof Anthropic.APIError && (e.status === 402 || /credit|insufficient|balance|quota/i.test(e.message));
    if (backend.kind === 'gateway' && outOfCredit) {
      throw new PhotoReadError('The Vercel AI Gateway is out of credit. The owner adds credit in Vercel (AI Gateway → Credits).', 503, 'no_credit');
    }
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      throw new PhotoReadError(
        backend.kind === 'gateway'
          ? 'The Vercel AI Gateway refused the request. The owner checks AI Gateway in Vercel.'
          : 'The AI key was rejected. The owner needs to check ANTHROPIC_API_KEY in Vercel.',
        503,
        'bad_key',
      );
    }
    if (e instanceof Anthropic.RateLimitError) throw new PhotoReadError('The AI is busy right now. Try again in a minute.', 429, 'busy');
    if (e instanceof Anthropic.APIConnectionError) throw new PhotoReadError("Couldn't reach the AI. Check the signal and try again.", 504, 'unreachable');
    if (e instanceof Anthropic.APIError) {
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
