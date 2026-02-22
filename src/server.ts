#!/usr/bin/env node
/**
 * Backend API server for claude-code-skill CLI.
 * Spawns `claude` CLI processes to fulfill requests.
 * Disk-backed session store for persistent sessions (via SessionStore).
 */

import http from 'node:http';
import { spawn, exec, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { SessionStore } from './session-store.js';
import type { SessionConfig, SessionStats, HistoryEntry } from './session-store.js';

// ─── Security: Rate Limiting ────────────────────────────────────────────────

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitBucket>();

const rateLimitCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitStore) {
    if (bucket.resetAt <= now) rateLimitStore.delete(key);
  }
}, 60_000);
rateLimitCleanupInterval.unref();

type RateLimitGroup = 'read' | 'write' | 'spawn';

const RATE_LIMITS: Record<RateLimitGroup, number> = {
  read: parseInt(process.env.RATE_LIMIT_READ || '120'),    // 120 req/min for read-only endpoints
  write: parseInt(process.env.RATE_LIMIT_WRITE || '60'),   // 60 req/min for write/bash endpoints
  spawn: parseInt(process.env.RATE_LIMIT_SPAWN || '20'),   // 20 req/min for claude spawn endpoints
};

function checkRateLimit(ip: string, group: RateLimitGroup): boolean {
  const maxRequests = RATE_LIMITS[group];
  const now = Date.now();
  const key = `${ip}:${group}`;
  const bucket = rateLimitStore.get(key);

  if (!bucket || bucket.resetAt <= now) {
    rateLimitStore.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }

  bucket.count++;
  return bucket.count <= maxRequests;
}

function getClientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || '127.0.0.1';
}

const endpointRateLimitGroup: Record<string, RateLimitGroup> = {
  '/connect': 'read',
  '/disconnect': 'write',
  '/tools': 'read',
  '/bash': 'write',
  '/read': 'read',
  '/call': 'spawn',
  '/sessions': 'read',
  '/batch-read': 'read',
  '/resume': 'spawn',
  '/continue': 'spawn',
  '/session/start': 'write',
  '/session/send': 'spawn',
  '/session/send-stream': 'spawn',
  '/session/list': 'read',
  '/session/stop': 'write',
  '/session/status': 'read',
  '/session/history': 'read',
  '/session/pause': 'write',
  '/session/resume': 'write',
  '/session/fork': 'write',
  '/session/search': 'read',
  '/session/restart': 'write',
};

// ─── Security: Input Validation ─────────────────────────────────────────────

const SESSION_NAME_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_COMMAND_LENGTH = 10_000;
const MAX_MESSAGE_LENGTH = 100_000;
const MAX_PATH_LENGTH = 4096;

