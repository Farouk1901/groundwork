import { execFileSync } from 'node:child_process';

/** Files changed in a local clone: staged, against a base branch, or the working tree plus untracked files. */
export function gitChangedFiles(opts: { cwd?: string; staged?: boolean; base?: string } = {}): string[] {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: opts.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\n').map((x) => x.trim()).filter(Boolean);
  if (opts.staged) return git('diff', '--cached', '--name-only');
  const out = new Set<string>();
  if (opts.base) for (const f of git('diff', '--name-only', `${opts.base}...HEAD`)) out.add(f);
  for (const f of git('diff', '--name-only', 'HEAD')) out.add(f);
  for (const f of git('ls-files', '--others', '--exclude-standard')) out.add(f);
  return [...out];
}
