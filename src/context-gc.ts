/**
 * context-gc — incremental, narrative-preserving context garbage collection
 *              for Pi.
 *
 * Hooks:  `context`       — runs before every LLM call; trims duplicate /
 *                          invalidated tool output while keeping all
 *                          narrative (user / assistant text) and recent
 *                          turns intact.
 *          `session_start` — sets up the visible status bar.
 *          `agent_settled` — final cleanup, resets per-turn stats.
 *
 * Design rules (conservative on narrative, aggressive on tool data):
 *   - NEVER touch user / assistant messages with non-empty text content.
 *   - NEVER touch the last PROTECTED_RECENT messages of any turn.
 *   - Eliminate `toolResult` only when its content is byte-identical AND
 *     the tool identity (file path / command) is verifiable from the
 *     matching `assistant` toolCall in the same context.
 *   - Eliminate older `read` toolResults whose file was later edited or
 *     written (the read is invalidated; the new state supersedes it).
 *   - Eliminate `bashExecution` results that are short, trivial, and have
 *     an identical twin earlier in the session (e.g. repeated `pwd`, `ls`).
 *   - On local / small-maxTokens models, kick in earlier to avoid the
 *     summarizer's `length`-stop failure.
 *
 * All mutations happen on the deep-cloned messages passed by the `context`
 * event; the persisted session is never modified by this extension.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";

/* ------------------------------------------------------------------ *
 * Configuration                                                       *
 * ------------------------------------------------------------------ */

/** Don't touch messages in the last N positions of the message list. */
const PROTECTED_RECENT = 6;

/** bashExecution outputs shorter than this are candidates for dedup. */
const SHORT_BASH_CHARS = 200;

/**
 * toolResult bodies longer than this many chars are collapsed (head + tail)
 * at Tier 2+ instead of dropped, bounding the token footprint of one-off giant
 * logs (builds, webpack, long runs) without an LLM call.
 */
const TOOL_RESULT_MAX_CHARS = 4000;

/**
 * When an `edit.newText` or `write.content` body exceeds this many chars we
 * keep only its head + tail (via `shrinkIfNeeded`) instead of dropping it
 * outright. Large enough to preserve the model's intent while bounding size.
 */
const EDIT_MAX_CHARS = 1500;
const WRITE_MAX_CHARS = 2000;

/** Quarantine file: every removed message is recorded here for audit / manual restore. */
const QUARANTINE_PATH = `${homedir()}/.pi/agent/logs/context-gc-quarantine.jsonl`;

/** Rotate logs/quarantine past these sizes so they cannot grow unbounded. */
const MAX_LOG_BYTES = 2 * 1024 * 1024;        // 2 MiB
const MAX_QUARANTINE_BYTES = 20 * 1024 * 1024; // 20 MiB (quarantine holds full msgs)

/** Rotate a log file (append .1, dropping older) once it exceeds `maxBytes`. */
function rotateIfLarge(path: string, maxBytes: number): void {
  try {
    if (statSync(path).size < maxBytes) return;
    const backup = `${path}.1`;
    renameSync(path, backup);
  } catch {
    // best-effort; never let rotation break the extension
  }
}

/** Three-step pressure triggers (fraction of context window). */
const TIER_1_PERCENT = 25; // gentle: dedup exact duplicates only
const TIER_2_PERCENT = 50; // medium: + invalidate old reads
const TIER_3_PERCENT = 75; // aggressive: + dedup trivial bash

type Aggressiveness = 0 | 1 | 2 | 3;
// Exported for tests only; pure, no side effects.
export function tierForPercent(percent: number): Aggressiveness {
  if (percent >= TIER_3_PERCENT) return 3;
  if (percent >= TIER_2_PERCENT) return 2;
  if (percent >= TIER_1_PERCENT) return 1;
  return 0;
}

/* ------------------------------------------------------------------ *
 * Stats (per-session)                                                  *
 * ------------------------------------------------------------------ */