/** Shell metacharacters that enable command injection */
const DANGEROUS_SHELL_CHARS = /[;|&`$(){}!#<>\n\r]/;

function isValidSessionName(name: unknown): name is string {
  return typeof name === 'string' && SESSION_NAME_RE.test(name);
}

function validateString(
  value: unknown,
  fieldName: string,
  maxLength: number,
): { valid: true; value: string } | { valid: false; error: string } {
  if (typeof value !== 'string' || value.length === 0) {
    return { valid: false, error: `Missing or empty required field: ${fieldName}` };
  }
  if (value.length > maxLength) {
    return { valid: false, error: `${fieldName} exceeds maximum length of ${maxLength}` };
  }
  return { valid: true, value };
}

function validateFilePath(
  filePath: unknown,
  allowedBases?: string[],
): { valid: true; resolved: string } | { valid: false; error: string } {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { valid: false, error: 'Missing or empty file_path' };
  }
  if (filePath.length > MAX_PATH_LENGTH) {
    return { valid: false, error: `file_path exceeds maximum length of ${MAX_PATH_LENGTH}` };
  }
  const resolved = path.resolve(filePath);
  if (allowedBases && allowedBases.length > 0) {
    const isAllowed = allowedBases.some((base) => resolved.startsWith(path.resolve(base)));
    if (!isAllowed) {
      return { valid: false, error: 'Access denied: path is outside allowed directories' };
    }
  }
  return { valid: true, resolved };
}

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.CLAUDE_CODE_PORT || '18795');
const HOST = process.env.CLAUDE_CODE_HOST || '127.0.0.1';
const PREFIX = '/backend-api/claude-code';
const HOME = process.env.HOME || '/tmp';
const CLAUDE_HOME = path.join(HOME, '.claude');

/** Comma-separated allowed directories for /read and /batch-read. Unset = allow all resolved paths. */
const ALLOWED_READ_DIRS: string[] | undefined = process.env.ALLOWED_READ_DIRS
  ? process.env.ALLOWED_READ_DIRS.split(',').map((d) => d.trim())
  : undefined;

function findClaudeBin(): string {
  const candidates = [
    process.env.CLAUDE_BIN,
    path.join(HOME, '.local/bin/claude'),
    '/usr/local/bin/claude',
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch { /* try next */ }
  }
  return 'claude';
}

const CLAUDE_BIN = findClaudeBin();

// ─── Types ───────────────────────────────────────────────────────────────────
// SessionConfig, SessionStats, and HistoryEntry are imported from ./session-store.js

interface ClaudeResult {
  type?: string;
  subtype?: string;
  result?: string;
  session_id?: string;
  cost_usd?: number;
  num_turns?: number;
  is_error?: boolean;
  duration_ms?: number;
}

type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Record<string, unknown>,
) => Promise<void>;

// ─── State ───────────────────────────────────────────────────────────────────

const sessions = new SessionStore();
let connected = false;

// Track all spawned child processes for zombie cleanup
const trackedProcesses = new Set<ChildProcess>();
let inFlightRequests = 0;
let isShuttingDown = false;

function trackProcess(proc: ChildProcess): void {
  trackedProcesses.add(proc);
  const cleanup = () => { trackedProcesses.delete(proc); };
  proc.on('exit', cleanup);
  proc.on('error', cleanup);
  proc.on('close', cleanup);
}

// Periodic zombie process cleanup — every 60s, remove dead processes from the set
const zombieCleanupInterval = setInterval(() => {
  for (const proc of trackedProcesses) {
    if (proc.killed || proc.exitCode !== null || proc.signalCode !== null) {
      trackedProcesses.delete(proc);
    }
  }
}, 60_000);
zombieCleanupInterval.unref(); // Don't keep the event loop alive just for this

const KNOWN_TOOLS = [
  { name: 'Bash', description: 'Execute bash commands' },
  { name: 'Read', description: 'Read file contents' },
  { name: 'Write', description: 'Write file contents' },
  { name: 'Edit', description: 'Edit file contents with search/replace' },
  { name: 'Glob', description: 'Find files by glob pattern' },
  { name: 'Grep', description: 'Search file contents with regex' },
  { name: 'WebFetch', description: 'Fetch and process web content' },
  { name: 'WebSearch', description: 'Search the web' },
  { name: 'Task', description: 'Launch sub-agents for complex tasks' },
  { name: 'NotebookEdit', description: 'Edit Jupyter notebook cells' },
  { name: 'TodoRead', description: 'Read todo list' },
  { name: 'TodoWrite', description: 'Write todo list' },
  { name: 'AskUserQuestion', description: 'Ask the user a question' },
];

// ─── Utilities ───────────────────────────────────────────────────────────────

function sendJson(res: http.ServerResponse, status: number, data: object): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
const REQUEST_TIMEOUT_MS = 30_000; // 30s default

class BodyTooLargeError extends Error {
  constructor(size: number) {
    super(`Request body too large: ${size} bytes exceeds ${MAX_BODY_SIZE} byte limit`);
    this.name = 'BodyTooLargeError';
  }
}

class MalformedJsonError extends Error {
  constructor(parseError: string) {
    super(`Malformed JSON in request body: ${parseError}`);
    this.name = 'MalformedJsonError';
  }
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    const timeout = setTimeout(() => {
      req.destroy(new Error('Request body read timed out'));
      reject(new Error('Request body read timed out'));
    }, REQUEST_TIMEOUT_MS);

    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();
        clearTimeout(timeout);
        reject(new BodyTooLargeError(totalSize));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      clearTimeout(timeout);
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new MalformedJsonError((err as Error).message));
      }
    });

    req.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function buildClaudeArgs(prompt: string, opts: {
  sessionId?: string;
  continueSession?: boolean;
  outputFormat?: string;
  model?: string;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  dangerouslySkipPermissions?: boolean;
  addDir?: string[];
}): string[] {
  const args = ['-p', '--output-format', opts.outputFormat || 'json'];

  if (opts.sessionId) args.push('--session-id', opts.sessionId);
  if (opts.continueSession) args.push('--continue');
  if (opts.model) args.push('--model', opts.model);
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.allowedTools?.length) args.push('--allowed-tools', opts.allowedTools.join(','));
  if (opts.disallowedTools?.length) args.push('--disallowed-tools', opts.disallowedTools.join(','));
  if (opts.maxTurns) args.push('--max-turns', String(opts.maxTurns));
  if (opts.systemPrompt) args.push('--system-prompt', opts.systemPrompt);
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
  if (opts.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
  if (opts.addDir?.length) {
    for (const dir of opts.addDir) args.push('--add-dir', dir);
  }

  args.push(prompt);
  return args;
}

function sessionClaudeOpts(s: SessionConfig): {
  sessionId: string;
  model?: string;
  permissionMode: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  dangerouslySkipPermissions?: boolean;
  addDir?: string[];
} {
  return {
    sessionId: s.claudeSessionId,
    model: s.model,
    permissionMode: s.permissionMode,
    allowedTools: s.allowedTools,
    disallowedTools: s.disallowedTools,
    maxTurns: s.maxTurns,
    systemPrompt: s.systemPrompt,
    appendSystemPrompt: s.appendSystemPrompt,
    dangerouslySkipPermissions: s.dangerouslySkipPermissions,
    addDir: s.addDir,
  };
}

/** Map exit codes to human-readable error categories */
function classifyExitCode(code: number): string {
  switch (code) {
    case 0: return 'success';
    case 1: return 'runtime_error';
    case 2: return 'usage_error';
    case -1: return 'process_failure';
    default: return `unknown_error_${code}`;
  }
}

function runClaude(
  prompt: string,
  cwd: string,
  opts: Parameters<typeof buildClaudeArgs>[1] & { timeout?: number },
): Promise<{ parsed: ClaudeResult | null; stdout: string; stderr: string; code: number; errorCategory?: string }> {
  return new Promise((resolve) => {
    const args = buildClaudeArgs(prompt, opts);
    const proc = spawn(CLAUDE_BIN, args, {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Track the process for zombie cleanup
    trackProcess(proc);

    let stdout = '';
    let stderr = '';
    const MAX_OUTPUT = 50 * 1024 * 1024; // 50MB max output buffer

    proc.stdout!.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString();
    });
    proc.stderr!.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString();
    });

    const timeout = Math.min(opts.timeout || 120_000, 300_000); // cap at 5 minutes
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      // Give it 3s to terminate gracefully, then SIGKILL
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 3000);
      resolve({
        parsed: null,
        stdout,
        stderr: stderr + '\nProcess timed out after ' + timeout + 'ms',
        code: -1,
        errorCategory: 'timeout',
      });
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const exitCode = code ?? -1;
      let parsed: ClaudeResult | null = null;
      try {
        parsed = JSON.parse(stdout) as ClaudeResult;
      } catch { /* not valid JSON */ }

      if (exitCode !== 0 && !parsed) {
        // Non-zero exit with no parseable output — return structured error
        resolve({
          parsed: null,
          stdout,
          stderr,
          code: exitCode,
          errorCategory: classifyExitCode(exitCode),
        });
      } else {
        resolve({ parsed, stdout, stderr, code: exitCode });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        parsed: null,
        stdout,
        stderr: `Process spawn error: ${err.message}`,
        code: -1,
        errorCategory: 'spawn_error',
      });
    });

    proc.stdin!.end();
  });
}

function execCommand(
  command: string,
  cwd?: string,
  timeout = 30_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    exec(command, { cwd: cwd || process.cwd(), timeout, maxBuffer: 5 * 1024 * 1024, shell: '/bin/bash' }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        code: err ? (err as NodeJS.ErrnoException & { code?: number }).code as unknown as number || 1 : 0,
      });
    });
  });
}

/** Safe glob pattern: alphanumeric, slashes, dots, asterisks, question marks, brackets, hyphens, underscores */
const SAFE_GLOB_RE = /^[a-zA-Z0-9\/.* ?[\]_-]+$/;

function expandGlobs(patterns: string[], basePath: string): string[] {
  const files: string[] = [];
  for (const pattern of patterns) {
    // Reject patterns with shell metacharacters to prevent command injection
    if (!SAFE_GLOB_RE.test(pattern)) {
      console.warn(`[SECURITY] Rejected unsafe glob pattern: ${pattern.substring(0, 100)}`);
      continue;
    }
    try {
      const result = require('node:child_process')
        .execSync(`bash -O globstar -c 'for f in ${pattern}; do [ -f "$f" ] && echo "$f"; done'`, {
          cwd: basePath,
          encoding: 'utf-8' as BufferEncoding,
          timeout: 10_000,
          maxBuffer: 5 * 1024 * 1024,
        }) as string;
      for (const f of result.trim().split('\n')) {
        if (f) files.push(path.resolve(basePath, f));
      }
    } catch { /* pattern matched nothing */ }
  }
  return [...new Set(files)];
}

function makeStats(): SessionStats {
  return {
    turns: 0,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    startTime: Date.now(),
    lastActivity: new Date().toISOString(),
  };
}

// ─── Route Handlers ──────────────────────────────────────────────────────────

// POST /connect
const handleConnect: RouteHandler = async (_req, res) => {
  try {
    fs.accessSync(CLAUDE_BIN, fs.constants.X_OK);
  } catch {
    return sendJson(res, 200, {
      ok: false,
      error: `Claude binary not found at ${CLAUDE_BIN}. Set CLAUDE_BIN env var.`,
    });
  }
  connected = true;
  sendJson(res, 200, {
    ok: true,
    status: 'connected',
    server: { name: 'claude-code-backend', version: '1.0.0', bin: CLAUDE_BIN },
    tools: KNOWN_TOOLS.length,
  });
};

// POST /disconnect
const handleDisconnect: RouteHandler = async (_req, res) => {
  for (const [, s] of sessions) {
    if (s.activeProcess) {
      s.activeProcess.kill('SIGTERM');
      s.activeProcess = null;
    }
  }
  sessions.clear();
  connected = false;
  sendJson(res, 200, { ok: true });
};

// GET /tools
const handleTools: RouteHandler = async (_req, res) => {
  if (!connected) {
    return sendJson(res, 200, { ok: false, error: 'Not connected' });
  }
  sendJson(res, 200, { ok: true, tools: KNOWN_TOOLS });
};

// POST /bash
const handleBash: RouteHandler = async (_req, res, body) => {
  const cmdCheck = validateString(body.command, 'command', MAX_COMMAND_LENGTH);
  if (!cmdCheck.valid) return sendJson(res, 400, { ok: false, error: cmdCheck.error });
  const command = cmdCheck.value;

  // Block dangerous shell metacharacters to prevent command injection
  if (DANGEROUS_SHELL_CHARS.test(command)) {
    return sendJson(res, 400, {
      ok: false,
      error: 'Command contains disallowed shell metacharacters (;|&`$(){}!#<>). Use individual commands instead.',
    });
  }

  const { stdout, stderr } = await execCommand(command, undefined, 30_000);
  sendJson(res, 200, { ok: true, result: { stdout, stderr } });
};

