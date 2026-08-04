// pathform - accept a file path in EITHER form and return one that opens. Node twin of
// scripts/pathform.py; see that file for the full incident record.
//
// Bash on this box takes /c/Users/..., node on Windows takes C:/Users/.... Node resolves
// a bare /tmp to C:\tmp, which is NOT where MSYS bash wrote it. THREE INSTANCES IN
// NINETY MINUTES, TWO AGENTS. The 00:06Z one cost 3,991 characters of a task
// description: node ENOENT'd on a heredoc file, `cat` printed nothing, and the empty
// string reached a CLI that accepted it as content.
//
//   import { resolve } from './pathform.mjs';
//   readFileSync(resolve(p), 'utf8');
//
//   node scripts/pathform.mjs --self-test
import { existsSync, statSync } from 'node:fs';

export function forms(p) {
  p = String(p);
  const out = [p];
  const msys = /^\/([A-Za-z])\/(.*)$/.exec(p);
  if (msys) out.push(`${msys[1].toUpperCase()}:/${msys[2]}`);
  const win = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (win) out.push(`/${win[1].toLowerCase()}/${win[2].replace(/\\/g, '/')}`);
  if (p.includes('\\')) out.push(p.replace(/\\/g, '/'));
  return [...new Set(out)];
}

// RAISES ON A GENUINELY ABSENT PATH — the negative case is the point. A helper that only
// ever succeeds fixes the false negative by making a real missing file INVISIBLE, which
// is strictly worse than the bug, and it passes every positive test. The message names
// every form tried, because a throw that hides what it looked for is no better than the
// ENOENT it replaces.
export function resolve(p, { mustExist = true } = {}) {
  const tried = forms(p);
  for (const c of tried) if (existsSync(c)) return c;
  if (!mustExist) return tried[0];
  throw new Error(`no form of ${JSON.stringify(p)} exists; tried: ${tried.join(', ')}`);
}

if (process.argv.includes('--self-test')) {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'pathform-'));
  const win = join(dir, 'probe.txt').replace(/\\/g, '/');
  writeFileSync(win, 'ok', 'utf8');
  const m = /^([A-Za-z]):\/(.*)$/.exec(win);
  const msys = `/${m[1].toLowerCase()}/${m[2]}`;
  const { readFileSync } = await import('node:fs');
  const cases = [
    // THE MSYS CASE IS THE ONE THAT FAILS TODAY. A test using only the Windows form
    // proves nothing — that is exactly how this survived three occurrences.
    ['windows form opens', () => readFileSync(resolve(win), 'utf8') === 'ok'],
    ['MSYS form opens', () => readFileSync(resolve(msys), 'utf8') === 'ok'],
    ['backslash form opens', () => readFileSync(resolve(win.replace(/\//g, '\\')), 'utf8') === 'ok'],
    ['both forms resolve to the SAME inode', () =>
      statSync(resolve(win)).ino === statSync(resolve(msys)).ino],
    // NEGATIVE. Without it the helper could return its input unchanged, pass everything
    // above, and turn a real missing file into a silent success.
    ['a genuinely absent path still THROWS', () => {
      try { resolve('/c/Users/definitely-not-here-4a7f/x.txt'); return false; }
      catch { return true; }
    }],
    ['the throw NAMES the forms it tried', () => {
      try { resolve('/c/Users/definitely-not-here-4a7f/x.txt'); return false; }
      catch (e) { return e.message.includes('C:/Users/definitely-not-here-4a7f/x.txt'); }
    }],
    ['mustExist:false returns rather than throwing', () =>
      resolve('/c/no/such', { mustExist: false }) === '/c/no/such'],
  ];
  let failed = 0;
  for (const [name, fn] of cases) {
    let ok = false;
    try { ok = fn() === true; } catch { ok = false; }
    if (!ok) failed += 1;
    console.log((ok ? 'ok   ' : 'FAIL ') + name);
  }
  rmSync(dir, { recursive: true, force: true });
  console.log('');
  console.log(`pathform.mjs --self-test: ${cases.length - failed}/${cases.length}`);
  console.log('BOUNDARY: proves both forms open FROM NODE. The python twin covers the');
  console.log('other language; the four-combination claim needs BOTH run.');
  process.exit(failed === 0 ? 0 : 2);
}
