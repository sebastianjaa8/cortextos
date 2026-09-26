import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import ts from 'typescript';

// Upstream asserted compile-time opacity of its generation LockHandle. The
// fork's lock has no handle: ownership is a module-private token checked
// against on-disk metadata. The equivalent guarantee is that none of the
// ownership internals are reachable by importing callers.
describe('lock ownership compile-time opacity', () => {
  it('does not expose owner-token or publication internals to importing callers', () => {
    const root = process.cwd();
    const fixture = join(root, 'tests/fixtures/lock-handle-opacity-consumer.ts');
    const configPath = join(root, 'tsconfig.json');
    const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
    expect(loaded.error).toBeUndefined();

    const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root, {
      noEmit: true,
      rootDir: undefined,
    }, configPath);
    const program = ts.createProgram([fixture], parsed.options);
    const diagnostics = ts.getPreEmitDiagnostics(program)
      .filter(diagnostic => diagnostic.file?.fileName === fixture);

    const messages = diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      '\n',
    ));
    expect(messages).toEqual([
      expect.stringContaining("declares 'HELD_LOCKS' locally, but it is not exported"),
      expect.stringContaining("declares 'readMetadata' locally, but it is not exported"),
      expect.stringContaining("declares 'installFreshLock' locally, but it is not exported"),
      expect.stringContaining("declares 'publishLock' locally, but it is not exported"),
    ]);
    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual([2459, 2459, 2459, 2459]);
  });
});