interface Stats {
  totalRemoved: number;
  totalEstimatedTokensSaved: number;
  passes: number;
  lastRemoved: number;
  lastEstimatedTokensSaved: number;
  /** First `context` event of a new agent run? If so, we may clean. */
  freshTurn: boolean;
  /** How many `context` events fired during the current run. */
  runContextCalls: number;
  /** Did we already log the first call of this run? */
  runFirstLogged: boolean;
}
const stats: Stats = {
  totalRemoved: 0,
  totalEstimatedTokensSaved: 0,
  passes: 0,
  lastRemoved: 0,
  lastEstimatedTokensSaved: 0,
  freshTurn: true,
  runContextCalls: 0,
  runFirstLogged: false,
};

/* ------------------------------------------------------------------ *
 * Helpers                                                             *
 * ------------------------------------------------------------------ */

function sha256Short(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

/** Rough char-based token estimate (matches Pi's own heuristic). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function getMessageText(msg: AgentMessage): string {
  // user
  if (msg.role === "user") {
    const c = (msg as { content?: unknown }).content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c
        .map((b) =>
          b && typeof b === "object" && (b as { type?: unknown }).type === "text"
            ? String((b as { text?: unknown }).text ?? "")
            : "",
        )
        .join("");
    }
    return "";
  }
  // assistant
  if (msg.role === "assistant") {
    const c = (msg as { content?: unknown }).content;
    if (Array.isArray(c)) {
      return c
        .map((b) =>
          b && typeof b === "object" && (b as { type?: unknown }).type === "text"
            ? String((b as { text?: unknown }).text ?? "")
            : "",
        )
        .join("");
    }
    return "";
  }
  // toolResult
  if (msg.role === "toolResult") {
    const c = (msg as { content?: unknown }).content;
    if (Array.isArray(c)) {
      return c
        .map((b) =>
          b && typeof b === "object" && (b as { type?: unknown }).type === "text"
            ? String((b as { text?: unknown }).text ?? "")
            : "",
        )
        .join("");
    }
    return "";
  }
  // bashExecution
  if (msg.role === "bashExecution") {
    const be = msg as unknown as { command: string; output: string };
    return `${be.command}\n${be.output}`;
  }
  return "";
}

/**
 * Collapse a toolResult whose combined text body exceeds `maxChars`.
 *
 * Keeps the head (first HEAD lines, where the run context usually starts) and
 * the tail (last TAIL lines, where most errors / build output lands),
 * replacing the middle with an explicit placeholder. Pure string surgery on
 * the passed (deep-cloned) message — no drop of run start / errors, no LLM.
 *
 * Returns the removed-character count plus the replacement content so the
 * caller can fold the savings into the diagnostics. Skips (no-op) when the
 * body is already small or contains no text blocks.
 */
// Exported for tests only; pure string surgery on a passed (cloned) message.
export function collapseToolResult(
  msg: AgentMessage,
  maxChars: number,
): { collapsed: boolean; removedChars: number; removedLines: number; content: unknown } {
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) return { collapsed: false, removedChars: 0, removedLines: 0, content };

  const full = content
    .map((b) =>
      b && typeof b === "object" && (b as { type?: unknown }).type === "text"
        ? String((b as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");

  if (full.length <= maxChars) return { collapsed: false, removedChars: 0, removedLines: 0, content };

  const HEAD = 5;
  const TAIL = 50;
  const lines = full.split("\n");
  // Not enough lines to collapse meaningfully without losing the whole body.
  if (lines.length <= HEAD + TAIL) return { collapsed: false, removedChars: 0, removedLines: 0, content };

  const head = lines.slice(0, HEAD);
  const tail = lines.slice(lines.length - TAIL);
  const removedLines = lines.length - HEAD - TAIL;
  const collapsedText =
    head.join("\n") +
    `\n[... Tool Output Collapsed: ${removedLines} lines removed for context budgeting ...]\n` +
    tail.join("\n");

  const newContent: unknown = [{ type: "text", text: collapsedText }];
  return { collapsed: true, removedChars: full.length - collapsedText.length, removedLines, content: newContent };
}

function isNarrativeMessage(msg: AgentMessage): boolean {
  if (msg.role === "user" || msg.role === "assistant") {
    return getMessageText(msg).trim().length > 0;
  }
  return false;
}

/** Extract toolCallId -> identity map by scanning assistant toolCall blocks. */
function buildToolIdentityMap(
  messages: AgentMessage[],
): Map<string, { tool: string; path?: string; command?: string }> {
  const map = new Map<string, { tool: string; path?: string; command?: string }>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
      if (b.type !== "toolCall") continue;
      if (typeof b.id !== "string" || typeof b.name !== "string") continue;
      const args = (b.arguments ?? {}) as Record<string, unknown>;
      const path = typeof args.path === "string" ? args.path : undefined;
      const command = typeof args.command === "string" ? args.command : undefined;
      map.set(b.id, { tool: b.name, path, command });
    }
  }
  return map;
}

/** Build a set of file paths that have been mutated (edit/write) anywhere. */
function buildMutatedFilesSet(messages: AgentMessage[]): Set<string> {
  const set = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: unknown; name?: unknown; arguments?: unknown };
      if (b.type !== "toolCall") continue;
      if (b.name !== "edit" && b.name !== "write") continue;
      const args = (b.arguments ?? {}) as Record<string, unknown>;
      if (typeof args.path === "string") set.add(args.path);
    }
  }
  return set;
}