// POST /read
const handleRead: RouteHandler = async (_req, res, body) => {
  const pathCheck = validateFilePath(body.file_path, ALLOWED_READ_DIRS);
  if (!pathCheck.valid) return sendJson(res, 400, { ok: false, error: pathCheck.error });

  try {
    const content = await readFile(pathCheck.resolved, 'utf-8');
    sendJson(res, 200, { ok: true, result: { type: 'file', file: { content } } });
  } catch (err) {
    sendJson(res, 200, { ok: false, error: (err as Error).message });
  }
};

// POST /call
const handleCall: RouteHandler = async (_req, res, body) => {
  const toolCheck = validateString(body.tool, 'tool', 100);
  if (!toolCheck.valid) return sendJson(res, 400, { ok: false, error: toolCheck.error });
  const tool = toolCheck.value;
  const args = body.args as Record<string, unknown> || {};

  const prompt = `Use the ${tool} tool with these exact arguments: ${JSON.stringify(args)}. Return only the tool output, nothing else.`;
  const { parsed, stderr, code, errorCategory } = await runClaude(prompt, process.cwd(), {
    permissionMode: 'bypassPermissions',
    outputFormat: 'json',
  });

  if (parsed?.result !== undefined) {
    // Try to parse the result as JSON in case Claude returned structured data
    let result: unknown = parsed.result;
    try {
      result = JSON.parse(parsed.result as string);
    } catch { /* keep as string */ }
    sendJson(res, 200, { ok: true, result });
  } else {
    sendJson(res, 200, {
      ok: false,
      error: stderr || 'Claude invocation failed',
      exitCode: code,
      errorCategory,
      stderr: stderr || undefined,
    });
  }
};

