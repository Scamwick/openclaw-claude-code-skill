#!/usr/bin/env node
/**
 * Backend API server for claude-code-skill CLI.
 * Spawns `claude` CLI processes to fulfill requests.
 * In-memory session store for persistent sessions.
 */

import http from 'node:http';
import { spawn, exec, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.CLAUDE_CODE_PORT || '18795');
const HOST = process.env.CLAUDE_CODE_HOST || '127.0.0.1';
const PREFIX = '/backend-api/claude-code';
const HOME = process.env.HOME || '/tmp';
const CLAUDE_HOME = path.join(HOME, '.claude');

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

interface SessionConfig {
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
  activeProcess: ChildProcess | null;
}

interface SessionStats {
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  startTime: number;
  lastActivity: string;
}

interface HistoryEntry {
  time: string;
  type: string;
  event: {
    message?: {
      content?: Array<{ type: string; text?: string; name?: string }>;
    };
  };
}

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

const sessions = new Map<string, SessionConfig>();
let connected = false;

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

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
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

function runClaude(
  prompt: string,
  cwd: string,
  opts: Parameters<typeof buildClaudeArgs>[1] & { timeout?: number },
): Promise<{ parsed: ClaudeResult | null; stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const args = buildClaudeArgs(prompt, opts);
    const proc = spawn(CLAUDE_BIN, args, {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timeout = opts.timeout || 120_000;
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ parsed: null, stdout, stderr: stderr + '\nProcess timed out', code: -1 });
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      let parsed: ClaudeResult | null = null;
      try {
        parsed = JSON.parse(stdout) as ClaudeResult;
      } catch { /* not valid JSON */ }
      resolve({ parsed, stdout, stderr, code: code ?? -1 });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ parsed: null, stdout, stderr: err.message, code: -1 });
    });

    proc.stdin!.end();
  });
}

function execCommand(
  command: string,
  cwd?: string,
  timeout = 60_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    exec(command, { cwd: cwd || process.cwd(), timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        code: err ? (err as NodeJS.ErrnoException & { code?: number }).code as unknown as number || 1 : 0,
      });
    });
  });
}

