import { createHmac } from 'node:crypto';
export const SECRET = 'e2e-super-secret-jwt-token-with-at-least-32-characters';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export function sign(payload) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 * 30, ...payload });
  const s = createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}
export function verify(token) {
  const [h, p, s] = token.split('.');
  const exp = createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
  if (exp !== s) return null;
  return JSON.parse(Buffer.from(p, 'base64url').toString());
}
export const ANON = sign({ role: 'anon' });
export const SERVICE = sign({ role: 'service_role' });
