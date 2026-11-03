import type { RepoRef } from '../repo/ref';
import type { AppError } from './state';

export type ErrorAction = 'token' | 'retry' | 'settings';
export type ErrorCopy = { title: string; body: string; actions: ErrorAction[] };

const name = (ref: RepoRef) => `${ref.owner}/${ref.repo}${ref.ref ? ` (${ref.ref})` : ''}`;
const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function describeError(error: AppError, ref: RepoRef, hasToken: boolean): ErrorCopy {
  switch (error.kind) {
    case 'not-found':
      return {
        title: `Can’t find ${name(ref)}`,
        body: hasToken
          ? 'Check the owner, name and branch. Your token may not have access to this repository.'
          : 'Check the owner, name and branch. If it is private, add a GitHub token in Settings.',
        actions: hasToken ? ['retry'] : ['token'],
      };
    case 'rate-limited':
      return {
        title: 'GitHub’s rate limit is used up',
        body: `It resets at ${time(error.resetAt)}. ${
          hasToken
            ? 'Your token’s hourly limit is used up too.'
            : 'A GitHub token raises the limit from 60 to 5,000 requests an hour.'
        }`,
        actions: hasToken ? ['retry'] : ['token', 'retry'],
      };
    case 'unauthorized':
      return {
        title: 'GitHub rejected your token',
        body: 'The token in Settings is invalid or expired. Replace it, or remove it to browse public repositories.',
        actions: ['token'],
      };
    case 'network':
      return navigator.onLine
        ? {
            title: 'Can’t reach GitHub',
            body: 'The request failed or returned something unexpected. Check your connection and try again.',
            actions: ['retry'],
          }
        : {
            title: 'You’re offline',
            body: 'Connect to the internet and try again. The bundled samples still work offline.',
            actions: ['retry'],
          };
    case 'empty':
      return {
        title: `Nothing to grow in ${name(ref)}`,
        body: 'The repository has no files, or every folder in it is hidden in Settings.',
        actions: ['settings'],
      };
    case 'unexpected':
      return {
        title: 'The tree could not be grown',
        body: 'Something went wrong while building it. Try again, or try another repository.',
        actions: ['retry'],
      };
  }
}
