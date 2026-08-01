import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/cli/index.ts',
    daemon: 'src/daemon/index.ts',
    'daemon-restart-helper': 'src/daemon-restart-helper.ts',
    'hooks/hook-permission-telegram': 'src/hooks/hook-permission-telegram.ts',
    'hooks/hook-ask-telegram': 'src/hooks/hook-ask-telegram.ts',
    'hooks/hook-planmode-telegram': 'src/hooks/hook-planmode-telegram.ts',
    'hooks/hook-crash-alert': 'src/hooks/hook-crash-alert.ts',
    'hooks/hook-compact-telegram': 'src/hooks/hook-compact-telegram.ts',
    'hooks/hook-extract-facts': 'src/hooks/hook-extract-facts.ts',
    'hooks/hook-idle-flag': 'src/hooks/hook-idle-flag.ts',
    'hooks/hook-context-status': 'src/hooks/hook-context-status.ts',
    'hooks/hook-loop-detector': 'src/hooks/hook-loop-detector.ts',
  },
  format: ['cjs'],
  target: 'node20',
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
  shims: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: ['node-pty'],
  // Provenance stamp, written ONLY by a real build. `guard-arm-check` reads it to answer "was this
  // bundle produced from this source" — a content question that two clocks cannot answer, which is
  // how a `git checkout` revert once reported STALE-BUNDLE against a current bundle.
  //
  // NOT `|| true` and NOT existence-guarded ON PURPOSE. Either would let the stamp silently fail to
  // write, and a provenance tool that quietly reports nothing is worse than no tool: it trains its
  // reader to ignore it. If this step fails, the build should fail loudly.
  onSuccess: 'node scripts/build-stamp.mjs --write',
});
