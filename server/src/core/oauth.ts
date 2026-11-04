/**
 * Sign in with GitHub (OAuth App web flow, no scopes, so public data only).
 *
 * The app opens /v1/auth/login in a popup with its own origin. The server keeps a one-time state
 * for ten minutes and sends the popup to GitHub. GitHub returns to /v1/auth/callback, where the
 * server trades the code for a token with the client secret and hands the token to the opener
 * with postMessage, addressed to the origin recorded with the state. The token never appears in
 * a URL and is not stored here.
 */

import type { Store } from './service';

export type OAuthConfig = {
  clientId: string;
  clientSecret: string;
  /** This server's callback URL, exactly as registered on the OAuth App. */
  callbackUrl: string;
  /** e.g. https://github.com */
  web: string;
  store: Store & { delete(key: string): Promise<void> };
  fetch: typeof fetch;
};

const STATE_TTL_S = 10 * 60;
const stateKey = (state: string) => `oauth:${state}`;

/** The GitHub authorize URL for a popup opened by `origin` (already checked by the host). */
export async function startLogin(origin: string, config: OAuthConfig): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const state = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  await config.store.put(stateKey(state), { origin }, STATE_TTL_S);
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
  if (!state || !/^[0-9a-f]{48}$/.test(state)) return fail(null, 'bad-state');
  const saved = await config.store.get<{ origin: string }>(stateKey(state));
  if (!saved) return fail(null, 'bad-state');
  await config.store.delete(stateKey(state));
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