/* ------------------------------------------------------------------ *
 * ToolCall compacting (B): reformat JSON toolCall blocks as a single  *
 * short line. Pure format change, no information loss.                *
 * ------------------------------------------------------------------ */

function compactToolCalls(messages: AgentMessage[]): { messages: AgentMessage[]; saved: number } {
  let saved = 0;
  const out: AgentMessage[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") {
      out.push(m);
      continue;
    }
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      out.push(m);
      continue;
    }
    let changed = false;
    const newContent = content.map((block) => {
      if (!block || typeof block !== "object") return block;
      const b = block as { type?: unknown; name?: unknown; id?: unknown; arguments?: unknown };
      if (b.type !== "toolCall") return block;
      if (typeof b.name !== "string") return block;
      const args = b.arguments;
      const oldLen = JSON.stringify(block).length;
      // Reformat: keep id+name+arguments, but mutate arguments to a compact form
      // if it's smaller. We only do this for tools whose arguments we know how
      // to safely summarize; for others we leave the JSON intact.
      const newArgs = compactArgs(b.name, args);
      if (newArgs === args) return block;
      const newBlock = { ...b, arguments: newArgs };
      const newLen = JSON.stringify(newBlock).length;
      if (newLen < oldLen) {
        changed = true;
        saved += oldLen - newLen;
        return newBlock;
      }
      return block;
    });
    if (changed) {
      out.push({ ...m, content: newContent } as AgentMessage);
    } else {
      out.push(m);
    }
  }
  return { messages: out, saved };
}

/** Compact a tool's arguments: drop or shorten fields that are heavy but
 *  rarely re-read by the model. Returns the SAME reference if no
 *  compaction is possible, so the caller can detect "no change" cheaply. */
