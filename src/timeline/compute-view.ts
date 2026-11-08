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
  /** Shows the corner X, which declines or dismisses. Off while work runs: Cancel stops it. */
  closable: boolean;
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
      // Short on purpose: what it costs, that it is shared, and on a phone or a big repo, a
      // one-line warning. The details live in the feature docs, not the dialog.
      const { refresh } = step;
      const lines: StepView['lines'] = [
        {
          text: refresh
            ? `Last worked out ${DATE.format(refresh.since)}; the branch has moved since. Your browser can add the new commits (${download}) and share it again for everyone.`
            : `Your browser can work it out from GitHub (${download}), then share it so everyone who opens ${name} gets it.`,
        },
      ];
      if (warn) {
        const memory = megabytes(estimate.memoryMB);
        lines.push({
          kind: 'warn',
          text: estimate.big
            ? `A big repo: ${download} to download and ${memory} of memory, for a minute or more.`
            : `${phone ? 'On a phone' : 'On a small device'} this can be slow: ${download} to download and ${memory} of memory.`,
        });
      }
      if (step.note) lines.push({ kind: 'note', text: step.note });
      if (!signedIn)
        lines.push({
          kind: 'fine',
          text: 'Sign-in asks GitHub for no permissions, and your token stays in this tab.',
        });
      const go = signedIn
        ? warn
          ? `${refresh ? 'Refresh' : 'Compute'} anyway`
          : refresh
            ? 'Refresh history'
            : 'Compute history'
        : refresh
          ? 'Sign in and refresh'
          : warn
            ? 'Sign in and compute'
            : 'Sign in with GitHub';
      return {
        title: refresh ? `The timeline of ${name} is out of date` : `No timeline yet for ${name}`,
        lines,
        buttons: [
          { label: go, act: 'start' },
          // A stale history is still a timeline: keeping it is a choice, not a dismissal.
          ...(refresh ? [{ label: 'Use this one', act: 'close' as const }] : []),
        ],
        closable: true,
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
            text: 'Cancel stops it; trying again picks up where it stopped.',
          },
        ],
        buttons: [{ label: 'Cancel', act: 'cancel' }],
        closable: false,
      };
    case 'sharing':
      return {
        title: `Sharing the history of ${name}`,
        progress: 1,
        lines: [{ kind: 'progress', text: 'Done. Sending it to the history server for everyone…' }],
        buttons: [],
        closable: false,
      };
    case 'failed':
      return {
        title: 'The history could not be finished',
        lines: [{ kind: 'note', text: failure(step.error) }],
        buttons: [
          ...(step.error.kind === 'not-default-branch'
            ? []
            : [
                {
                  label: step.error.kind === 'unauthorized' ? 'Sign in with GitHub' : 'Try again',
                  act: 'start' as const,
                },
              ]),
        ],
        closable: true,
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
    case 'not-default-branch':
      return `Histories are kept for each repo's default branch, ${error.defaultBranch}. Open the repo on ${error.defaultBranch} to see its timeline.`;
  }
}
