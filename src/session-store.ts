/**
 * Disk-backed session store for claude-code-server.
 * Wraps an in-memory Map with debounced JSON persistence so sessions
 * survive server restarts.
 *
 * Storage location: ~/.claude-code-server/sessions.json
 * Only Node.js built-in modules are used (fs, path, os).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ChildProcess } from 'node:child_process';

// ─── Shared Types ────────────────────────────────────────────────────────────
// These were previously defined in server.ts. Both modules now import from here.

export interface SessionStats {
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  startTime: number;
  lastActivity: string;
}

export interface HistoryEntry {
  time: string;
  type: string;
  event: {
    message?: {
      content?: Array<{ type: string; text?: string; name?: string }>;
    };
  };
}

export interface SessionConfig {
  name: string;
  claudeSessionId: string;
  cwd: string;
  created: string;
  model?: string;
  baseUrl?: string;
  permissionMode: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  dangerouslySkipPermissions?: boolean;
  agents?: Record<string, { description?: string; prompt?: string }>;
  agent?: string;
  addDir?: string[];
  paused: boolean;
  stats: SessionStats;
  history: HistoryEntry[];
  /** Runtime-only — never serialised to disk. */
  activeProcess: ChildProcess | null;
}

// ─── Serialisable subset (no ChildProcess) ───────────────────────────────────

/** What actually gets written to / read from sessions.json. */
interface PersistedSession extends Omit<SessionConfig, 'activeProcess'> {
  /** Persisted status so we know the session existed before the restart. */
  _persistedAt: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_STORE_DIR = path.join(os.homedir(), '.claude-code-server');
const DEFAULT_STORE_FILE = 'sessions.json';
const DEBOUNCE_MS = 2_000;
const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000; // 7 days

// ─── SessionStore ────────────────────────────────────────────────────────────

export class SessionStore {
  private sessions: Map<string, SessionConfig>;
  private storePath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(storePath?: string) {
    this.storePath = storePath ?? path.join(DEFAULT_STORE_DIR, DEFAULT_STORE_FILE);
    this.sessions = new Map();
    this.load();
  }

  // ── Map-compatible API ──────────────────────────────────────────────────

  get(name: string): SessionConfig | undefined {
    return this.sessions.get(name);
  }

  set(name: string, session: SessionConfig): void {
    this.sessions.set(name, session);
    this.scheduleSave();
  }

  delete(name: string): boolean {
    const removed = this.sessions.delete(name);
    if (removed) this.scheduleSave();
    return removed;
  }

  has(name: string): boolean {
    return this.sessions.has(name);
  }

  values(): IterableIterator<SessionConfig> {
    return this.sessions.values();
  }

  entries(): IterableIterator<[string, SessionConfig]> {
    return this.sessions.entries();
  }

  [Symbol.iterator](): IterableIterator<[string, SessionConfig]> {
    return this.sessions.entries();
  }

  get size(): number {
    return this.sessions.size;
  }

  clear(): void {
    this.sessions.clear();
    this.scheduleSave();
  }

  /**
   * Call after mutating a session object in-place (e.g. pushing to history,
   * updating stats) so that the change gets persisted on the next debounce
   * cycle. This avoids forcing every mutation site to call `set()` again.
   */
  markDirty(): void {
    this.scheduleSave();
  }

  // ── Persistence — load ──────────────────────────────────────────────────

  private load(): void {
    try {
      if (!fs.existsSync(this.storePath)) return;

      const raw = fs.readFileSync(this.storePath, 'utf-8');
      const parsed: Record<string, PersistedSession> = JSON.parse(raw);

      if (typeof parsed !== 'object' || parsed === null) {
        console.warn('[SessionStore] Ignoring invalid store file (not an object)');
        return;
      }

      const now = Date.now();

      for (const [name, persisted] of Object.entries(parsed)) {
        // Prune history entries older than 7 days
        const history = (persisted.history ?? []).filter((h: HistoryEntry) => {
          const entryTime = new Date(h.time).getTime();
          return now - entryTime < HISTORY_MAX_AGE_MS;
        });

        const session: SessionConfig = {
          ...persisted,
          history,
          // Processes are gone after a restart — mark as stopped / unpaused
          paused: false,
          activeProcess: null,
        };

        this.sessions.set(name, session);
      }

      console.log(`[SessionStore] Restored ${this.sessions.size} session(s) from disk`);
    } catch (err) {
      // Corrupt file, permission error, etc. — start fresh.
      console.warn('[SessionStore] Could not load sessions from disk:', (err as Error).message);
    }
  }

  // ── Persistence — save (debounced) ──────────────────────────────────────

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return; // already scheduled
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) this.save();
    }, DEBOUNCE_MS);
    // Don't keep the event loop alive just for a pending save
    this.saveTimer.unref();
  }

  /** Flush immediately (useful during shutdown). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) this.save();
  }

  private save(): void {
    this.dirty = false;
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const serialisable: Record<string, PersistedSession> = {};

      for (const [name, session] of this.sessions) {
        // Strip the runtime-only activeProcess field
        const { activeProcess: _proc, ...rest } = session;
        serialisable[name] = {
          ...rest,
          _persistedAt: new Date().toISOString(),
        };
      }

      // Atomic-ish write: write to temp file then rename
      const tmp = this.storePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(serialisable, null, 2), 'utf-8');
      fs.renameSync(tmp, this.storePath);
    } catch (err) {
      console.error('[SessionStore] Failed to persist sessions:', (err as Error).message);
    }
  }
}
