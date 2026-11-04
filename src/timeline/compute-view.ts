/**
 * What the history compute dialog (app/ui/history-compute.ts) says at each step, as plain data,
 * so every state is testable without a page.
 */
import type { ComputeError } from '../repo/compute-history';
import { megabytes, type Estimate } from './estimate';

export type Step =
  /** `refresh`: a stored history exists but the branch has moved since `since`. */
  | { kind: 'offer'; note?: string; refresh?: { since: number } }
  | { kind: 'computing'; progress: number }
  | { kind: 'sharing' }
  | { kind: 'failed'; error: ComputeError };

const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const DATE = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

export type StepView = {
  title: string;
  /** 0 to 1, for a progress bar. */
  progress?: number;
  lines: { text: string; kind?: 'warn' | 'note' | 'fine' | 'progress' }[];
  /** The first is the main one. */
  buttons: { label: string; act: 'start' | 'cancel' | 'close' }[];
};

/** What the dialog shows at a step: plain data, so each state is testable without a DOM. */
export function describeStep(
  step: Step,
  ctx: { name: string; estimate: Estimate; warn: boolean; phone: boolean; signedIn: boolean },
): StepView {
  const { name, estimate, warn, phone, signedIn } = ctx;
  const download = megabytes(estimate.downloadMB);
  switch (step.kind) {
    case 'offer': {
      const { refresh } = step;
      const lines: StepView['lines'] = [
        {
          text: refresh
            ? `It was worked out on ${DATE.format(refresh.since)}, and the branch has moved since. Your browser can bring it up to date from GitHub with your own GitHub requests, ${download} to download, and share it again for everyone who opens ${name}.`
            : `Your browser can work out its history from GitHub with your own GitHub requests, ${download} to download. Once it is done, the timeline is shared, so everyone who opens ${name} gets it at once.`,
        },
      ];
      if (warn) {
        lines.push({
          kind: 'warn',
          text:
            `${estimate.big ? 'This is a big repo.' : 'This looks like a phone or a small device.'} ` +
            `It downloads ${download} and the tab may use ${megabytes(estimate.memoryMB)} of memory while it runs${estimate.big ? ', for a minute or more' : ''}.` +
            (phone ? ' On a phone it can be slow, use mobile data and drain the battery.' : ''),
        });
      }
      if (step.note) lines.push({ kind: 'note', text: step.note });
      lines.push({
        kind: 'fine',
        text: signedIn
          ? 'You are signed in with GitHub in this tab.'
          : 'Sign-in asks GitHub for no permissions, so only public data is read. Your token stays in this tab and goes only to GitHub and the history server.',
      });
      const verb = refresh ? 'refresh' : 'compute';
      const go = warn
        ? signedIn
          ? `${refresh ? 'Refresh' : 'Compute'} anyway`
          : `Sign in and ${verb} anyway`
        : signedIn
          ? refresh
            ? 'Refresh history'
            : 'Compute history'
          : refresh
            ? 'Sign in and refresh'
            : 'Sign in with GitHub';
      return {
        title: refresh ? `The timeline of ${name} is out of date` : `No timeline yet for ${name}`,
        lines,
        buttons: [
          { label: go, act: 'start' },
          { label: refresh ? 'Use this one' : 'Not now', act: 'close' },
        ],
      };
    }
    case 'computing':
      return {
        title: `Working out the history of ${name}`,
        progress: step.progress,
        lines: [
          {
            kind: 'progress',
            text:
              estimate.downloadMB < 1
                ? `${Math.round(step.progress * 100)}% · ${download}`
                : `${Math.round(step.progress * 100)}% · ${Math.round(step.progress * estimate.downloadMB)} MB of ${download}`,
          },
          {
            kind: 'fine',
            text: 'This runs in your browser with your GitHub requests. Cancel stops it; trying again picks up where it stopped.',
          },
        ],
        buttons: [{ label: 'Cancel', act: 'cancel' }],
      };
    case 'sharing':
      return {
        title: `Sharing the history of ${name}`,
        progress: 1,
        lines: [{ kind: 'progress', text: 'Done. Sending it to the history server for everyone…' }],
        buttons: [],
      };
    case 'failed':
      return {
        title: 'The history could not be finished',
        lines: [{ kind: 'note', text: failure(step.error) }],
        buttons: [
          {
            label: step.error.kind === 'unauthorized' ? 'Sign in with GitHub' : 'Try again',
            act: 'start',
          },
          { label: 'Close', act: 'close' },
        ],
      };
  }
}

function failure(error: ComputeError): string {
  switch (error.kind) {
    case 'rate-limited':
      return `GitHub's hourly limit for your account ran out. It resets at ${TIME.format(error.resetAt)}; try again then and it continues where it stopped.`;
    case 'unauthorized':
      return 'GitHub refused your sign-in (it may have expired). Sign in again to continue.';
    case 'not-found':
    case 'empty':
      return 'GitHub has no such repository or branch, or it has no commits.';
    case 'upstream':
      return 'GitHub stopped answering. Try again; it continues where it stopped.';
  }
}
