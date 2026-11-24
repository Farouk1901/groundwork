// Groundwork in the browser: instant pre-baked startup (< 200 ms, zero main-thread long tasks)
// backed by a dedicated Relate WebAssembly Web Worker for live free-text queries and full graph access.
export { wasmStore } from './wasm-store.js';
export type DemoRepo = { name: string; file: string; eval?: string; issues: number; prs: number; note?: string };

type InstantBundle = {
  generatedAt: string;
  defaultView: { repo: string; q: string; replay: boolean };
  repos: Record<string, unknown>;
  plans: Record<string, unknown>;
};

let instant: InstantBundle | null = null;
let manifest: DemoRepo[] = [];
let worker: Worker | null = null;
let reqId = 0;
const pending = new Map<number, (data: unknown) => void>();
let statusCb: (s: string, state?: 'loading' | 'ready' | 'error') => void = () => {};

function startWorker(initialRepo?: string) {
  if (worker) return;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (ev: MessageEvent) => {
    const msg = ev.data as { type?: string; id?: number; data?: unknown; text?: string; state?: 'loading' | 'ready' | 'error' };
    if (msg.type === 'status' && msg.text) {
      statusCb(msg.text, msg.state ?? 'loading');
    } else if (msg.type === 'result' && msg.id != null) {
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg.data);
      }
    }
  });
  worker.addEventListener('error', (err) => {
    statusCb(`WASM worker error: ${err.message}`, 'error');
  });
  worker.postMessage({ type: 'warmup', repo: initialRepo });
}

function askWorker(path: string): Promise<unknown> {
  startWorker();
  const id = ++reqId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker!.postMessage({ type: 'api', id, path });
  });
}

export function defaultInstantView(): { repo: string; q: string; replay: boolean } | null {
  return instant?.defaultView ?? null;
}

export async function ready(onStatus: (s: string, state?: 'loading' | 'ready' | 'error') => void) {
  statusCb = onStatus;
  // Fetch the tiny pre-baked bundle + repo manifest in parallel so first render completes in < 200 ms.
  const [mRes, iRes] = await Promise.all([
    fetch('data/index.json').then((r) => r.json()).catch(() => []),
    fetch('data/instant.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  manifest = mRes;
  instant = iRes;
  const initialRepo = new URLSearchParams(location.search).get('repo') || manifest[0]?.name;
  onStatus('Instant demo ready · Relate WASM warming up in Web Worker…', 'loading');
  // Boot the Relate WASM Web Worker on the next frame so initial paint stays completely unblocked.
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
    if (instant?.repos?.[repo]) {
      // Also trigger background preload for the chosen repo in the worker.
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

  // Free-text queries, non-cached tickets, and /api/check execute live in the Relate WASM Web Worker.
  return askWorker(path);
}