function compactArgs(name: string, args: unknown): unknown {
  if (!args || typeof args !== "object") return args;
  const a = args as Record<string, unknown>;

  switch (name) {
    case "edit": {
      // edit has { path, oldText, newText }. Both can be huge.
      // Keep path. Truncate oldText to a short head (enough to show intent);
      // KEEP newText in full — the model needs the resulting content to
      // follow the edit. Truncate newText only when it is very large.
      const oldText =
        typeof a.oldText === "string"
          ? a.oldText.length > EDIT_MAX_CHARS
            ? truncate(a.oldText, 80)
            : a.oldText
          : undefined;
      const newText =
        typeof a.newText === "string"
          ? a.newText.length > EDIT_MAX_CHARS
            ? shrinkIfNeeded(a.newText, EDIT_MAX_CHARS)
            : a.newText
          : undefined;
      const newArgs: Record<string, unknown> = { path: a.path };
      if (oldText !== undefined) newArgs.oldText = oldText;
      if (newText !== undefined) newArgs.newText = newText;
      return newArgs;
    }
    case "write": {
      // write has { path, content }. content is the whole file.
      // KEEP content — the model may need the written text (diff/feedback).
      // Truncate only when the file is very large; shrinkIfNeeded keeps the
      // head and tail plus a middle hash so the important parts survive.
      if (typeof a.content !== "string") return args;
      const content =
        a.content.length > WRITE_MAX_CHARS
          ? shrinkIfNeeded(a.content, WRITE_MAX_CHARS)
          : a.content;
      return { path: a.path, content };
    }
    case "read":
    case "ls":
    case "find":
    case "grep": {
      // These are already compact. No-op.
      return args;
    }
    case "bash": {
      // bash has { command, timeout? }. command is essential; keep as-is.
      return args;
    }
    default: {
      return args;
    }
  }
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ");
  return t.length <= n ? t : t.slice(0, n) + "…";
}

/** Keep the first and last ~n/2 chars of a very long string, replacing the
 *  middle with a short hash so size drops drastically while leading and
 *  trailing context (which the model usually cares about) survives. Returns
 *  the original unchanged when it already fits under n chars. */
function shrinkIfNeeded(s: string, n: number): string {
  if (s.length <= n) return s;
  const half = Math.floor(n / 2);
  const head = s.slice(0, half);
  const tail = s.length > half ? s.slice(-half) : "";
  const hash = createHash("sha256").update(s).digest("base64").slice(0, 12);
  return `${head}\u2026[middle:${hash}]\u2026${tail}`;
}

/* ------------------------------------------------------------------ *
 * Cleaning logic                                                      *
 * ------------------------------------------------------------------ */

interface CleanDiagnostics {
  toolResults: number;
  withIdentity: number;
  dupHits: number;
  readInvalidated: number;
  bashDeduped: number;
  compactedChars: number;
}

interface QuarantineEntry {
  reason: "readInv" | "dup" | "bashDedup";
  message: AgentMessage;
}

interface CleanResult {
  messages: AgentMessage[];
  removed: number;
  estimatedTokensSaved: number;
  diag: CleanDiagnostics;
  quarantined: QuarantineEntry[];
}

