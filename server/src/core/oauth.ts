/**
 * Sign in with GitHub (OAuth App web flow, no scopes, so public data only).
 *
 * The app opens /v1/auth/login in a popup with its own origin. The server signs that origin and
 * a ten-minute expiry into the state (HMAC-SHA-256 under the client secret, so a sign-in costs
 * no KV write) and sends the popup to GitHub. GitHub returns to /v1/auth/callback, where the
 * server checks the state, trades the code for a token with the client secret and hands the
 * token to the opener with postMessage, addressed to the origin signed into the state. The token
 * never appears in a URL and is not stored here. A state can be replayed within its ten
 * minutes, but GitHub's code is single use and the token only ever goes to the signed origin.
 */

export type OAuthConfig = {
  clientId: string;
  clientSecret: string;
  /** This server's callback URL, exactly as registered on the OAuth App. */
  callbackUrl: string;
  /** e.g. https://github.com */
  web: string;
  fetch: typeof fetch;
  now?: () => number;
};

const STATE_TTL_MS = 10 * 60 * 1000;

/** The GitHub authorize URL for a popup opened by `origin` (already checked by the host). */
export async function startLogin(origin: string, config: OAuthConfig): Promise<string> {
  const nonce = hex(crypto.getRandomValues(new Uint8Array(12)));
  const expires = (config.now ?? Date.now)() + STATE_TTL_MS;
  const payload = base64url(JSON.stringify({ o: origin, e: expires, n: nonce }));
  const state = `${payload}.${await sign(payload, config.clientSecret)}`;
  const url = new URL('/login/oauth/authorize', config.web);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.callbackUrl);
  url.searchParams.set('state', state);
  return url.href;
}

export type AuthMessage =
  { type: 'repo-tree-auth'; token: string } | { type: 'repo-tree-auth'; error: string };

/** The message for the opener and the origin to address it to (null when the state is unknown). */
export async function finishLogin(
  code: string | null,
  state: string | null,
  config: OAuthConfig,
): Promise<{ origin: string | null; message: AuthMessage }> {
  const fail = (origin: string | null, error: string) => ({
    origin,
    message: { type: 'repo-tree-auth', error } as AuthMessage,
  });
  const saved = state ? await openState(state, config) : null;
  if (!saved) return fail(null, 'bad-state');
  if (!code) return fail(saved.origin, 'denied');
  try {
    const res = await config.fetch(new URL('/login/oauth/access_token', config.web).href, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.callbackUrl,
      }),
    });
    const body = (await res.json()) as { access_token?: unknown };
    if (typeof body.access_token !== 'string') return fail(saved.origin, 'exchange-failed');
    return { origin: saved.origin, message: { type: 'repo-tree-auth', token: body.access_token } };
  } catch {
    return fail(saved.origin, 'exchange-failed');
  }
}

/** A page that posts the message to its opener at `origin`, then closes. */
export function callbackPage(origin: string | null, message: AuthMessage): string {
  const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
  const post = origin
    ? `if (window.opener) window.opener.postMessage(${json(message)}, ${json(origin)});`
    : '';
  return `<!doctype html><meta charset="utf-8"><title>Repo Tree sign-in</title>
<p>${origin ? 'You can close this window.' : 'This sign-in link expired. Close this window and try again.'}</p>
<script>${post} window.close();</script>`;
}

/** The origin signed into a state, or null when it is forged, malformed or expired. */
async function openState(state: string, config: OAuthConfig): Promise<{ origin: string } | null> {
  const match = /^([A-Za-z0-9_-]{1,2048})\.([0-9a-f]{64})$/.exec(state);
  if (!match) return null;
  const [, payload = '', mac = ''] = match;
  if (!equal(mac, await sign(payload, config.clientSecret))) return null;
  try {
    const { o, e } = JSON.parse(unbase64url(payload)) as { o?: unknown; e?: unknown };
    if (typeof o !== 'string' || typeof e !== 'number') return null;
    return e > (config.now ?? Date.now)() ? { origin: o } : null;
  } catch {
    return null;
  }
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))),
  );
}

/** Compares in time independent of where they differ. */
function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const base64url = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const unbase64url = (text: string) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
  );
