import { signIn, signOut, signedInToken } from '../../repo/auth';
import type { History } from '../../repo/history';
import { describeStep, type Step } from '../../timeline/compute-view';
import { constrainedDevice, estimateCompute, type Estimate } from '../../timeline/estimate';
import type { HistorySource } from '../../timeline/source';
import type { App } from '../app';
import { debug } from '../debug';
import { byId, fill, h } from '../dom';
import type { Repo } from '../state';

/**
 * The offer to compute a missing history in the visitor's browser, and its progress. The
 * history is then shared through the history server, so the next visitor gets it at once.
 * A big job (Linux-sized) or a small device gets a warning with the estimate first.
 */
export function mountHistoryCompute(
  app: App,
  {
    constrained = constrainedDevice,
    sign = signIn,
  }: { constrained?: () => boolean; sign?: () => Promise<string | null> } = {},
): {
  /**
   * Shows the offer for a repo whose history is missing, or (with `refresh`) out of date;
   * resolves with the new history once computed, or null when the visitor declined or cancelled.
   */
  offer(
    repo: Repo,
    source: HistorySource,
    options?: { refresh?: History },
  ): Promise<History | null>;
  close(): boolean;
} {
  const dialog = byId('compute');
  const scrim = byId('compute-scrim');
  let current: {
    repo: Repo;
    source: HistorySource;
    estimate: Estimate;
    warn: boolean;
    refresh?: { since: number };
    abort: AbortController | null;
    done: (history: History | null) => void;
  } | null = null;

  const name = (repo: Repo) => `${repo.info.ref.owner}/${repo.info.ref.repo}`;

  const render = (step: Step) => {
    if (!current) return;
    const { repo, estimate, warn } = current;
    debug.compute = step.kind;
    dialog.dataset.step = step.kind;
    const v = describeStep(step, {
      name: name(repo),
      estimate,
      warn,
      phone: constrained(),
      signedIn: signedInToken() !== null,
    });
    const act = { start: () => void start(), cancel, close: () => finish(null) };
    fill(
      dialog,
      h('h2', { id: 'compute-title' }, v.title),
      v.progress !== undefined &&
        h('progress', {
          max: 100,
          value: Math.round(v.progress * 100),
          'aria-labelledby': 'compute-title',
        }),
      ...v.lines.map((line) =>
        h(
          'p',
          {
            class: line.kind ? `compute-${line.kind}` : null,
            role: line.kind === 'note' ? 'alert' : null,
            'aria-live': line.kind === 'progress' ? 'polite' : null,
          },
          line.text,
        ),
      ),
      v.buttons.length > 0 &&
        h(
          'div',
          { class: 'compute-actions' },
          ...v.buttons.map((b, i) =>
            h(
              'button',
              {
                type: 'button',
                class: i === 0 && b.act !== 'cancel' ? 'btn dark' : 'btn',
                'data-act': b.act,
                onclick: act[b.act],
              },
              b.label,
            ),
          ),
        ),
    );
    dialog.querySelector<HTMLButtonElement>('.compute-actions button')?.focus();
  };

  async function start() {
    if (!current || current.abort) return;
    let token = signedInToken();
    if (!token) {
      token = await sign();
      if (!current) return;
      if (!token) {
        const note = 'Sign-in did not finish. Try again?';
        return render(
          current.refresh
            ? { kind: 'offer', note, refresh: current.refresh }
            : { kind: 'offer', note },
        );
      }
    }
    const abort = new AbortController();
    current.abort = abort;
    render({ kind: 'computing', progress: 0 });
    try {
      const outcome = await current.source.compute!({
        token,
        signal: abort.signal,
        onProgress: (progress) => {
          if (current?.abort === abort && progress < 1) render({ kind: 'computing', progress });
          else if (current?.abort === abort) render({ kind: 'sharing' });
        },
      });
      if (current?.abort !== abort) return;
      current.abort = null;
      if (outcome.status === 'error') {
        if (outcome.error.kind === 'unauthorized') signOut();
        return render({ kind: 'failed', error: outcome.error });
      }
      if (outcome.shared === 'unauthorized') {
        // GitHub refused the token when the server checked it: sign in afresh next time.
        signOut();
        app.toast('Timeline ready here, but your sign-in expired, so it was not shared');
      } else if (outcome.shared !== 'stored' && outcome.shared !== 'exists') {
        app.toast('Timeline ready here, but it could not be shared');
      }
      finish(outcome.history);
    } catch {
      // Aborted: cancel already closed the dialog.
    }
  }

  function cancel() {
    current?.abort?.abort();
    finish(null);
  }

  function finish(history: History | null) {
    const was = current;
    current = null;
    dialog.hidden = true;
    scrim.hidden = true;
    debug.compute = null;
    was?.done(history);
  }

  scrim.addEventListener('click', () => {
    if (current && !current.abort) finish(null);
  });

  return {
    offer(repo, source, options = {}) {
      if (current) cancel();
      return new Promise((done) => {
        const estimate = estimateCompute(
          repo.index.files.paths.length + repo.index.folders.parent.length,
        );
        const refresh = options.refresh ? { since: options.refresh.computedAt } : undefined;
        current = {
          repo,
          source,
          estimate,
          warn: estimate.big || constrained(),
          ...(refresh ? { refresh } : {}),
          abort: null,
          done,
        };
        dialog.hidden = false;
        scrim.hidden = false;
        render(refresh ? { kind: 'offer', refresh } : { kind: 'offer' });
      });
    },
    close() {
      if (!current) return false;
      cancel();
      return true;
    },
  };
}