// Exported for tests only. Pure: operates on the passed array and never
// performs file I/O. Mutations happen only on shallow clones of toolResults.
export function cleanMessages(messages: AgentMessage[], tier: Aggressiveness): CleanResult {
  const identityMap = buildToolIdentityMap(messages);
  const mutatedFiles = buildMutatedFilesSet(messages);
  const diag: CleanDiagnostics = {
    toolResults: 0,
    withIdentity: 0,
    dupHits: 0,
    readInvalidated: 0,
    bashDeduped: 0,
    compactedChars: 0,
  };
  const quarantined: QuarantineEntry[] = [];

  // Composite fingerprint -> first seen (for toolResult cross-id dedup).
  const seenToolResults = new Map<string, number>(); // fingerprint -> char length
  // bash command+output sha -> seen flag
  const seenBash = new Map<string, boolean>();

  // For reads of files that have been mutated: keep only the MOST RECENT read
  // per path (its content reflects the current file state); drop earlier ones.
  // Precompute the last-read index per path.
  const lastReadIndexOfPath = new Map<string, number>();
  if (tier >= 2) {
    for (let i = 0; i < messages.length; i++) {
      const mm = messages[i];
      if (mm.role !== "toolResult") continue;
      const t = mm as unknown as { toolCallId?: unknown };
      const id = typeof t.toolCallId === "string" ? t.toolCallId : "";
      const ident = id ? identityMap.get(id) : undefined;
      if (ident?.tool === "read" && ident.path && mutatedFiles.has(ident.path)) {
        lastReadIndexOfPath.set(ident.path, i);
      }
    }
  }

  // Tier 1+: compact toolCall JSON (shorten heavy edit.newText / write.content;
  // see compactArgs — both are kept (truncated when huge), never dropped).
  // Pure format change — no information the model needs to continue work.
  let working: AgentMessage[] = messages;
  let estimatedTokensSaved = 0;
  if (tier >= 1) {
    const compacted = compactToolCalls(working);
    working = compacted.messages;
    diag.compactedChars = compacted.saved;
    estimatedTokensSaved += Math.ceil(compacted.saved / 4);
  }

  const out: AgentMessage[] = [];
  const protectedStart = Math.max(0, working.length - PROTECTED_RECENT);
  let removed = 0;

  for (let i = 0; i < working.length; i++) {
    let m = working[i];
    const inProtected = i >= protectedStart;

    // Never touch narrative messages or anything in the protected window.
    if (inProtected || isNarrativeMessage(m)) {
      out.push(m);
      continue;
    }

    if (m.role === "toolResult") {
      const tr = m as unknown as {
        toolCallId?: unknown;
        toolName?: unknown;
        content?: unknown;
      };
      const id = typeof tr.toolCallId === "string" ? tr.toolCallId : "";
      const name = typeof tr.toolName === "string" ? tr.toolName : "";
      const identity = id ? identityMap.get(id) ?? null : null;

      // Tier 2+: collapse one-off giant toolResult bodies (builds, webpack,
      // long runs) — keep head + tail lines, drop the middle. Lossless in
      // spirit, no LLM. Mutates only the clone below (never the original
      // message); the byte savings flow into the diagnostics before dedup.
      if (tier >= 2) {
        const collapsed = collapseToolResult(m, TOOL_RESULT_MAX_CHARS);
        if (collapsed.collapsed) {
          diag.compactedChars += collapsed.removedChars;
          estimatedTokensSaved += Math.ceil(collapsed.removedChars / 4);
          m = { ...m, content: collapsed.content } as AgentMessage;
        }
      }

      const text = getMessageText(m);
      const sha = sha256Short(`${name}\u0000${text}`);
      diag.toolResults += 1;
      if (identity) diag.withIdentity += 1;

      // Tier 2+: read of a file that was later mutated: keep only the latest
      // read of that path (reflects current file state); drop earlier ones.
      if (
        tier >= 2 &&
        identity?.tool === "read" &&
        identity.path &&
        mutatedFiles.has(identity.path) &&
        lastReadIndexOfPath.get(identity.path) !== i
      ) {
        removed++;
        diag.readInvalidated += 1;
        estimatedTokensSaved += estimateTokens(text);
        quarantined.push({ reason: "readInv", message: m });
        continue;
      }

      // Tier 1+: generic exact duplicate: same tool + same content + same identity.
      if (identity) {
        const dupKey = `${identity.tool}\u0000${identity.path ?? ""}\u0000${identity.command ?? ""}\u0000${sha}`;
        if (seenToolResults.has(dupKey)) {
          removed++;
          diag.dupHits += 1;
          estimatedTokensSaved += estimateTokens(text);
          quarantined.push({ reason: "dup", message: m });
          continue;
        }
        seenToolResults.set(dupKey, text.length);
      }
      out.push(m);
      continue;
    }

    if (m.role === "bashExecution") {
      const be = m as unknown as { command: string; output: string };
      const text = be.output || "";
      // Tier 3: only dedup short, trivial outputs.
      // Tier 1+ dedup: short, identical command+output are pure noise by the
      // time we are trimming for the first LLM call. Keep only the first.
      if (tier >= 1 && text.length > 0 && text.length <= SHORT_BASH_CHARS) {
        const sha = sha256Short(`${be.command}\u0000${text}`);
        if (seenBash.has(sha)) {
          removed++;
          diag.bashDeduped += 1;
          estimatedTokensSaved += estimateTokens(text);
          quarantined.push({ reason: "bashDedup", message: m });
          continue;
        }
        seenBash.set(sha, true);
      }
      out.push(m);
      continue;
    }

    // All other message types: pass through unchanged.
    out.push(m);
  }

  return { messages: out, removed, estimatedTokensSaved, diag, quarantined };
}

