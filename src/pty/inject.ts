import { createHash } from 'crypto';

// Bracketed paste mode escape sequences
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// Key escape sequences for TUI navigation
export const KEYS = {
  ENTER: '\r',
  CTRL_C: '\x03',
  DOWN: '\x1b[B',
  UP: '\x1b[A',
  SPACE: ' ',
  ESCAPE: '\x1b',
  TAB: '\t',
} as const;

/**
 * Message deduplication via MD5 hash.
 * Prevents double-injection on crash recovery.
 * Matches bash fast-checker.sh dedup pattern.
 */
export class MessageDedup {
  private hashes: string[] = [];
  private maxEntries: number;

  constructor(maxEntries: number = 100) {
    this.maxEntries = maxEntries;
  }

  /**
   * Returns true if this content has been seen before (duplicate).
   */
  isDuplicate(content: string): boolean {
    const hash = createHash('md5').update(content).digest('hex');
    if (this.hashes.includes(hash)) {
      return true;
    }
    this.hashes.push(hash);
    if (this.hashes.length > this.maxEntries) {
      this.hashes.shift();
    }
    return false;
  }

  /**
   * Remove a previously-recorded hash so an identical re-send is not
   * dedup-rejected. Called when a submit verifiably FAILED (Enter never
   * sent, or the verify loop saw zero output after all retries) — the
   * content never reached the agent, so the dedup entry is poison: it
   * would silently drop the retry of a lost message.
   */
  forget(content: string): void {
    const hash = createHash('md5').update(content).digest('hex');
    const idx = this.hashes.indexOf(hash);
    if (idx !== -1) {
      this.hashes.splice(idx, 1);
    }
  }

  clear(): void {
    this.hashes = [];
  }
}

/**
 * Optional submit verification for injectMessage.
 *
 * getOutputBytes returns a monotonic count of PTY output bytes
 * (OutputBuffer.getTotalBytes). A successful Enter submit always triggers a
 * large repaint burst (spinner, status line, streamed response); a lost
 * Enter leaves the pasted text sitting in the composer with near-zero
 * output. Comparing the counter before/after Enter distinguishes the two.
 */
export interface InjectVerify {
  getOutputBytes: () => number;
  log?: (msg: string) => void;
  /**
   * Called when the submit verifiably failed: the Enter write threw (PTY
   * torn down) or every Enter retry saw zero PTY output. Callers use this
   * to un-poison dedup state so a re-send of the same content is not
   * silently dropped (at-least-once over at-most-once — a false-negative
   * here can at worst double-deliver, which is benign vs silent loss).
   */
  onFailed?: () => void;
}

// A submit repaint is thousands of bytes; idle-prompt noise is ~0.
const SUBMIT_ACTIVITY_MIN_BYTES = 200;
// Re-check delays after each Enter before concluding it was swallowed.
// Wide windows on purpose: during fleet boot (13 sessions + their MCP
// servers spawning at once) a submitted turn's repaint burst can lag the
// Enter by 10s+ — the 2026-07-02 recovery showed 2.5s/6s windows logging
// false "retries exhausted" on messages that had actually submitted.
// Extra Enters on an already-submitted (empty) composer are no-ops, so
// the only cost of a wide window is a delayed retry on a real miss.
const ENTER_RETRY_DELAYS_MS = [4000, 10000, 20000];

/**
 * Inject a message into a PTY process using bracketed paste mode.
 * Replaces tmux load-buffer + paste-buffer pattern.
 *
 * Bracketed paste mode wraps the content so the terminal treats it as
 * pasted text rather than typed input. This prevents special characters
 * from being interpreted as commands.
 *
 * The Enter that submits the paste is UNRELIABLE at a fixed short delay:
 * Claude Code renders large pastes as an async "[Pasted text #N]"
 * placeholder, and under memory pressure placeholder registration can take
 * longer than the delay — the Enter lands on an empty composer and is a
 * no-op, leaving the message stranded unsubmitted (2026-07-01 incident:
 * seb_boss composer accumulated stuck pastes for hours while short messages
 * kept working). Two mitigations:
 *   1. enterDelay scales with content size (default, when not overridden).
 *   2. When `verify` is provided, PTY output is sampled after Enter; if the
 *      screen stayed silent, Enter is re-sent (bounded retries).
 *
 * @param write Function to write to the PTY (pty.write)
 * @param content The message content to inject
 * @param enterDelay Milliseconds to wait before sending Enter
 *                   (default: scaled to content size, 900–3000ms)
 * @param verify Optional output-activity probe enabling Enter retries
 */
