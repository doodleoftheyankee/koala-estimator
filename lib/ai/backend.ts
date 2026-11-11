// Which service answers AI photo reads. Pure: reads an env object, so it can be tested.
//
// 1. ANTHROPIC_API_KEY set → Anthropic's API directly (claude-opus-5-5), with server-side
//    refusal fallback.
// 2. Otherwise, Vercel AI Gateway (anthropic/claude-opus-5.5), authenticated with
//    AI_GATEWAY_API_KEY or, on Vercel, the deployment's own OIDC token. No separate account or key:
//    usage is billed to the Vercel team's AI Gateway credits. The gateway fails over between
//    Claude providers itself.

export const GATEWAY_URL = 'https://ai-gateway.vercel.sh';

export type AiBackend =
  | { kind: 'anthropic'; model: string }
  | { kind: 'gateway'; model: string; baseURL: string; auth: 'key' | 'oidc' };

type Env = Record<string, string | undefined>;

export function pickBackend(env: Env): AiBackend | null {
  if (env.ANTHROPIC_API_KEY) return { kind: 'anthropic', model: 'claude-opus-5-5' };
  const baseURL = (env.AI_GATEWAY_URL || GATEWAY_URL).replace(/\/$/, '');
  if (env.AI_GATEWAY_API_KEY) return { kind: 'gateway', model: 'anthropic/claude-opus-5.5', baseURL, auth: 'key' };
  if (env.VERCEL === '1' || env.VERCEL_OIDC_TOKEN) return { kind: 'gateway', model: 'anthropic/claude-opus-5.5', baseURL, auth: 'oidc' };
  return null;
}

/** Anthropic's id for a model, whichever service named it: "anthropic/claude-opus-5.5" → "claude-opus-5-5". */
export function canonicalModel(id: string): string {
  return id.replace(/^anthropic\//, '').replace(/\./g, '-');
}
