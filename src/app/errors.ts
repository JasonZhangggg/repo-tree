import type { RepoRef } from '../repo/ref';
import type { AppError } from './state';

export type ErrorAction = 'signin' | 'token' | 'retry' | 'settings';
export type ErrorCopy = { title: string; body: string; actions: ErrorAction[] };

const name = (ref: RepoRef) => `${ref.owner}/${ref.repo}${ref.ref ? ` (${ref.ref})` : ''}`;
const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * `hasToken`: a token was sent (pasted in Settings, or signed in). `signedIn`: it was the sign-in
 * one. `canSignIn`: this build has the history server, which signs visitors in with GitHub.
 */
export function describeError(
  error: AppError,
  ref: RepoRef,
  {
    hasToken,
    signedIn = false,
    canSignIn = false,
  }: { hasToken: boolean; signedIn?: boolean; canSignIn?: boolean },
): ErrorCopy {
  switch (error.kind) {
    case 'not-found':
      return {
        title: `Can’t find ${name(ref)}`,
        body: hasToken
          ? 'Check the name and branch. Your token may lack access.'
          : 'Check the name and branch. Private? Add a GitHub token.',
        actions: hasToken ? ['retry'] : ['token'],
      };
    case 'rate-limited':
      return {
        title: 'GitHub’s rate limit is used up',
        body: `It resets at ${time(error.resetAt)}. ${
          hasToken
            ? 'Your token’s hourly limit is used up too.'
            : canSignIn
              ? 'Signing in with GitHub raises it from 60 to 5,000 an hour.'
              : 'A GitHub token raises it from 60 to 5,000 an hour.'
        }`,
        actions: hasToken ? ['retry'] : canSignIn ? ['signin', 'retry'] : ['token', 'retry'],
      };
    case 'unauthorized':
      if (signedIn) {
        return {
          title: 'Your GitHub sign-in expired',
          body: 'Sign in again, or carry on signed out for public repos.',
          actions: ['signin', 'retry'],
        };
      }
      return {
        title: 'GitHub rejected your token',
        body: 'It’s invalid or expired. Replace it, or remove it for public repos.',
        actions: ['token'],
      };
    case 'network':
      return navigator.onLine
        ? {
            title: 'Can’t reach GitHub',
            body: `${name(ref)} didn’t load. Check your connection and try again.`,
            actions: ['retry'],
          }
        : {
            title: 'You’re offline',
            body: `${name(ref)} needs a connection. The bundled samples still work.`,
            actions: ['retry'],
          };
    case 'empty':
      return {
        title: `Nothing to grow in ${name(ref)}`,
        body: 'It has no files, or Settings hides every folder.',
        actions: ['settings'],
      };
    case 'unexpected':
      return {
        title: `${name(ref)} could not be grown`,
        body: 'Something went wrong. Try again, or another repo.',
        actions: ['retry'],
      };
  }
}
