/**
 * tests/unit/scripts/option-parity.test.ts
 *
 * The hazard-13 checker: option keys a library declares that no caller ever passes.
 *
 * Driven through the real script against FIXTURE source trees rather than by importing internals,
 * because the thing that can break is the whole pipeline — parse, collect, diff, exit code — and a
 * unit test of a helper would not have caught the two ways this actually went wrong while I built
 * it (scanning the wrong set, and treating a spread as passing nothing).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const SCRIPT = join(process.cwd(), 'scripts', 'check-option-parity.mjs');

describe('check-option-parity', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'optparity-'));
    mkdirSync(join(tmp, 'scripts'), { recursive: true });
    mkdirSync(join(tmp, 'src', 'bus'), { recursive: true });
    mkdirSync(join(tmp, 'src', 'cli'), { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function lib(body: string): void {
    writeFileSync(join(tmp, 'src', 'bus', 'lib.ts'), body, 'utf-8');
  }
  function caller(body: string): void {
    writeFileSync(join(tmp, 'src', 'cli', 'app.ts'), body, 'utf-8');
  }

  /** Returns { code, out }. Never throws on a non-zero exit — the exit code IS the result here. */
  function run(): { code: number; out: string } {
    try {
      // Run the REAL script, pointed at the fixture tree. Copying it into the fixture would break
      // `typescript` resolution, and a checker that can only examine its own repo is untestable.
      const out = execFileSync(process.execPath, [SCRIPT, tmp], { encoding: 'utf-8' });
      return { code: 0, out };
    } catch (e: any) {
      return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  }

  const DECL = `export function doThing(a: string, options: { alpha?: string; beta?: string } = {}) { return a + options.alpha + options.beta; }`;

  it('FINDS a declared key that no caller passes — the due_date shape', () => {
    lib(DECL);
    caller(`import { doThing } from '../bus/lib.js';\ndoThing('x', { alpha: 'v' });`);
    const { code, out } = run();
    expect(code).toBe(2);
    expect(out).toContain('doThing');
    expect(out).toContain('beta');
    expect(out).not.toContain('alpha'); // alpha IS passed; reporting it would be a false positive
  });

  /**
   * The must-not-fire control. A checker that can never come back clean is as broken as one that
   * can never fire — it just fails loudly instead of silently, and this one would be dismissed
   * within a week.
   */
  it('is CLEAN when every declared key is passed by some caller', () => {
    lib(DECL);
    caller(`import { doThing } from '../bus/lib.js';\ndoThing('x', { alpha: 'v' });\ndoThing('y', { beta: 'w' });`);
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out).toContain('No unreachable options keys');
  });

  it('unions keys ACROSS call sites — one caller need not pass everything', () => {
    // The predicate is reachable-from-anywhere, not satisfied-at-every-site. Optional options are
    // normal; a key nobody anywhere can supply is the defect.
    lib(DECL);
    caller(`import { doThing } from '../bus/lib.js';\ndoThing('x', { alpha: 'v' });`);
    expect(run().code).toBe(2);
    caller(`import { doThing } from '../bus/lib.js';\ndoThing('x', { alpha: 'v' });\ndoThing('z', { beta: 'q' });`);
    expect(run().code).toBe(0);
  });

  it('a spread at the call site suppresses the finding — fails toward silence', () => {
    lib(DECL);
    caller(`import { doThing } from '../bus/lib.js';\nconst o = { beta: 'b' };\ndoThing('x', { alpha: 'v', ...o });`);
    expect(run().code).toBe(0);
  });

  it('COUNTS functions it had to skip, so the denominator cannot shrink silently', () => {
    // An unstated skip reads exactly like a clean bill of health. This is the same failure the
    // stated-time coverage number exists to prevent, one tool over.
    writeFileSync(
      join(tmp, 'src', 'bus', 'lib.ts'),
      `interface Opts { alpha?: string; beta?: string }\nexport function doThing(a: string, options: Opts = {}) { return a + options.alpha; }`,
      'utf-8',
    );
    caller(`import { doThing } from '../bus/lib.js';\ndoThing('x', {});`);
    const { out } = run();
    expect(out).toMatch(/1 skipped for typing that parameter as a named interface/);
  });

  it('does not report a function that is never called with an object literal', () => {
    // Nothing to compare against. Reporting it would flag every library function with no CLI
    // surface at all, which is most of them.
    lib(DECL);
    caller(`export const unrelated = 1;`);
    expect(run().code).toBe(0);
  });

  it('exits 3 — could-not-run — when there is no source tree, distinct from a clean pass', () => {
    // 0 and 3 being the same code is what let a wrong invocation look like a clean result.
    rmSync(join(tmp, 'src'), { recursive: true, force: true });
    expect(run().code).toBe(3);
  });
});