export function injectMessage(
  write: (data: string) => void,
  content: string,
  enterDelay?: number,
  verify?: InjectVerify,
): void {
  const delay = enterDelay ?? Math.min(3000, 900 + Math.floor(content.length / 2));
  // For very large messages, chunk the write to avoid overwhelming the PTY buffer
  const MAX_CHUNK = 4096;

  if (content.length <= MAX_CHUNK) {
    write(PASTE_START + content + PASTE_END);
  } else {
    // Chunked write for large messages
    write(PASTE_START);
    for (let i = 0; i < content.length; i += MAX_CHUNK) {
      write(content.slice(i, i + MAX_CHUNK));
    }
    write(PASTE_END);
  }

  // Send Enter after a short delay to submit the pasted content.
  // Why the try/catch: the write callback captures `this.pty` (or similar
  // nullable PTY handle) via closure in callers. If the PTY is torn down
  // during the enterDelay window — e.g. hard-restart IPC kills the child —
  // the callback will read `null.write` and throw. Swallowing here keeps
  // the daemon process alive; the dropped Enter is the acceptable cost.
  // Root cause: PR #196 fixed three this.pty! callers in agent-process.ts
  // but missed worker-process.ts:93. This try/catch is the structural fix
  // that covers every present and future caller.
  const sendEnter = (): boolean => {
    try {
      write(KEYS.ENTER);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[inject] deferred Enter failed (pty likely torn down): ${msg}`);
      return false;
    }
  };

  setTimeout(() => {
    if (!sendEnter()) {
      // Enter never reached the PTY — the paste is stranded (or the PTY is
      // gone entirely). Report failure so dedup state can be un-poisoned.
      verify?.onFailed?.();
      return;
    }
    if (!verify) return;

    // Verified-submit loop: if the PTY produced (almost) no output since
    // Enter, the composer still holds the paste — re-send Enter. A bare
    // Enter on an already-submitted (empty) composer is a no-op, so a
    // false-negative retry is harmless.
    let baseline = verify.getOutputBytes();
    let attempt = 0;
    const check = () => {
      const grown = verify.getOutputBytes() - baseline;
      if (grown >= SUBMIT_ACTIVITY_MIN_BYTES) return; // turn started
      if (attempt >= ENTER_RETRY_DELAYS_MS.length) {
        verify.log?.(`[inject] Enter retries exhausted (${grown}B output) — message may be stuck in composer`);
        verify.onFailed?.();
        return;
      }
      verify.log?.(`[inject] no PTY output after Enter (${grown}B) — re-sending Enter (retry ${attempt + 1})`);
      baseline = verify.getOutputBytes();
      if (!sendEnter()) {
        verify.onFailed?.();
        return;
      }
      attempt++;
      setTimeout(check, ENTER_RETRY_DELAYS_MS[Math.min(attempt, ENTER_RETRY_DELAYS_MS.length - 1)]);
    };
    setTimeout(check, ENTER_RETRY_DELAYS_MS[0]);
  }, delay);
}

/**
 * Send a sequence of keys to the PTY for TUI navigation.
 * Used for AskUserQuestion option selection and Plan mode approval.
 *
 * @param write Function to write to the PTY
 * @param keys Array of key sequences to send
 * @param delay Milliseconds between each key (default 100ms)
 */
export async function sendKeySequence(
  write: (data: string) => void,
  keys: string[],
  delay: number = 100,
): Promise<void> {
  for (const key of keys) {
    write(key);
    await sleep(delay);
  }
}

/**
 * Navigate to a specific option in a TUI list and select it.
 * Matches bash fast-checker.sh AskUserQuestion navigation.
 *
 * @param write PTY write function
 * @param optionIndex 0-based index of the option to select
 * @param submit Whether to press Enter after selection
 */
export async function selectOption(
  write: (data: string) => void,
  optionIndex: number,
  submit: boolean = true,
): Promise<void> {
  // Navigate down to the option
  for (let i = 0; i < optionIndex; i++) {
    write(KEYS.DOWN);
    await sleep(100);
  }
  await sleep(200);

  if (submit) {
    write(KEYS.ENTER);
  }
}

/**
 * Toggle options for multi-select TUI and submit.
 * Matches bash fast-checker.sh multi-select pattern.
 */
export async function toggleAndSubmit(
  write: (data: string) => void,
  selectedIndices: number[],
  totalOptions: number,
): Promise<void> {
  const sorted = [...selectedIndices].sort((a, b) => a - b);
  let currentPos = 0;

  for (const idx of sorted) {
    const moves = idx - currentPos;
    for (let i = 0; i < moves; i++) {
      write(KEYS.DOWN);
      await sleep(100);
    }
    write(KEYS.SPACE);
    await sleep(100);
    currentPos = idx;
  }

  // Navigate to Submit button (past all options + "Other")
  const submitPos = totalOptions + 1;
  const remaining = submitPos - currentPos;
  for (let i = 0; i < remaining; i++) {
    write(KEYS.DOWN);
    await sleep(100);
  }
  await sleep(200);
  write(KEYS.ENTER);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