function expandGlobs(patterns: string[], basePath: string): string[] {
  const files: string[] = [];
  for (const pattern of patterns) {
    try {
      const result = require('node:child_process')
        .execSync(`bash -O globstar -c 'for f in ${pattern}; do [ -f "$f" ] && echo "$f"; done'`, {
          cwd: basePath,
          encoding: 'utf-8' as BufferEncoding,
          timeout: 10_000,
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
  const command = body.command as string;
  if (!command) return sendJson(res, 200, { ok: false, error: 'Missing command' });

  const { stdout, stderr } = await execCommand(command);
  sendJson(res, 200, { ok: true, result: { stdout, stderr } });
};

// POST /read
const handleRead: RouteHandler = async (_req, res, body) => {
  const filePath = body.file_path as string;
  if (!filePath) return sendJson(res, 200, { ok: false, error: 'Missing file_path' });

  try {
    const content = await readFile(filePath, 'utf-8');
    sendJson(res, 200, { ok: true, result: { type: 'file', file: { content } } });
  } catch (err) {
    sendJson(res, 200, { ok: false, error: (err as Error).message });
  }
};

// POST /call
const handleCall: RouteHandler = async (_req, res, body) => {
  const tool = body.tool as string;
  const args = body.args as Record<string, unknown> || {};
  if (!tool) return sendJson(res, 200, { ok: false, error: 'Missing tool' });

  const prompt = `Use the ${tool} tool with these exact arguments: ${JSON.stringify(args)}. Return only the tool output, nothing else.`;
  const { parsed, stderr } = await runClaude(prompt, process.cwd(), {
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
    sendJson(res, 200, { ok: false, error: stderr || 'Claude invocation failed' });
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
    return sendJson(res, 200, { ok: false, error: 'Missing patterns array' });
  }

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
  const sessionId = body.sessionId as string;
  const prompt = body.prompt as string;
  const cwd = (body.cwd as string) || process.cwd();

  if (!sessionId || !prompt) {
    return sendJson(res, 200, { ok: false, error: 'Missing sessionId or prompt' });
  }

  const { parsed, stderr } = await runClaude(prompt, cwd, {
    sessionId,
    outputFormat: 'json',
  });

  if (parsed) {
    sendJson(res, 200, { ok: true, output: parsed.result || '', stderr });
  } else {
    sendJson(res, 200, { ok: false, error: stderr || 'Claude invocation failed' });
  }
};

// POST /continue
const handleContinue: RouteHandler = async (_req, res, body) => {
  const prompt = body.prompt as string;
  const cwd = (body.cwd as string) || process.cwd();

  if (!prompt) return sendJson(res, 200, { ok: false, error: 'Missing prompt' });

  const { parsed, stderr } = await runClaude(prompt, cwd, {
    continueSession: true,
    outputFormat: 'json',
  });

  if (parsed) {
    sendJson(res, 200, { ok: true, output: parsed.result || '', stderr });
  } else {
    sendJson(res, 200, { ok: false, error: stderr || 'Claude invocation failed' });
  }
};

// POST /session/start
const handleSessionStart: RouteHandler = async (_req, res, body) => {
  const name = body.name as string;
  if (!name) return sendJson(res, 200, { ok: false, error: 'Missing name' });

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
  const name = body.name as string;
  const message = body.message as string;
  const timeout = (body.timeout as number) || 120_000;

  if (!name || !message) {
    return sendJson(res, 200, { ok: false, error: 'Missing name or message' });
  }

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
  const { parsed, stderr } = await runClaude(message, session.cwd, {
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

    sendJson(res, 200, { ok: true, response: parsed.result || '' });
  } else {
    sendJson(res, 200, { ok: false, error: stderr || 'Claude invocation failed' });
  }
};

// POST /session/send-stream
const handleSessionSendStream: RouteHandler = async (_req, res, body) => {
  const name = body.name as string;
  const message = body.message as string;
  const timeout = (body.timeout as number) || 120_000;

  if (!name || !message) {
    return sendJson(res, 200, { ok: false, error: 'Missing name or message' });
  }

  const session = sessions.get(name);
  if (!session) return sendJson(res, 200, { ok: false, error: `Session '${name}' not found` });
  if (session.paused) return sendJson(res, 200, { ok: false, error: `Session '${name}' is paused` });

  // Record user message
  session.history.push({
    time: new Date().toISOString(),
    type: 'human',
    event: { message: { content: [{ type: 'text', text: message }] } },
  });

  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const opts = sessionClaudeOpts(session);
  const args = buildClaudeArgs(message, { ...opts, outputFormat: 'stream-json' });

  const proc = spawn(CLAUDE_BIN, args, {
    cwd: session.cwd,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  session.activeProcess = proc;

  const timer = setTimeout(() => {
    proc.kill('SIGTERM');
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'Process timed out' })}\n\n`);
    res.end();
  }, timeout);

  let buffer = '';
  let fullText = '';

  proc.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        processStreamEvent(evt, res, session, (text) => { fullText += text; });
      } catch { /* skip malformed lines */ }
    }
  });

  proc.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: text })}\n\n`);
    }
  });

  proc.on('close', () => {
    clearTimeout(timer);
    session.activeProcess = null;

    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const evt = JSON.parse(buffer);
        processStreamEvent(evt, res, session, (text) => { fullText += text; });
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

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  });

  proc.on('error', (err) => {
    clearTimeout(timer);
    session.activeProcess = null;
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    res.end();
  });

  proc.stdin!.end();

  // Handle client disconnect
  res.on('close', () => {
    clearTimeout(timer);
    if (!proc.killed) proc.kill('SIGTERM');
  });
};

function processStreamEvent(
  evt: Record<string, unknown>,
  res: http.ServerResponse,
  session: SessionConfig,
  collectText: (text: string) => void,
): void {
  const type = evt.type as string;

  if (type === 'content_block_start') {
    const block = evt.content_block as Record<string, unknown> | undefined;
    if (block?.type === 'tool_use') {
      session.stats.toolCalls++;
      res.write(`data: ${JSON.stringify({ type: 'tool_use', tool: block.name })}\n\n`);
    }
  } else if (type === 'content_block_delta') {
    const delta = evt.delta as Record<string, unknown> | undefined;
    if (delta?.type === 'text_delta' && delta.text) {
      const text = delta.text as string;
      collectText(text);
      res.write(`data: ${JSON.stringify({ type: 'text', text })}\n\n`);
    }
  } else if (type === 'assistant') {
    // Full message event — extract text and tool_use blocks
    const msg = evt.message as Record<string, unknown> | undefined;
    const content = msg?.content as Array<Record<string, unknown>> | undefined;
    if (content) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          const text = block.text as string;
          collectText(text);
          res.write(`data: ${JSON.stringify({ type: 'text', text })}\n\n`);
        } else if (block.type === 'tool_use') {
          session.stats.toolCalls++;
          res.write(`data: ${JSON.stringify({ type: 'tool_use', tool: block.name })}\n\n`);
        }
      }
    }
  } else if (type === 'tool') {
    res.write(`data: ${JSON.stringify({ type: 'tool_result' })}\n\n`);
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
  sendJson(res, 200, { ok: true });
};

// POST /session/resume
const handleSessionResume: RouteHandler = async (_req, res, body) => {
  const name = body.name as string;
  if (!name) return sendJson(res, 200, { ok: false, error: 'Missing name' });

  const s = sessions.get(name);
  if (!s) return sendJson(res, 200, { ok: false, error: `Session '${name}' not found` });

  s.paused = false;
  sendJson(res, 200, { ok: true });
};

// POST /session/fork
const handleSessionFork: RouteHandler = async (_req, res, body) => {
  const name = body.name as string;
  const newName = body.newName as string;
  if (!name || !newName) return sendJson(res, 200, { ok: false, error: 'Missing name or newName' });

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

  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    await route.handler(req, res, body);
  } catch (err) {
    console.error(`Error handling ${endpoint}:`, err);
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: (err as Error).message });
    }
  }
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────

function shutdown(): void {
  console.log('\nShutting down...');
  for (const [, s] of sessions) {
    if (s.activeProcess) {
      s.activeProcess.kill('SIGTERM');
    }
  }
  sessions.clear();
  server.close(() => process.exit(0));
  // Force exit after 5s
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ─── Start ───────────────────────────────────────────────────────────────────

server.listen(PORT, HOST, () => {
  console.log(`claude-code-server listening on http://${HOST}:${PORT}`);
  console.log(`API prefix: ${PREFIX}`);
  console.log(`Claude binary: ${CLAUDE_BIN}`);
  console.log(`Endpoints: ${Object.keys(routes).length}`);
});
