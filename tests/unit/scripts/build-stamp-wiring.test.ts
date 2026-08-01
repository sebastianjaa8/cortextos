/**
 * Pins the WIRING of the provenance stamp, not its logic.
 *
 * build-stamp.mjs has its own self-test and guard-arm-check has its own, and BOTH drive `verdict()`
 * with fabricated inputs. Neither reads tsup.config.ts, so deleting the single `onSuccess` line that
 * makes a stamp exist at all left both suites green — the function tested, the call untested.
 *
 * The failure that costs something is not a wrong verdict. It is an upgrade that moves or drops the
 * tsup key, after which no stamp is written and guard-arm-check reports UNVERIFIABLE forever. That
 * is the state build-stamp.mjs itself calls "worse than no tool: it trains its reader to ignore it",
 * and nothing else in the repo would notice.
 *
 * Same move as restart-command.test.ts, which already asserts on tsup.config.ts contents.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

const repoRoot = process.cwd();
const tsupConfig = () => readFileSync(join(repoRoot, 'tsup.config.ts'), 'utf-8');

describe('build provenance stamp wiring', () => {
  it('runs build-stamp --write as a tsup postbuild step', () => {
    const source = tsupConfig();
    // The whole invocation, not just the filename: a `onSuccess` that ran the script WITHOUT
    // --write would produce the usage error and no stamp, which is the same end state as no key.
    expect(source).toContain("onSuccess: 'node scripts/build-stamp.mjs --write'");
  });

  it('ships the script the build step invokes', () => {
    // The reason this file was moved out of orgs/: .gitignore excludes that tree as user org data,
    // so a tracked tsup.config.ts pointing into it builds here and breaks on every clone. This
    // assertion is what turns that reasoning into something that fails if someone moves it back.
    expect(existsSync(join(repoRoot, 'scripts/build-stamp.mjs'))).toBe(true);
  });

  it('does not swallow a failed stamp write', () => {
    const source = tsupConfig();
    // `|| true` or an existence guard would each let the stamp silently not get written. A
    // provenance tool that reports nothing on failure is the exact defect it exists to detect, so
    // the loudness is part of the contract and not a style preference.
    // NO `?? ''` FALLBACK, DELIBERATELY. The first draft had one, and it made this assertion pass
    // VACUOUSLY on the exact deletion it sits next to: `find` returns undefined, the fallback turns
    // it into an empty string, and an empty string contains neither '||' nor '2>'. It was saved
    // only by the assertion above running first in the same file — so anyone reworking that one
    // would have silently converted this into a test that cannot fail.
    //
    // A fallback that converts an ABSENCE into a passing VALUE is the same defect this whole change
    // is about. Assert the line exists, then assert what it does not contain.
    const onSuccessLine = source.split('\n').find((l) => l.includes('onSuccess:'));
    expect(onSuccessLine).toContain('build-stamp.mjs');
    expect(onSuccessLine).not.toContain('||');
    expect(onSuccessLine).not.toContain('2>');
  });
});