// GET /sessions — scan ~/.claude/projects/ JSONL files
const handleSessions: RouteHandler = async (_req, res) => {
  const projectsDir = path.join(CLAUDE_HOME, 'projects');
  const results: Array<{
    sessionId: string;
    summary?: string;
    projectPath?: string;
    modified?: string;
    messageCount?: number;
  }> = [];

  try {
    const dirs = await readdir(projectsDir);
    for (const dir of dirs) {
      const dirPath = path.join(projectsDir, dir);
      const dirStat = await stat(dirPath).catch(() => null);
      if (!dirStat?.isDirectory()) continue;

      const files = await readdir(dirPath).catch(() => []);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const filePath = path.join(dirPath, file);
        const fileStat = await stat(filePath).catch(() => null);
        if (!fileStat) continue;

        const sessionId = file.replace('.jsonl', '');
        let messageCount = 0;
        let summary: string | undefined;

        try {
          const content = await readFile(filePath, 'utf-8');
          const lines = content.trim().split('\n').filter(Boolean);
          messageCount = lines.length;
          // Try to extract summary from first user message
          for (const line of lines.slice(0, 5)) {
            try {
              const evt = JSON.parse(line);
              if (evt.type === 'human' || evt.role === 'user') {
                const text = typeof evt.message === 'string'
                  ? evt.message
                  : evt.message?.content?.[0]?.text;
                if (text) {
                  summary = text.substring(0, 100);
                  break;
                }
              }
            } catch { /* skip malformed lines */ }
          }
        } catch { /* skip unreadable files */ }

        // Decode project path from dir name (- → /)
        const projectPath = '/' + dir.replace(/^-/, '').replace(/-/g, '/');

        results.push({
          sessionId,
          summary,
          projectPath,
          modified: fileStat.mtime.toISOString(),
          messageCount,
        });
      }
    }
  } catch { /* projects dir doesn't exist */ }

  results.sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
  sendJson(res, 200, { ok: true, sessions: results.slice(0, 50) });
};

// POST /batch-read
const handleBatchRead: RouteHandler = async (_req, res, body) => {
  const patterns = body.patterns as string[];
  const basePath = (body.basePath as string) || process.cwd();

  if (!Array.isArray(patterns) || patterns.length === 0) {
    return sendJson(res, 400, { ok: false, error: 'Missing patterns array' });
  }
  if (patterns.length > 50) {
    return sendJson(res, 400, { ok: false, error: 'Too many patterns (max 50)' });
  }
  // Validate basePath
  const bpCheck = validateFilePath(basePath, ALLOWED_READ_DIRS);
  if (!bpCheck.valid) return sendJson(res, 400, { ok: false, error: bpCheck.error });

  const filePaths = expandGlobs(patterns, basePath);
  const files: Array<{ path: string; content: string; error?: string }> = [];

  for (const fp of filePaths) {
    try {
      const content = await readFile(fp, 'utf-8');
      files.push({ path: fp, content });
    } catch (err) {
      files.push({ path: fp, content: '', error: (err as Error).message });
    }
  }

  sendJson(res, 200, { ok: true, files });
};

// POST /resume
const handleResume: RouteHandler = async (_req, res, body) => {
  const sidCheck = validateString(body.sessionId, 'sessionId', 256);
  if (!sidCheck.valid) return sendJson(res, 400, { ok: false, error: sidCheck.error });
  const promptCheck = validateString(body.prompt, 'prompt', MAX_MESSAGE_LENGTH);
  if (!promptCheck.valid) return sendJson(res, 400, { ok: false, error: promptCheck.error });

  const sessionId = sidCheck.value;
  const prompt = promptCheck.value;
  const cwd = (body.cwd as string) || process.cwd();

  const { parsed, stderr, code, errorCategory } = await runClaude(prompt, cwd, {
    sessionId,
    outputFormat: 'json',
  });

  if (parsed) {
    sendJson(res, 200, { ok: true, output: parsed.result || '', stderr });
  } else {
    sendJson(res, 200, {
      ok: false,
      error: stderr || 'Claude invocation failed',
      exitCode: code,
      errorCategory,
      stderr: stderr || undefined,
    });
  }
};

// POST /continue
const handleContinue: RouteHandler = async (_req, res, body) => {
  const promptCheck = validateString(body.prompt, 'prompt', MAX_MESSAGE_LENGTH);
  if (!promptCheck.valid) return sendJson(res, 400, { ok: false, error: promptCheck.error });

  const prompt = promptCheck.value;
  const cwd = (body.cwd as string) || process.cwd();

  const { parsed, stderr, code, errorCategory } = await runClaude(prompt, cwd, {
    continueSession: true,
    outputFormat: 'json',
  });

  if (parsed) {
    sendJson(res, 200, { ok: true, output: parsed.result || '', stderr });
  } else {
    sendJson(res, 200, {
      ok: false,
      error: stderr || 'Claude invocation failed',
      exitCode: code,
      errorCategory,
      stderr: stderr || undefined,
    });
  }
};