/* ------------------------------------------------------------------ *
 * Visibility (status bar + log)                                        *
 * ------------------------------------------------------------------ */

const STATUS_KEY = "context-gc";

function formatStatus(): string {
  if (stats.passes === 0) return "context-gc: idle";
  return `context-gc: ${stats.passes}× · removed ${stats.totalRemoved} msgs · saved ~${Math.round(
    stats.totalEstimatedTokensSaved / 1000,
  )}k tok`;
}

function writeLog(message: string): void {
  // Logging can be disabled via CONTEXT_GC_NO_LOG (used by tests / CI and by
  // anyone who wants a quiet install). Never let logging break the extension.
  if (process.env.CONTEXT_GC_NO_LOG === "1") return;
  try {
    const dir = `${homedir()}/.pi/agent/logs`;
    mkdirSync(dir, { recursive: true });
    rotateIfLarge(`${dir}/context-gc.log`, MAX_LOG_BYTES);
    appendFileSync(
      `${dir}/context-gc.log`,
      `[${new Date().toISOString()}] ${message.replace(/\n/g, "\n  ")}\n`,
    );
  } catch {
    // never let logging break the extension
  }
}

interface QuarantineContextInfo {
  sessionId: string;
  pass: number;
  tier: Aggressiveness;
  percent: number;
}

const SECRET_PATTERNS: Array<{ re: RegExp; repl: string }> = [
  // JWT FIRST: a real 3-part JWT must be redacted whole. The generic
  // KEY/SECRET/TOKEN pattern below is greedy and would otherwise match
  // `token=eyJ...` and leave the signature tail (e.g. `..._signature`) intact.
  { re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, repl: "[REDACTED:<jwt>]" },
  // Generic long secret / key / token, API keys, bearer tokens.
  { re: /(?:(?:[A-Za-z0-9_]{2,})?(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|ACCESS_TOKEN|CLIENT_SECRET)\s*[:=]\s*['"]?)([A-Za-z0-9\-+/=.]{12,})/gi, repl: "[REDACTED:<key>]" },
  { re: /(?:[A-Za-z0-9_+-]{2,}[:_])[A-Za-z0-9\-_+=/.]{20,}/gi, repl: "[REDACTED:<value>]" },
  // Bearer / Basic auth.
  { re: /((?:bearer|basic)\s+[A-Za-z0-9\+/=._-]{20,})/gi, repl: "[REDACTED:<auth>]" },
  // PEM private keys (multi-line).
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, repl: "[REDACTED:<pem>]"},
  // JWT.
  { re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, repl: "[REDACTED:<jwt>]" },
  // AWS-style access key id.
  { re: /(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[A-Z0-9]{12,}/g, repl: "[REDACTED:<aws>]"},
  // hex / base64 blobs that look like secrets. Word-bounded so surrounding
  // text survives; hex first so it wins the overlap on pure-hex runs.
  { re: /(?<!\w)([A-Fa-f0-9]{32,})(?!\w)/g, repl: "[REDACTED:<hex>]" },
  { re: /(?<!\w)([A-Za-z0-9+/]{64,}={0,2})(?!\w)/g, repl: "[REDACTED:<b64>]" },
];

/** Replace values that look like credentials with a short placeholder.
 *  Applied to every quarantine field so secrets never leak in cleartext. */
// Exported for tests only. Pure; no side effects.
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { re, repl } of SECRET_PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags), repl);
  }
  return out;
}

/** Redact credentials from a removed message's own payload fields
 *  (content strings / tool args / bash command+output) before it is
 *  persisted to quarantine. */
