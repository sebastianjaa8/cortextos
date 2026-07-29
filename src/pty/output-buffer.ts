import { appendFileSync, renameSync, statSync } from 'fs';
import { redactSecrets } from './redact.js';

// Dynamic import for strip-ansi (ESM module)
let stripAnsi: (text: string) => string;
async function loadStripAnsi() {
  if (!stripAnsi) {
    const mod = await import('strip-ansi');
    stripAnsi = mod.default;
  }
  return stripAnsi;
}

const MAX_LOG_BYTES = 50 * 1024 * 1024; // 50 MB — rotate before OS file-cache pressure builds

/**
 * Ring buffer for PTY output. Replaces tmux capture-pane.
 * Stores raw output chunks and provides search/retrieval with ANSI stripping.
 */
export class OutputBuffer {
  private chunks: string[] = [];
  private maxChunks: number;
  private logPath: string | null;
  private bootstrapPattern: string;
  private totalBytes = 0;
  private bootstrapConfirmed = false;

  constructor(maxChunks: number = 1000, logPath?: string, bootstrapPattern?: string) {
    this.maxChunks = maxChunks;
    this.logPath = logPath || null;
    this.bootstrapPattern = bootstrapPattern || 'permissions';
  }

  /**
   * Push new output data into the buffer.
   * Also streams to log file if configured.
   *
   * Secret redaction runs once at the top via `redactSecrets` and the
   * scrubbed string is used for BOTH the in-memory ring buffer AND the
   * disk log. Without this, any JWT or session cookie an agent's shell
   * happens to print (e.g. curl -v against an authenticated endpoint)
   * would end up persisted to stdout.log verbatim. See src/pty/redact.ts
   * for the rationale + the known chunk-boundary limitation.
   */
  push(data: string): void {
    const safe = redactSecrets(data);
    this.totalBytes += safe.length;

    this.chunks.push(safe);
    if (this.chunks.length > this.maxChunks) {
      this.chunks.shift();
    }

    // Check for the boot-marker on EVERY push, not just when isBootstrapped()
    // happens to be called. Codex peer review (2026-07-29) on the earlier
    // on-demand-only version: if nothing ever calls isBootstrapped() while
    // the marker is still in the ring window (e.g. FastChecker's bootstrap
    // wait only runs on initial start, not after a sessionRefresh(); a
    // session with no queued cron never drives drainTick() either), the
    // marker chunk can be evicted with the flag never having latched —
    // same permanent-false failure the sticky cache was built to close.
    // Checking here removes that gap entirely: the newest chunk just
    // pushed is never the one `shift()` evicts (only the oldest is), so
    // the marker is guaranteed to be examined at least once, at the exact
    // moment it's still guaranteed present, before any caller has to ask.
    if (!this.bootstrapConfirmed) {
      this.checkBootstrap();
    }

    // Stream to log file (replaces tmux pipe-pane)
    if (this.logPath) {
      try {
        try {
          const size = statSync(this.logPath).size;
          if (size >= MAX_LOG_BYTES) {
            try { renameSync(this.logPath, this.logPath + '.1'); } catch { /* ignore */ }
          }
        } catch { /* file doesn't exist yet — skip rotation check */ }
        appendFileSync(this.logPath, safe, 'utf-8');
      } catch {
        // Ignore log write errors
      }
    }
  }

  /**
   * Monotonic count of output bytes pushed since construction.
   * Used by verified message injection (src/pty/inject.ts) to detect
   * whether a submitted Enter actually started a turn (a submit always
   * produces a burst of repaint output; a lost Enter produces silence).
   */
  getTotalBytes(): number {
    return this.totalBytes;
  }

  /**
   * Get the last N chunks of output joined together.
   */
  getRecent(n?: number): string {
    const count = n || this.chunks.length;
    return this.chunks.slice(-count).join('');
  }

  /**
   * Search for a pattern in recent output (ANSI codes stripped).
   * Used for bootstrap detection ("permissions" text).
   */
  async search(pattern: string): Promise<boolean> {
    const strip = await loadStripAnsi();
    const text = strip(this.getRecent());
    return text.includes(pattern);
  }

  /**
   * Synchronous search for simple patterns.
   * Does basic ANSI stripping inline (strips ESC[ sequences).
   */
  searchSync(pattern: string): boolean {
    const text = this.getRecent().replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    return text.includes(pattern);
  }

  /**
   * Scan the current buffer for the boot marker and latch bootstrapConfirmed
   * if found. Called from push() (so the marker is checked the moment it's
   * guaranteed present, before it could ever be evicted) AND from
   * isBootstrapped() (so a buffer seeded before this instance started
   * observing pushes — e.g. a test constructing content directly — still
   * gets checked on first read). No-op once already confirmed.
   */
  private checkBootstrap(): void {
    const recent = this.getRecent();
    const cleaned = recent.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

    if (this.bootstrapPattern === 'permissions') {
      // Claude Code: exclude trust-folder prompt false positives.
      // The trust prompt shows "trust this folder" before the status bar appears.
      if (cleaned.includes('trust') && !cleaned.includes('> ')) {
        return;
      }
    }

    if (cleaned.includes(this.bootstrapPattern)) {
      this.bootstrapConfirmed = true;
    }
  }

  /**
   * Check if agent has bootstrapped (ready-for-input signal appeared).
   *
   * For Claude Code: looks for the "permissions" status-bar text.
   * For Hermes: looks for the "❯" prompt character (configurable via constructor).
   * The bootstrap pattern is set at construction time by the PTY class.
   *
   * STICKY: bootstrap is a one-time event per session lifetime, not a
   * repeating state — a session never legitimately "un-bootstraps" itself.
   * Once the marker has been seen, the result is cached and every subsequent
   * call short-circuits without re-scanning. Before this fix, a long-idle
   * session whose boot-time marker chunk had scrolled out of the bounded
   * ring buffer (maxChunks) would flip back to false with nothing to ever
   * refresh it (idle = no new pushes), permanently blocking
   * agent-process.ts's drainTick() queued-cron-injection gate — the root
   * cause of the 2026-07-28 "injected cron prompts don't wake idle sessions"
   * incident (task_1785280765307): crons queued for 15h, only delivered once
   * an unrelated interactive message (which bypasses this gate) produced a
   * fresh repaint that happened to re-populate the marker.
   *
   * The cache is latched primarily by push() (see there for why that closes
   * the gap Codex peer review found in the on-demand-only version: nothing
   * guarantees isBootstrapped() itself gets called while the marker is still
   * in the window). This call remains as a fallback for buffers whose
   * content was seeded before this instance observed any push() (tests
   * constructing a buffer and writing chunks then immediately asserting).
   */
  isBootstrapped(): boolean {
    if (!this.bootstrapConfirmed) this.checkBootstrap();
    return this.bootstrapConfirmed;
  }

  /**
   * Get the total size of buffered output in bytes.
   * Useful for activity detection (typing indicator).
   */
  getSize(): number {
    let size = 0;
    for (const chunk of this.chunks) {
      size += chunk.length;
    }
    return size;
  }

  /**
   * Clear the buffer.
   */
  clear(): void {
    this.chunks = [];
  }
}
