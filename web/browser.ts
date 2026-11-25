// Groundwork in the browser: a pre-baked first view, then a Relate WebAssembly worker for everything else.
export { wasmStore } from './wasm-store.js';
export type DemoRepo = { name: string; file: string; eval?: string; issues: number; prs: number; note?: string };

type InstantBundle = {
  generatedAt: string;
  defaultView: { repo: string; q: string; replay: boolean };
  repos: Record<string, unknown>;
  plans: Record<string, unknown>;
};

type WorkerStatus = { text: string; state: 'loading' | 'ready' | 'error' };
type PendingReq = { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> };

const WORKER_TIMEOUT_MS = 60_000;

let instant: InstantBundle | null = null;
let manifest: DemoRepo[] = [];
let worker: Worker | null = null;
let reqId = 0;
let activeRepo = '';
const pending = new Map<number, PendingReq>();
const repoStatus = new Map<string, WorkerStatus>();
let globalStatus: WorkerStatus = { text: 'Instant demo ready · Relate WASM warming up in Web Worker…', state: 'loading' };
let statusCb: (s: string, state?: 'loading' | 'ready' | 'error') => void = () => {};

function emitActiveStatus() {
  const st = (activeRepo && repoStatus.get(activeRepo)) || globalStatus;
  statusCb(st.text, st.state);
}

export function setActiveRepo(repo: string) {
  if (!repo) return;
  activeRepo = repo;
  if (!repoStatus.has(repo) && worker) {
    repoStatus.set(repo, { text: `Instant view ready · loading ${repo} in Relate WASM worker…`, state: 'loading' });
  }
  emitActiveStatus();
}

function failAllPending(reason: string) {
  const err = new Error(reason);
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.reject(err);
  }
  if (worker) {
    try { worker.terminate(); } catch { /* ignore */ }
    worker = null;
  }
  globalStatus = { text: reason, state: 'error' };
  if (activeRepo) repoStatus.set(activeRepo, globalStatus);
  emitActiveStatus();
}

function startWorker(initialRepo?: string) {
  if (worker) return;
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  } catch (e) {
    failAllPending(`WASM worker failed to start: ${(e as Error).message}`);
    return;
  }
  worker.addEventListener('message', (ev: MessageEvent) => {
    const msg = ev.data as { type?: string; id?: number; data?: unknown; text?: string; state?: 'loading' | 'ready' | 'error'; repo?: string };
    if (msg.type === 'status' && msg.text) {
      const st: WorkerStatus = { text: msg.text, state: msg.state ?? 'loading' };
      if (msg.repo) {
        repoStatus.set(msg.repo, st);
        if (msg.repo === activeRepo || !activeRepo) emitActiveStatus();
      } else {
        globalStatus = st;
        if (!activeRepo || !repoStatus.has(activeRepo) || st.state === 'error') emitActiveStatus();
      }
    } else if (msg.type === 'result' && msg.id != null) {
      const entry = pending.get(msg.id);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(msg.id);
        entry.resolve(msg.data);
      }
    }
  });
  worker.addEventListener('error', (err) => {
    const detail = err.message || 'failed to load worker.js';
    failAllPending(`WASM worker error: ${detail}`);
  });
  worker.addEventListener('messageerror', () => {
    failAllPending('WASM worker error: unreadable message from worker');
  });
  worker.postMessage({ type: 'warmup', repo: initialRepo });
}

function askWorker(path: string, timeoutMs = WORKER_TIMEOUT_MS): Promise<unknown> {
  startWorker(activeRepo || undefined);
  if (!worker) return Promise.reject(new Error(globalStatus.text || 'WASM worker unavailable'));
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`WASM worker timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      worker!.postMessage({ type: 'api', id, path });
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e as Error);
    }
  });
}

export function defaultInstantView(): { repo: string; q: string; replay: boolean } | null {
  return instant?.defaultView ?? null;
}

export async function ready(onStatus: (s: string, state?: 'loading' | 'ready' | 'error') => void) {
  statusCb = onStatus;
  // The pre-baked bundle and the manifest are small; load both before the first render.
  const [mRes, iRes] = await Promise.all([
    fetch('data/index.json').then((r) => r.json()).catch(() => []),
    fetch('data/instant.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  manifest = mRes;
  instant = iRes;
  const initialRepo = new URLSearchParams(location.search).get('repo') || manifest[0]?.name || '';
  activeRepo = initialRepo;
  globalStatus = { text: 'Instant demo ready · Relate WASM warming up in Web Worker…', state: 'loading' };
  emitActiveStatus();
  // Start the worker on the next frame so it does not delay the first paint.
  requestAnimationFrame(() => startWorker(initialRepo));
}

export async function api(path: string): Promise<unknown> {
  const url = new URL(path, location.href);
  const p = (k: string) => (url.searchParams.get(k) ?? '').trim();

  if (url.pathname.endsWith('/api/eval')) {
    const repo = p('repo') || manifest[0]?.name;
    const r = manifest.find((x) => x.name === repo);
    return r?.eval ? await (await fetch(r.eval)).json() : null;
  }

  if (url.pathname.endsWith('/api/repos')) {
    const repo = p('repo') || manifest[0]?.name;
    if (repo) setActiveRepo(repo);
    if (instant?.repos?.[repo]) {
      // Let the worker start loading this repo meanwhile.
      worker?.postMessage({ type: 'warmup', repo });
      return instant.repos[repo];
    }
    return askWorker(path);
  }

  if (url.pathname.endsWith('/api/plan')) {
    const repo = p('repo') || manifest[0]?.name;
    const q = p('q');
    const replay = p('replay') === '1' ? '1' : '0';
    const key = `${repo}|${q}|${replay}`;
    if (instant?.plans?.[key]) {
      return instant.plans[key];
    }
    return askWorker(path);
  }

  // Anything not pre-baked runs live in the worker.
  return askWorker(path);
}