function redactSecretsMessage(msg: AgentMessage): AgentMessage {
  const redact = (v: unknown): unknown =>
    typeof v === "string" ? redactSecrets(v) : v;

  const copy = structuredClone(msg) as unknown as Record<string, unknown>;

  // content blocks (user / assistant / toolResult).
  const content = copy.content;
  if (Array.isArray(content)) {
    copy.content = content.map((b) => {
      if (!b || typeof b !== "object") return b;
      const obj = b as Record<string, unknown>;
      // array-of-text (e.g. multi-part text) redacts each text string.
      if (Array.isArray(obj.text)) {
        obj.text = obj.text.map(redact);
        return obj;
      }
      obj.text = redact(obj.text);
      return obj;
    });
  }
  // bashExecution carries command + output at the top level.
  copy.command = redact(copy.command);
  copy.output = redact(copy.output);
  return copy as unknown as AgentMessage;
}

/** Append removed messages to the quarantine file for audit / manual restore.
 *  Best-effort: never let quarantine failures break the extension. */
function quarantineWrite(entries: QuarantineEntry[], info: QuarantineContextInfo): void {
  if (entries.length === 0) return;
  try {
    const dir = `${homedir()}/.pi/agent/logs`;
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    const lines: string[] = [];
    for (const entry of entries) {
      const m = entry.message as unknown as Record<string, unknown>;
      const text = getMessageText(entry.message);
      lines.push(
        JSON.stringify({
          ts,
          session: info.sessionId,
          pass: info.pass,
          tier: info.tier,
          percent: Number(info.percent.toFixed(2)),
          reason: entry.reason,
          role: entry.message.role,
          toolName: typeof m.toolName === "string" ? m.toolName : null,
          toolCallId: typeof m.toolCallId === "string" ? m.toolCallId : null,
          chars: text.length,
          preview: redactSecrets(text.slice(0, 200)),
          full: redactSecretsMessage(entry.message),
        }),
      );
    }
    rotateIfLarge(QUARANTINE_PATH, MAX_QUARANTINE_BYTES);
    appendFileSync(QUARANTINE_PATH, lines.join("\n") + "\n");
  } catch {
    // never let quarantine break the extension
  }
}

/* ------------------------------------------------------------------ *
 * Public entry point                                                  *
 * ------------------------------------------------------------------ */