// POST /session/start
const handleSessionStart: RouteHandler = async (_req, res, body) => {
  if (!isValidSessionName(body.name)) {
    return sendJson(res, 400, { ok: false, error: 'Invalid session name. Must be 1-128 chars: alphanumeric, hyphens, underscores only.' });
  }
  const name = body.name as string;

  if (sessions.has(name)) {
    return sendJson(res, 200, { ok: false, error: `Session '${name}' already exists` });
  }

  const claudeSessionId = (body.customSessionId as string) || (body.sessionId as string) || randomUUID();
  const cwd = (body.cwd as string) || process.cwd();

  const session: SessionConfig = {
    name,
    claudeSessionId,
    cwd,
    created: new Date().toISOString(),
    model: body.model as string | undefined,
    baseUrl: body.baseUrl as string | undefined,
    permissionMode: (body.permissionMode as string) || 'acceptEdits',
    allowedTools: body.allowedTools as string[] | undefined,
    disallowedTools: body.disallowedTools as string[] | undefined,
    tools: body.tools as string[] | undefined,
    maxTurns: body.maxTurns as number | undefined,
    maxBudgetUsd: body.maxBudgetUsd as number | undefined,
    systemPrompt: body.systemPrompt as string | undefined,
    appendSystemPrompt: body.appendSystemPrompt as string | undefined,
    dangerouslySkipPermissions: body.dangerouslySkipPermissions as boolean | undefined,
    agents: body.agents as SessionConfig['agents'],
    agent: body.agent as string | undefined,
    addDir: body.addDir as string[] | undefined,
    paused: false,
    stats: makeStats(),
    history: [],
    activeProcess: null,
  };

  sessions.set(name, session);
  sendJson(res, 200, { ok: true, claudeSessionId });
};

// POST /session/send
const handleSessionSend: RouteHandler = async (_req, res, body) => {
  if (!isValidSessionName(body.name)) {
    return sendJson(res, 400, { ok: false, error: 'Invalid session name' });
  }
  const msgCheck = validateString(body.message, 'message', MAX_MESSAGE_LENGTH);
  if (!msgCheck.valid) return sendJson(res, 400, { ok: false, error: msgCheck.error });

  const name = body.name as string;
  const message = msgCheck.value;
  const timeout = Math.min((body.timeout as number) || 120_000, 300_000); // cap at 5 min

  const session = sessions.get(name);
  if (!session) return sendJson(res, 200, { ok: false, error: `Session '${name}' not found` });
  if (session.paused) return sendJson(res, 200, { ok: false, error: `Session '${name}' is paused` });

  // Record user message in history
  session.history.push({
    time: new Date().toISOString(),
    type: 'human',
    event: { message: { content: [{ type: 'text', text: message }] } },
  });

  const opts = sessionClaudeOpts(session);
  const { parsed, stderr, code, errorCategory } = await runClaude(message, session.cwd, {
    ...opts,
    outputFormat: 'json',
    timeout,
  });

  if (parsed) {
    // Update stats
    session.stats.turns += parsed.num_turns || 1;
    session.stats.lastActivity = new Date().toISOString();
    if (parsed.session_id) session.claudeSessionId = parsed.session_id;

    // Record assistant response in history
    session.history.push({
      time: new Date().toISOString(),
      type: 'assistant',
      event: { message: { content: [{ type: 'text', text: parsed.result || '' }] } },
    });

    sessions.markDirty();
    sendJson(res, 200, { ok: true, response: parsed.result || '' });
  } else {
    sendJson(res, 200, {
      ok: false,
      error: stderr || 'Claude invocation failed',
      exitCode: code,
      errorCategory,
      stderr: stderr || undefined,
    });
  }
};