export default function (pi: ExtensionAPI) {
  // Initial visibility on session load.
  writeLog(`extension loaded (node ${process.version})`);

  pi.on("session_start", async (_event, ctx) => {
    writeLog("session_start");
    if (ctx.ui?.setStatus) ctx.ui.setStatus(STATUS_KEY, formatStatus());
  });

  // Mark the start of a new agent run; the next `context` event is the
  // first LLM call of this run and the only place we may trim — we do
  // NOT touch messages mid-turn (a chain of tool calls must see a
  // stable context).
  pi.on("agent_start", async () => {
    stats.freshTurn = true;
    stats.runContextCalls = 0;
    stats.runFirstLogged = false;
  });

  // Per-turn stats + final cleanup.
  pi.on("agent_settled", async (_event, ctx) => {
    writeLog(
      `run settled: context calls=${stats.runContextCalls} totalRemoved=${stats.totalRemoved} passes=${stats.passes}`,
    );
    stats.lastRemoved = 0;
    stats.lastEstimatedTokensSaved = 0;
    if (ctx.ui?.setStatus) ctx.ui.setStatus(STATUS_KEY, formatStatus());
  });

  // The core hook: trim ONLY at the first LLM call of a new run.
  pi.on("context", async (event, ctx) => {
    stats.runContextCalls += 1;
    // Mid-run LLM calls: leave the context alone.
    if (!stats.freshTurn) return;
    stats.freshTurn = false;

    try {
      const messagesRaw = Array.isArray(event.messages) ? event.messages.length : -1;
      const usage = ctx.getContextUsage();
      if (!usage) {
        if (!stats.runFirstLogged) {
          stats.runFirstLogged = true;
          writeLog(`run first call: no context usage available msgs=${messagesRaw} (skipped)`);
        }
        return;
      }

      // Clamp to [0,100] for logging/reporting: a misbehaving source can
      // report >100% (still tiers to max fine, but logs look sane).
      const percent = usage.percent == null ? null : Math.min(100, Math.max(0, usage.percent));
      if (percent === null) {
        if (!stats.runFirstLogged) {
          stats.runFirstLogged = true;
          writeLog(`run first call: percent=null msgs=${messagesRaw} (skipped)`);
        }
        if (ctx.ui?.setStatus && stats.passes > 0) {
          ctx.ui.setStatus(STATUS_KEY, formatStatus());
        }
        return;
      }

      const tier = tierForPercent(percent);
      if (tier === 0) {
        if (!stats.runFirstLogged) {
          stats.runFirstLogged = true;
          writeLog(
            `run first call: tier=0 pct=${percent.toFixed(1)} msgs=${messagesRaw} — below ${TIER_1_PERCENT}% threshold, no scan`,
          );
        }
        // Below tier-1 trigger: make sure status reflects "idle" but don't process.
        if (ctx.ui?.setStatus && stats.passes > 0) {
          ctx.ui.setStatus(STATUS_KEY, formatStatus());
        }
        return;
      }

      const { messages } = event;
      if (!Array.isArray(messages) || messages.length === 0) return;

      const before = messages.length;
      const result = cleanMessages(messages, tier);
      // `removed===0` still matters when compaction saved bytes: the compacted
      // copy is smaller but lossless, so we should return it. Only fall through
      // to "no change" when nothing changed at all.
      if (result.removed === 0 && result.diag.compactedChars === 0) {
        if (!stats.runFirstLogged) {
          stats.runFirstLogged = true;
          writeLog(
            `run first call: tier=${tier} pct=${percent.toFixed(1)} msgs=${before} tr=${result.diag.toolResults} ident=${result.diag.withIdentity} compacted=${result.diag.compactedChars}B removed=0`,
          );
        }
        if (ctx.ui?.setStatus) ctx.ui.setStatus(STATUS_KEY, formatStatus());
        return;
      }

      // Quarantine: record what we are about to remove, for audit / manual restore.
      let quarantineSessionId = "unknown";
      try {
        quarantineSessionId = ctx.sessionManager.getSessionId();
      } catch {
        // leave as "unknown"
      }
      quarantineWrite(result.quarantined, {
        sessionId: quarantineSessionId,
        pass: stats.passes + 1,
        tier,
        percent,
      });

      // Update stats and status.
      stats.passes += 1;
      stats.totalRemoved += result.removed;
      stats.totalEstimatedTokensSaved += result.estimatedTokensSaved;
      stats.lastRemoved = result.removed;
      stats.lastEstimatedTokensSaved = result.estimatedTokensSaved;

      const after = result.messages.length;
      stats.runFirstLogged = true;
      writeLog(
        `pass=${stats.passes} tier=${tier} pct=${percent.toFixed(1)} ${before}→${after} msgs (removed ${result.removed}, saved ~${result.estimatedTokensSaved} tok) tr=${result.diag.toolResults} ident=${result.diag.withIdentity} dup=${result.diag.dupHits} readInv=${result.diag.readInvalidated} bash=${result.diag.bashDeduped} compacted=${result.diag.compactedChars}B`,
      );

      if (ctx.ui?.setStatus) {
        ctx.ui.setStatus(
          STATUS_KEY,
          `context-gc[t${tier}]: ${before}→${after} (-${result.removed}, ~${Math.round(result.estimatedTokensSaved / 1000)}k tok)`,
        );
      }

      return { messages: result.messages };
    } catch (err) {
      // Fail closed: log, never mutate, never throw.
      const msg = err instanceof Error ? err.message : String(err);
      writeLog(`error: ${msg}`);
      return undefined;
    }
  });
}