// POST /session/send-stream
const handleSessionSendStream: RouteHandler = async (req, res, body) => {
  if (!isValidSessionName(body.name)) {
    return sendJson(res, 400, { ok: false, error: 'Invalid session name' });
  }
  const msgCheck = validateString(body.message, 'message', MAX_MESSAGE_LENGTH);
  if (!msgCheck.valid) return sendJson(res, 400, { ok: false, error: msgCheck.error });

  const name = body.name as string;
  const message = msgCheck.value;
  const timeout = Math.min((body.timeout as number) || 120_000, 300_000); // cap at 5 min

  const session = sessions.get(name);
  if (!session) return sendJson(res, 200, { ok: false, error: `Session '${name}' not found` });
  if (session.paused) return sendJson(res, 200, { ok: false, error: `Session '${name}' is paused` });

  // Record user message
  session.history.push({
    time: new Date().toISOString(),
    type: 'human',
    event: { message: { content: [{ type: 'text', text: message }] } },
  });

  // Set up SSE headers (including nginx proxy buffering bypass)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });

  // Send retry directive so clients reconnect after 3s on disconnect
  res.write('retry: 3000\n\n');

  // Incrementing event ID for client reconnection (Last-Event-ID support)
  let eventId = 0;

  // Track whether the stream has been cleaned up to avoid double-cleanup
  let cleaned = false;

  function writeSSE(event: string, data: object): void {
    if (cleaned) return;
    eventId++;
    res.write(`id: ${eventId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // Send initial status
  writeSSE('status', { status: 'thinking' });

  // Heartbeat to prevent proxy/load balancer timeouts (every 15s)
  const heartbeatInterval = setInterval(() => {
    if (cleaned) return;
    res.write(': heartbeat\n\n');
  }, 15_000);

  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeatInterval);
    clearTimeout(timer);
    session!.activeProcess = null;
  }

  const opts = sessionClaudeOpts(session);
  const args = buildClaudeArgs(message, { ...opts, outputFormat: 'stream-json' });

  const proc = spawn(CLAUDE_BIN, args, {
    cwd: session.cwd,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Track the process for zombie cleanup
  trackProcess(proc);
  session.activeProcess = proc;

  const timer = setTimeout(() => {
    proc.kill('SIGTERM');
    writeSSE('error', { type: 'error', error: 'Process timed out' });
    cleanup();
    res.end();
  }, timeout);

  let buffer = '';
  let fullText = '';

  proc.stdout!.on('data', (chunk: Buffer) => {
    if (cleaned) return;
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        processStreamEvent(evt, session, writeSSE, (text) => { fullText += text; });
      } catch { /* skip malformed lines */ }
    }
  });

  proc.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) {
      writeSSE('error', { type: 'error', error: text });
    }
  });

  proc.on('close', () => {
    // Process any remaining buffer before cleanup
    if (buffer.trim() && !cleaned) {
      try {
        const evt = JSON.parse(buffer);
        processStreamEvent(evt, session, writeSSE, (text) => { fullText += text; });
      } catch { /* ignore */ }
    }

    // Record assistant response
    if (fullText) {
      session.history.push({
        time: new Date().toISOString(),
        type: 'assistant',
        event: { message: { content: [{ type: 'text', text: fullText }] } },
      });
    }

    sessions.markDirty();
    writeSSE('done', {});
    cleanup();
    res.end();
  });

  proc.on('error', (err) => {
    writeSSE('error', { type: 'error', error: err.message });
    cleanup();
    res.end();
  });

  proc.stdin!.end();

  // Handle client disconnect — kill child process and clean up
  req.on('close', () => {
    if (!proc.killed) {
      proc.kill('SIGTERM');
    }
    cleanup();
  });
};

/** SSE write function type used by processStreamEvent */
type SSEWriter = (event: string, data: object) => void;

function processStreamEvent(
  evt: Record<string, unknown>,
  session: SessionConfig,
  writeSSE: SSEWriter,
  collectText: (text: string) => void,
): void {
  const type = evt.type as string;

  if (type === 'content_block_start') {
    const block = evt.content_block as Record<string, unknown> | undefined;
    if (block?.type === 'tool_use') {
      session.stats.toolCalls++;
      writeSSE('message', { type: 'tool_use', tool: block.name });
    }
  } else if (type === 'content_block_delta') {
    const delta = evt.delta as Record<string, unknown> | undefined;
    if (delta?.type === 'text_delta' && delta.text) {
      const text = delta.text as string;
      collectText(text);
      writeSSE('message', { type: 'text', text });
    }
  } else if (type === 'assistant') {
    // Full message event — extract text and tool_use blocks
    writeSSE('status', { status: 'responding' });
    const msg = evt.message as Record<string, unknown> | undefined;
    const content = msg?.content as Array<Record<string, unknown>> | undefined;
    if (content) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          const text = block.text as string;
          collectText(text);
          writeSSE('message', { type: 'text', text });
        } else if (block.type === 'tool_use') {
          session.stats.toolCalls++;
          writeSSE('message', { type: 'tool_use', tool: block.name });
        }
      }
    }
  } else if (type === 'tool') {
    writeSSE('message', { type: 'tool_result' });
  } else if (type === 'result') {
    // Final result event
    const result = evt as ClaudeResult;
    session.stats.turns += result.num_turns || 1;
    session.stats.lastActivity = new Date().toISOString();
    if (result.session_id) session.claudeSessionId = result.session_id;
    // If result has text not yet streamed, emit it
    if (result.result && !result.is_error) {
      // result.result is the final aggregated text — may already have been streamed
    }
  }
}

// GET /session/list
const handleSessionList: RouteHandler = async (_req, res) => {
  const list = [];
  for (const [, s] of sessions) {
    list.push({
      name: s.name,
      cwd: s.cwd,
      created: s.created,
      isReady: !s.paused && !s.activeProcess,
    });
  }
  sendJson(res, 200, { ok: true, sessions: list });
};

// POST /session/stop
const handleSessionStop: RouteHandler = async (_req, res, body) => {
  const name = body.name as string;
  if (!name) return sendJson(res, 200, { ok: false, error: 'Missing name' });

  const session = sessions.get(name);
  if (!session) return sendJson(res, 200, { ok: false, error: `Session '${name}' not found` });

  if (session.activeProcess) {
    session.activeProcess.kill('SIGTERM');
    session.activeProcess = null;
  }
  sessions.delete(name);
  sendJson(res, 200, { ok: true });
};

// POST /session/status
const handleSessionStatus: RouteHandler = async (_req, res, body) => {
  const name = body.name as string;
  if (!name) return sendJson(res, 200, { ok: false, error: 'Missing name' });

  const s = sessions.get(name);
  if (!s) return sendJson(res, 200, { ok: false, error: `Session '${name}' not found` });

  const uptime = Math.round((Date.now() - s.stats.startTime) / 1000);
  sendJson(res, 200, {
    ok: true,
    claudeSessionId: s.claudeSessionId,
    cwd: s.cwd,
    created: s.created,
    stats: {
      turns: s.stats.turns,
      toolCalls: s.stats.toolCalls,
      tokensIn: s.stats.tokensIn,
      tokensOut: s.stats.tokensOut,
      uptime,
      lastActivity: s.stats.lastActivity,
      isReady: !s.paused && !s.activeProcess,
    },
  });
};

// POST /session/history
const handleSessionHistory: RouteHandler = async (_req, res, body) => {
  const name = body.name as string;
  const limit = (body.limit as number) || 20;
  if (!name) return sendJson(res, 200, { ok: false, error: 'Missing name' });

  const s = sessions.get(name);
  if (!s) return sendJson(res, 200, { ok: false, error: `Session '${name}' not found` });

  const history = s.history.slice(-limit);
  sendJson(res, 200, { ok: true, count: s.history.length, history });
};

// POST /session/pause
const handleSessionPause: RouteHandler = async (_req, res, body) => {
  const name = body.name as string;
  if (!name) return sendJson(res, 200, { ok: false, error: 'Missing name' });

  const s = sessions.get(name);
  if (!s) return sendJson(res, 200, { ok: false, error: `Session '${name}' not found` });

  s.paused = true;
  if (s.activeProcess) {
    s.activeProcess.kill('SIGTERM');
    s.activeProcess = null;
  }
  sessions.markDirty();
  sendJson(res, 200, { ok: true });
};

// POST /session/resume
const handleSessionResume: RouteHandler = async (_req, res, body) => {
  const name = body.name as string;
  if (!name) return sendJson(res, 200, { ok: false, error: 'Missing name' });

  const s = sessions.get(name);
  if (!s) return sendJson(res, 200, { ok: false, error: `Session '${name}' not found` });

  s.paused = false;
  sessions.markDirty();
  sendJson(res, 200, { ok: true });
};

// POST /session/fork
const handleSessionFork: RouteHandler = async (_req, res, body) => {
  if (!isValidSessionName(body.name) || !isValidSessionName(body.newName)) {
    return sendJson(res, 400, { ok: false, error: 'Invalid session name. Must be 1-128 chars: alphanumeric, hyphens, underscores only.' });
  }
  const name = body.name as string;
  const newName = body.newName as string;

  const s = sessions.get(name);
  if (!s) return sendJson(res, 200, { ok: false, error: `Session '${name}' not found` });
  if (sessions.has(newName)) return sendJson(res, 200, { ok: false, error: `Session '${newName}' already exists` });

  const newId = randomUUID();
  const forked: SessionConfig = {
    ...s,
    name: newName,
    claudeSessionId: newId,
    created: new Date().toISOString(),
    paused: false,
    stats: makeStats(),
    history: [...s.history],
    activeProcess: null,
  };

  sessions.set(newName, forked);
  sendJson(res, 200, { ok: true, claudeSessionId: newId });
};

// POST /session/search
const handleSessionSearch: RouteHandler = async (_req, res, body) => {
  const query = (body.query as string)?.toLowerCase();
  const project = body.project as string;
  const since = body.since as string;
  const limit = (body.limit as number) || 20;

  let results: Array<{ name: string; cwd?: string; created?: string; summary?: string }> = [];

  // Search in-memory sessions
  for (const [, s] of sessions) {
    let match = true;

    if (query && !s.name.toLowerCase().includes(query) && !s.cwd.toLowerCase().includes(query)) {
      match = false;
    }
    if (project && !s.cwd.includes(project)) {
      match = false;
    }
    if (since) {
      const sinceDate = parseSince(since);
      if (sinceDate && new Date(s.created) < sinceDate) match = false;
    }

    if (match) {
      const lastMsg = [...s.history].reverse().find((h: HistoryEntry) => h.type === 'human');
      results.push({
        name: s.name,
        cwd: s.cwd,
        created: s.created,
        summary: lastMsg?.event.message?.content?.[0]?.text?.substring(0, 100),
      });
    }
  }

  results = results.slice(0, limit);
  sendJson(res, 200, { ok: true, sessions: results });
};

function parseSince(since: string): Date | null {
  // Handle relative times: "1h", "2d", "30m"
  const match = since.match(/^(\d+)([hdm])$/);
  if (match) {
    const n = parseInt(match[1]);
    const unit = match[2];
    const ms = unit === 'h' ? n * 3600_000 : unit === 'd' ? n * 86400_000 : n * 60_000;
    return new Date(Date.now() - ms);
  }
  // Try as ISO date
  const d = new Date(since);
  return isNaN(d.getTime()) ? null : d;
}

// POST /session/restart
const handleSessionRestart: RouteHandler = async (_req, res, body) => {
  const name = body.name as string;
  if (!name) return sendJson(res, 200, { ok: false, error: 'Missing name' });

  const s = sessions.get(name);
  if (!s) return sendJson(res, 200, { ok: false, error: `Session '${name}' not found` });

  // Kill any active process
  if (s.activeProcess) {
    s.activeProcess.kill('SIGTERM');
    s.activeProcess = null;
  }

  // Reset with new session ID
  s.claudeSessionId = randomUUID();
  s.paused = false;
  s.stats = makeStats();
  s.history = [];

  sessions.markDirty();
  sendJson(res, 200, { ok: true });
};

// ─── Router ──────────────────────────────────────────────────────────────────

const routes: Record<string, { method: string; handler: RouteHandler }> = {
  '/connect':            { method: 'POST', handler: handleConnect },
  '/disconnect':         { method: 'POST', handler: handleDisconnect },
  '/tools':              { method: 'GET',  handler: handleTools },
  '/bash':               { method: 'POST', handler: handleBash },
  '/read':               { method: 'POST', handler: handleRead },
  '/call':               { method: 'POST', handler: handleCall },
  '/sessions':           { method: 'GET',  handler: handleSessions },
  '/batch-read':         { method: 'POST', handler: handleBatchRead },
  '/resume':             { method: 'POST', handler: handleResume },
  '/continue':           { method: 'POST', handler: handleContinue },
  '/session/start':      { method: 'POST', handler: handleSessionStart },
  '/session/send':       { method: 'POST', handler: handleSessionSend },
  '/session/send-stream':{ method: 'POST', handler: handleSessionSendStream },
  '/session/list':       { method: 'GET',  handler: handleSessionList },
  '/session/stop':       { method: 'POST', handler: handleSessionStop },
  '/session/status':     { method: 'POST', handler: handleSessionStatus },
  '/session/history':    { method: 'POST', handler: handleSessionHistory },
  '/session/pause':      { method: 'POST', handler: handleSessionPause },
  '/session/resume':     { method: 'POST', handler: handleSessionResume },
  '/session/fork':       { method: 'POST', handler: handleSessionFork },
  '/session/search':     { method: 'POST', handler: handleSessionSearch },
  '/session/restart':    { method: 'POST', handler: handleSessionRestart },
};

// ─── Server ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // Reject new requests during shutdown
  if (isShuttingDown) {
    return sendJson(res, 503, { ok: false, error: 'Server is shutting down' });
  }

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const url = req.url || '';
  if (!url.startsWith(PREFIX)) {
    return sendJson(res, 404, { ok: false, error: 'Not found' });
  }

  const endpoint = url.slice(PREFIX.length) || '/';
  const route = routes[endpoint];

  if (!route) {
    return sendJson(res, 404, { ok: false, error: `Unknown endpoint: ${endpoint}` });
  }

  if (req.method !== route.method) {
    return sendJson(res, 405, { ok: false, error: `Method ${req.method} not allowed` });
  }

  // Rate limiting
  const clientIp = getClientIp(req);
  const rlGroup = endpointRateLimitGroup[endpoint] || 'write';
  if (!checkRateLimit(clientIp, rlGroup)) {
    return sendJson(res, 429, {
      ok: false,
      error: `Rate limit exceeded. Max ${RATE_LIMITS[rlGroup]} requests per minute for this endpoint group.`,
    });
  }

  inFlightRequests++;
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    await route.handler(req, res, body);
  } catch (err) {
    if (!res.headersSent) {
      if (err instanceof BodyTooLargeError) {
        sendJson(res, 413, { ok: false, error: err.message });
      } else if (err instanceof MalformedJsonError) {
        sendJson(res, 400, { ok: false, error: err.message });
      } else {
        console.error(`Error handling ${endpoint}:`, err);
        sendJson(res, 500, { ok: false, error: (err as Error).message });
      }
    }
  } finally {
    inFlightRequests--;
  }
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────

function killAllTrackedProcesses(): void {
  for (const proc of trackedProcesses) {
    try {
      if (!proc.killed) proc.kill('SIGTERM');
    } catch { /* already dead */ }
  }
  // After 3s, force-kill anything still alive
  setTimeout(() => {
    for (const proc of trackedProcesses) {
      try {
        if (!proc.killed) proc.kill('SIGKILL');
      } catch { /* already dead */ }
    }
    trackedProcesses.clear();
  }, 3000);
}

function shutdown(): void {
  if (isShuttingDown) return; // Prevent double-shutdown
  isShuttingDown = true;
  console.log('\nShutting down gracefully...');

  // 1. Stop accepting new connections
  server.close(() => {
    console.log('Server closed, no more connections.');
  });

  // 2. Wait for in-flight requests to finish (up to 10s)
  const shutdownStart = Date.now();
  const SHUTDOWN_TIMEOUT = 10_000;

  const waitForInflight = setInterval(() => {
    const elapsed = Date.now() - shutdownStart;
    if (inFlightRequests <= 0 || elapsed >= SHUTDOWN_TIMEOUT) {
      clearInterval(waitForInflight);

      if (inFlightRequests > 0) {
        console.log(`Shutdown timeout: ${inFlightRequests} requests still in-flight, forcing exit.`);
      } else {
        console.log('All in-flight requests completed.');
      }

      // 3. Kill all session active processes and flush to disk
      for (const [, s] of sessions) {
        if (s.activeProcess) {
          try { s.activeProcess.kill('SIGTERM'); } catch { /* ignore */ }
          s.activeProcess = null;
        }
      }
      // Persist sessions to disk before we tear everything down
      sessions.flush();

      // 4. Kill all tracked child processes
      killAllTrackedProcesses();

      // 5. Clear the zombie cleanup interval
      clearInterval(zombieCleanupInterval);

      // 6. Exit after giving SIGKILL time to propagate
      setTimeout(() => process.exit(0), 3500);
    }
  }, 200);

  // Hard deadline: force exit after 15s no matter what
  setTimeout(() => {
    console.error('Hard shutdown deadline reached, forcing exit.');
    process.exit(1);
  }, 15_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ─── Uncaught Exception / Rejection Handling ─────────────────────────────────

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION] Server will continue running:', err);
  // Do not crash — log and continue
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION] Server will continue running:', reason);
  // Do not crash — log and continue
});

// ─── Start ───────────────────────────────────────────────────────────────────

server.listen(PORT, HOST, () => {
  console.log(`claude-code-server listening on http://${HOST}:${PORT}`);
  console.log(`API prefix: ${PREFIX}`);
  console.log(`Claude binary: ${CLAUDE_BIN}`);
  console.log(`Endpoints: ${Object.keys(routes).length}`);
});
