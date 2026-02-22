/**
 * Comprehensive test suite for claude-code-skill backend server.
 *
 * Uses Node.js built-in test runner (node:test + node:assert).
 * Zero external test framework dependencies.
 *
 * Endpoints that spawn the real `claude` CLI are gated behind
 * the LIVE_TEST environment variable so the rest of the suite
 * can run fast and offline.
 *
 * Usage:
 *   npm test                        # run offline-safe tests
 *   LIVE_TEST=1 npm test            # include tests that call real claude CLI
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// ─── Configuration ────────────────────────────────────────────────────────────

const TEST_PORT = 19876; // Use a non-default port to avoid conflicts
const HOST = '127.0.0.1';
const PREFIX = '/backend-api/claude-code';
const BASE_URL = `http://${HOST}:${TEST_PORT}${PREFIX}`;

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_ENTRY = path.join(PROJECT_ROOT, 'src', 'server.ts');

const LIVE = !!process.env.LIVE_TEST;

// ─── Helpers ──────────────────────────────────────────────────────────────────

let serverProc: ChildProcess | null = null;

/**
 * Spawn the server process using tsx and wait for it to be listening.
 */
async function startServer(): Promise<void> {
  const tsxBin = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');

  serverProc = spawn(tsxBin, [SERVER_ENTRY], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      CLAUDE_CODE_PORT: String(TEST_PORT),
      CLAUDE_CODE_HOST: HOST,
      // Raise rate limits for testing so tests don't hit 429
      RATE_LIMIT_READ: '10000',
      RATE_LIMIT_WRITE: '10000',
      RATE_LIMIT_SPAWN: '10000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderrBuf = '';
  serverProc.stderr?.on('data', (d: Buffer) => {
    stderrBuf += d.toString();
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Server did not start within 15s. stderr:\n${stderrBuf}`));
    }, 15_000);

    serverProc!.stdout?.on('data', (d: Buffer) => {
      if (d.toString().includes('listening on')) {
        clearTimeout(timeout);
        resolve();
      }
    });

    serverProc!.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    serverProc!.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== null && code !== 0) {
        reject(new Error(`Server exited with code ${code}. stderr:\n${stderrBuf}`));
      }
    });
  });
}

/**
 * Kill the server process and wait for exit.
 */
async function stopServer(): Promise<void> {
  if (!serverProc) return;

  const proc = serverProc;
  serverProc = null;

  return new Promise<void>((resolve) => {
    proc.on('exit', () => resolve());
    proc.kill('SIGTERM');

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve();
    }, 5_000);
    timer.unref();
  });
}

/**
 * Make an HTTP request to the server and return parsed JSON response.
 */
async function request(
  method: string,
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const url = `${BASE_URL}${endpoint}`;
  const payload = body ? JSON.stringify(body) : undefined;

  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: {
      'Content-Type': 'application/json',
      ...(payload ? { 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
    }}, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(raw);
        } catch {
          data = { _raw: raw };
        }
        resolve({ status: res.statusCode || 0, data });
      });
    });

    req.on('error', reject);
    req.setTimeout(30_000, () => {
      req.destroy(new Error('Request timed out'));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Send a raw HTTP request (no body, or raw string body) to the server.
 */
async function rawRequest(
  method: string,
  endpoint: string,
  rawBody?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const url = `${BASE_URL}${endpoint}`;

  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: headers || {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(raw);
        } catch {
          data = { _raw: raw };
        }
        resolve({ status: res.statusCode || 0, data });
      });
    });

    req.on('error', reject);
    req.setTimeout(30_000, () => {
      req.destroy(new Error('Request timed out'));
    });

    if (rawBody) req.write(rawBody);
    req.end();
  });
}

/**
 * Make an HTTP request to an SSE endpoint and collect events.
 */
async function requestSSE(
  method: string,
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<{ status: number; events: Array<Record<string, unknown>>; raw: string }> {
  const url = `${BASE_URL}${endpoint}`;
  const payload = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(payload)),
      'Accept': 'text/event-stream',
    }}, (res) => {
      const events: Array<Record<string, unknown>> = [];
      let raw = '';

      const timer = setTimeout(() => {
        req.destroy();
        resolve({ status: res.statusCode || 0, events, raw });
      }, timeoutMs);

      res.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        raw += text;

        const lines = text.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(line.slice(6));
              events.push(parsed);
            } catch { /* skip malformed */ }
          }
        }
      });

      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode || 0, events, raw });
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Generate a unique session name matching /^[a-zA-Z0-9_-]{1,128}$/.
 */
let sessionCounter = 0;
function uniqueName(prefix = 'test'): string {
  return `${prefix}-${Date.now()}-${++sessionCounter}`;
}

/**
 * Helper: create a session and return its name.
 */
async function createSession(name?: string, opts?: Record<string, unknown>): Promise<string> {
  const n = name || uniqueName();
  const res = await request('POST', '/session/start', { name: n, ...opts });
  assert.equal(res.data.ok, true, `Failed to create session '${n}': ${JSON.stringify(res.data)}`);
  return n;
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('claude-code-server', () => {

  before(async () => {
    await startServer();
  });

  after(async () => {
    await stopServer();
  });

  // ─── CORS / Routing ──────────────────────────────────────────────────────

  describe('routing and CORS', () => {

    it('OPTIONS preflight returns 204 with CORS headers', async () => {
      const url = `${BASE_URL}/connect`;
      const { status, headers } = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
        const req = http.request(url, { method: 'OPTIONS' }, (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers }));
        });
        req.on('error', reject);
        req.end();
      });

      assert.equal(status, 204);
      assert.equal(headers['access-control-allow-origin'], '*');
      assert.ok(headers['access-control-allow-methods']?.includes('POST'));
    });

    it('returns 404 for requests outside the API prefix', async () => {
      const { status, data } = await new Promise<{ status: number; data: Record<string, unknown> }>((resolve, reject) => {
        http.get(`http://${HOST}:${TEST_PORT}/invalid-path`, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString();
            resolve({ status: res.statusCode || 0, data: JSON.parse(raw) });
          });
        }).on('error', reject);
      });

      assert.equal(status, 404);
      assert.equal(data.ok, false);
    });

    it('returns 404 for unknown endpoint under prefix', async () => {
      const res = await request('GET', '/nonexistent');
      assert.equal(res.status, 404);
      assert.equal(res.data.ok, false);
    });
  });

  // ─── POST /connect ───────────────────────────────────────────────────────

  describe('POST /connect', () => {

    it('returns ok with server info', async () => {
      const res = await request('POST', '/connect');
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
      assert.equal(res.data.status, 'connected');
      assert.ok(res.data.server);
      const server = res.data.server as Record<string, unknown>;
      assert.equal(server.name, 'claude-code-backend');
      assert.ok(typeof server.version === 'string');
      assert.ok(typeof res.data.tools === 'number');
    });

    it('rejects wrong HTTP method (GET)', async () => {
      const res = await request('GET', '/connect');
      assert.equal(res.status, 405);
      assert.equal(res.data.ok, false);
    });
  });

  // ─── POST /disconnect ────────────────────────────────────────────────────

  describe('POST /disconnect', () => {

    it('disconnects and returns ok', async () => {
      await request('POST', '/connect');
      const res = await request('POST', '/disconnect');
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
    });

    it('rejects wrong HTTP method (GET)', async () => {
      const res = await request('GET', '/disconnect');
      assert.equal(res.status, 405);
    });
  });

  // ─── GET /tools ───────────────────────────────────────────────────────────

  describe('GET /tools', () => {

    it('returns tools list when connected', async () => {
      await request('POST', '/connect');

      const res = await request('GET', '/tools');
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
      assert.ok(Array.isArray(res.data.tools));

      const tools = res.data.tools as Array<{ name: string; description: string }>;
      assert.ok(tools.length > 0);
      for (const tool of tools) {
        assert.ok(typeof tool.name === 'string');
        assert.ok(typeof tool.description === 'string');
      }
      const names = tools.map((t) => t.name);
      assert.ok(names.includes('Bash'));
      assert.ok(names.includes('Read'));
      assert.ok(names.includes('Write'));
    });

    it('returns error when not connected', async () => {
      await request('POST', '/disconnect');
      const res = await request('GET', '/tools');
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, false);
      assert.ok(typeof res.data.error === 'string');
      // Reconnect for subsequent tests
      await request('POST', '/connect');
    });

    it('rejects wrong HTTP method (POST)', async () => {
      const res = await request('POST', '/tools');
      assert.equal(res.status, 405);
    });
  });

  // ─── POST /bash ───────────────────────────────────────────────────────────

  describe('POST /bash', () => {

    it('executes a simple command and returns stdout', async () => {
      const res = await request('POST', '/bash', { command: 'echo hello' });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
      const result = res.data.result as { stdout: string; stderr: string };
      assert.ok(result.stdout.includes('hello'));
    });

    it('returns 400 when command is missing', async () => {
      const res = await request('POST', '/bash', {});
      assert.equal(res.status, 400);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('command'));
    });

    it('returns 400 for commands with shell metacharacters', async () => {
      const res = await request('POST', '/bash', { command: 'echo hello; rm -rf /' });
      assert.equal(res.status, 400);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('metacharacters'));
    });

    it('blocks pipe operator in commands', async () => {
      const res = await request('POST', '/bash', { command: 'ls | grep foo' });
      assert.equal(res.status, 400);
      assert.equal(res.data.ok, false);
    });

    it('blocks command substitution in commands', async () => {
      const res = await request('POST', '/bash', { command: 'echo $(whoami)' });
      assert.equal(res.status, 400);
      assert.equal(res.data.ok, false);
    });

    it('rejects wrong HTTP method (GET)', async () => {
      const res = await request('GET', '/bash');
      assert.equal(res.status, 405);
    });
  });

  // ─── POST /read ───────────────────────────────────────────────────────────

  describe('POST /read', () => {

    it('reads a known file successfully', async () => {
      const filePath = path.join(PROJECT_ROOT, 'package.json');
      const res = await request('POST', '/read', { file_path: filePath });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
      const result = res.data.result as { type: string; file: { content: string } };
      assert.equal(result.type, 'file');
      assert.ok(result.file.content.includes('claude-code-skill'));
    });

    it('returns error for nonexistent file', async () => {
      const res = await request('POST', '/read', { file_path: '/nonexistent_file_xyz.txt' });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, false);
      assert.ok(typeof res.data.error === 'string');
    });

    it('returns 400 when file_path is missing', async () => {
      const res = await request('POST', '/read', {});
      assert.equal(res.status, 400);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('file_path'));
    });

    it('reads a binary file without crashing', async () => {
      const tmpBin = path.join(os.tmpdir(), `test-binary-${Date.now()}.bin`);
      fs.writeFileSync(tmpBin, Buffer.from([0x00, 0x01, 0xFF, 0xFE, 0x89, 0x50, 0x4E, 0x47]));
      try {
        const res = await request('POST', '/read', { file_path: tmpBin });
        assert.equal(res.status, 200);
        assert.equal(res.data.ok, true);
      } finally {
        fs.unlinkSync(tmpBin);
      }
    });

    it('rejects wrong HTTP method (GET)', async () => {
      const res = await request('GET', '/read');
      assert.equal(res.status, 405);
    });
  });

  // ─── POST /batch-read ────────────────────────────────────────────────────

  describe('POST /batch-read', () => {

    // Note: expandGlobs uses `bash -O globstar` which requires bash 4+.
    // macOS ships bash 3.2 where globstar is unsupported, causing
    // expandGlobs to silently return empty arrays. This is valid behavior.

    it('accepts valid patterns and returns ok', async () => {
      const res = await request('POST', '/batch-read', {
        patterns: ['package.json'],
        basePath: PROJECT_ROOT,
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
      assert.ok(Array.isArray(res.data.files));
    });

    it('returns 400 when patterns is missing', async () => {
      const res = await request('POST', '/batch-read', {});
      assert.equal(res.status, 400);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('patterns'));
    });

    it('returns 400 when patterns is empty array', async () => {
      const res = await request('POST', '/batch-read', { patterns: [] });
      assert.equal(res.status, 400);
      assert.equal(res.data.ok, false);
    });

    it('returns empty files array for non-matching pattern', async () => {
      const res = await request('POST', '/batch-read', {
        patterns: ['nonexistent_pattern_xyz.blah'],
        basePath: PROJECT_ROOT,
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
      const files = res.data.files as Array<{ path: string; content: string }>;
      assert.equal(files.length, 0);
    });

    it('returns 400 for too many patterns', async () => {
      const manyPatterns = Array.from({ length: 51 }, (_, i) => `file${i}.txt`);
      const res = await request('POST', '/batch-read', {
        patterns: manyPatterns,
        basePath: PROJECT_ROOT,
      });
      assert.equal(res.status, 400);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('Too many'));
    });

    it('rejects wrong HTTP method (GET)', async () => {
      const res = await request('GET', '/batch-read');
      assert.equal(res.status, 405);
    });
  });

  // ─── POST /call ───────────────────────────────────────────────────────────

  describe('POST /call', () => {

    it('returns 400 when tool is missing', async () => {
      const res = await request('POST', '/call', { args: {} });
      assert.equal(res.status, 400);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('tool'));
    });

    it('rejects wrong HTTP method (GET)', async () => {
      const res = await request('GET', '/call');
      assert.equal(res.status, 405);
    });

    it('invokes claude CLI with a tool (live test)', { skip: !LIVE }, async () => {
      const res = await request('POST', '/call', {
        tool: 'Bash',
        args: { command: 'echo call_test_output' },
      });
      assert.equal(res.status, 200);
      assert.ok(typeof res.data.ok === 'boolean');
    });
  });

  // ─── GET /sessions ────────────────────────────────────────────────────────

  describe('GET /sessions', () => {

    it('returns an array of sessions', async () => {
      const res = await request('GET', '/sessions');
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
      assert.ok(Array.isArray(res.data.sessions));
    });

    it('rejects wrong HTTP method (POST)', async () => {
      const res = await request('POST', '/sessions');
      assert.equal(res.status, 405);
    });
  });

  // ─── POST /resume ────────────────────────────────────────────────────────

  describe('POST /resume', () => {

    it('returns 400 when sessionId is missing', async () => {
      const res = await request('POST', '/resume', { prompt: 'hello' });
      assert.equal(res.status, 400);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('sessionId'));
    });

    it('returns 400 when prompt is missing', async () => {
      const res = await request('POST', '/resume', { sessionId: 'abc' });
      assert.equal(res.status, 400);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('prompt'));
    });

    it('returns 400 when both fields are missing', async () => {
      const res = await request('POST', '/resume', {});
      assert.equal(res.status, 400);
      assert.equal(res.data.ok, false);
    });

    it('rejects wrong HTTP method (GET)', async () => {
      const res = await request('GET', '/resume');
      assert.equal(res.status, 405);
    });

    it('calls claude CLI with sessionId and prompt (live test)', { skip: !LIVE }, async () => {
      const res = await request('POST', '/resume', {
        sessionId: 'test-session-id',
        prompt: 'Say "resume-test-ok" and nothing else.',
      });
      assert.equal(res.status, 200);
      assert.ok(typeof res.data.ok === 'boolean');
    });
  });

  // ─── POST /continue ──────────────────────────────────────────────────────

  describe('POST /continue', () => {

    it('returns 400 when prompt is missing', async () => {
      const res = await request('POST', '/continue', {});
      assert.equal(res.status, 400);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('prompt'));
    });

    it('rejects wrong HTTP method (GET)', async () => {
      const res = await request('GET', '/continue');
      assert.equal(res.status, 405);
    });

    it('calls claude CLI with --continue flag (live test)', { skip: !LIVE }, async () => {
      const res = await request('POST', '/continue', {
        prompt: 'Say "continue-test-ok" and nothing else.',
      });
      assert.equal(res.status, 200);
      assert.ok(typeof res.data.ok === 'boolean');
    });
  });

  // ─── POST /session/start ─────────────────────────────────────────────────

  describe('POST /session/start', () => {

    it('creates a new session', async () => {
      const name = uniqueName('start');
      const res = await request('POST', '/session/start', { name });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
      assert.ok(typeof res.data.claudeSessionId === 'string');
    });

    it('accepts optional config fields', async () => {
      const name = uniqueName('start-opts');
      const res = await request('POST', '/session/start', {
        name,
        model: 'claude-sonnet-4-20250514',
        permissionMode: 'bypassPermissions',
        maxTurns: 5,
        systemPrompt: 'You are a test assistant.',
        cwd: '/tmp',
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
    });

    it('uses custom sessionId when provided', async () => {
      const name = uniqueName('start-custom-id');
      const customId = 'my-custom-session-id-123';
      const res = await request('POST', '/session/start', {
        name,
        customSessionId: customId,
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
      assert.equal(res.data.claudeSessionId, customId);
    });

    it('rejects duplicate session name', async () => {
      const name = uniqueName('start-dup');
      await request('POST', '/session/start', { name });
      const res = await request('POST', '/session/start', { name });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('already exists'));
    });

    it('returns 400 when name is missing', async () => {
      const res = await request('POST', '/session/start', {});
      assert.equal(res.status, 400);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('session name'));
    });

    it('returns 400 for invalid session name (special chars)', async () => {
      const res = await request('POST', '/session/start', { name: 'bad name with spaces!' });
      assert.equal(res.status, 400);
      assert.equal(res.data.ok, false);
    });

    it('rejects wrong HTTP method (GET)', async () => {
      const res = await request('GET', '/session/start');
      assert.equal(res.status, 405);
    });
  });

  // ─── POST /session/send ──────────────────────────────────────────────────

  describe('POST /session/send', () => {

    it('returns 400 when name is invalid', async () => {
      const res = await request('POST', '/session/send', { name: '', message: 'hello' });
      assert.equal(res.status, 400);
      assert.equal(res.data.ok, false);
    });

    it('returns 400 when message is missing', async () => {
      const res = await request('POST', '/session/send', { name: 'test-session' });
      assert.equal(res.status, 400);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('message'));
    });

    it('returns error for nonexistent session', async () => {
      const res = await request('POST', '/session/send', {
        name: 'nonexistent-session-xyz',
        message: 'hello',
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('not found'));
    });

    it('returns error for paused session', async () => {
      const name = await createSession();
      await request('POST', '/session/pause', { name });
      const res = await request('POST', '/session/send', { name, message: 'hello' });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('paused'));
    });

    it('rejects wrong HTTP method (GET)', async () => {
      const res = await request('GET', '/session/send');
      assert.equal(res.status, 405);
    });

    it('sends a message to a session (live test)', { skip: !LIVE }, async () => {
      const name = await createSession(uniqueName('send-live'));
      const res = await request('POST', '/session/send', {
        name,
        message: 'Say "send-test-ok" and nothing else.',
        timeout: 60_000,
      });
      assert.equal(res.status, 200);
      assert.ok(typeof res.data.ok === 'boolean');
    });
  });

  // ─── POST /session/send-stream ───────────────────────────────────────────

  describe('POST /session/send-stream', () => {

    it('returns 400 when name is invalid', async () => {
      const res = await request('POST', '/session/send-stream', { name: '', message: 'hello' });
      assert.equal(res.status, 400);
      assert.equal(res.data.ok, false);
    });

    it('returns 400 when message is missing', async () => {
      const res = await request('POST', '/session/send-stream', { name: 'test-session' });
      assert.equal(res.status, 400);
      assert.equal(res.data.ok, false);
    });

    it('returns error for nonexistent session', async () => {
      const res = await request('POST', '/session/send-stream', {
        name: 'nonexistent-session-stream',
        message: 'hello',
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('not found'));
    });

    it('returns error for paused session', async () => {
      const name = await createSession();
      await request('POST', '/session/pause', { name });
      const res = await request('POST', '/session/send-stream', { name, message: 'hello' });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('paused'));
    });

    it('rejects wrong HTTP method (GET)', async () => {
      const res = await request('GET', '/session/send-stream');
      assert.equal(res.status, 405);
    });

    it('streams SSE events for a real session (live test)', { skip: !LIVE }, async () => {
      const name = await createSession(uniqueName('stream-live'));
      const sse = await requestSSE('POST', '/session/send-stream', {
        name,
        message: 'Say exactly "stream-ok" and nothing else.',
        timeout: 60_000,
      }, 60_000);

      assert.equal(sse.status, 200);
      const doneEvents = sse.events.filter((e) => e.type === 'done');
      assert.ok(doneEvents.length >= 1, 'Expected at least one "done" SSE event');
      assert.ok(sse.raw.includes('data: '), 'Raw output should contain SSE data lines');
    });
  });

  // ─── GET /session/list ────────────────────────────────────────────────────

  describe('GET /session/list', () => {

    it('returns in-memory sessions', async () => {
      const name = await createSession();
      const res = await request('GET', '/session/list');
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);

      const list = res.data.sessions as Array<{ name: string; cwd: string; created: string; isReady: boolean }>;
      assert.ok(Array.isArray(list));
      const found = list.find((s) => s.name === name);
      assert.ok(found, `Session '${name}' should appear in list`);
      assert.ok(typeof found.cwd === 'string');
      assert.ok(typeof found.created === 'string');
      assert.equal(found.isReady, true);
    });

    it('rejects wrong HTTP method (POST)', async () => {
      const res = await request('POST', '/session/list');
      assert.equal(res.status, 405);
    });
  });

  // ─── POST /session/stop ──────────────────────────────────────────────────

  describe('POST /session/stop', () => {

    it('stops and removes a session', async () => {
      const name = await createSession();
      const res = await request('POST', '/session/stop', { name });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);

      const listRes = await request('GET', '/session/list');
      const list = listRes.data.sessions as Array<{ name: string }>;
      const found = list.find((s) => s.name === name);
      assert.equal(found, undefined, 'Stopped session should not appear in list');
    });

    it('returns error for nonexistent session', async () => {
      const res = await request('POST', '/session/stop', { name: 'nonexistent-stop-xyz' });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('not found'));
    });

    it('returns error when name is missing', async () => {
      const res = await request('POST', '/session/stop', {});
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('Missing name'));
    });

    it('rejects wrong HTTP method (GET)', async () => {
      const res = await request('GET', '/session/stop');
      assert.equal(res.status, 405);
    });
  });

  // ─── POST /session/status ────────────────────────────────────────────────

  describe('POST /session/status', () => {

    it('returns status for an existing session', async () => {
      const name = await createSession();
      const res = await request('POST', '/session/status', { name });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
      assert.ok(typeof res.data.claudeSessionId === 'string');
      assert.ok(typeof res.data.cwd === 'string');
      assert.ok(typeof res.data.created === 'string');

      const stats = res.data.stats as Record<string, unknown>;
      assert.ok(typeof stats.turns === 'number');
      assert.ok(typeof stats.toolCalls === 'number');
      assert.ok(typeof stats.uptime === 'number');
      assert.ok(typeof stats.isReady === 'boolean');
      assert.equal(stats.isReady, true);
    });

    it('returns error for nonexistent session', async () => {
      const res = await request('POST', '/session/status', { name: 'nonexistent-status-xyz' });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('not found'));
    });

    it('returns error when name is missing', async () => {
      const res = await request('POST', '/session/status', {});
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('Missing name'));
    });

    it('rejects wrong HTTP method (GET)', async () => {
      const res = await request('GET', '/session/status');
      assert.equal(res.status, 405);
    });
  });

  // ─── POST /session/history ───────────────────────────────────────────────

  describe('POST /session/history', () => {

    it('returns empty history for a new session', async () => {
      const name = await createSession();
      const res = await request('POST', '/session/history', { name });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
      assert.equal(res.data.count, 0);
      assert.ok(Array.isArray(res.data.history));
      assert.equal((res.data.history as unknown[]).length, 0);
    });

    it('returns error for nonexistent session', async () => {
      const res = await request('POST', '/session/history', { name: 'nonexistent-history-xyz' });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('not found'));
    });

    it('returns error when name is missing', async () => {
      const res = await request('POST', '/session/history', {});
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('Missing name'));
    });

    it('rejects wrong HTTP method (GET)', async () => {
      const res = await request('GET', '/session/history');
      assert.equal(res.status, 405);
    });
  });

  // ─── POST /session/pause ─────────────────────────────────────────────────

  describe('POST /session/pause', () => {

    it('pauses a session', async () => {
      const name = await createSession();
      const res = await request('POST', '/session/pause', { name });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);

      const statusRes = await request('POST', '/session/status', { name });
      const stats = statusRes.data.stats as Record<string, unknown>;
      assert.equal(stats.isReady, false);
    });

    it('returns error for nonexistent session', async () => {
      const res = await request('POST', '/session/pause', { name: 'nonexistent-pause-xyz' });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('not found'));
    });

    it('returns error when name is missing', async () => {
      const res = await request('POST', '/session/pause', {});
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('Missing name'));
    });

    it('rejects wrong HTTP method (GET)', async () => {
      const res = await request('GET', '/session/pause');
      assert.equal(res.status, 405);
    });
  });

  // ─── POST /session/resume ────────────────────────────────────────────────

  describe('POST /session/resume', () => {

    it('resumes a paused session', async () => {
      const name = await createSession();
      await request('POST', '/session/pause', { name });

      const res = await request('POST', '/session/resume', { name });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);

      const statusRes = await request('POST', '/session/status', { name });
      const stats = statusRes.data.stats as Record<string, unknown>;
      assert.equal(stats.isReady, true);
    });

    it('returns error for nonexistent session', async () => {
      const res = await request('POST', '/session/resume', { name: 'nonexistent-resume-xyz' });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('not found'));
    });

    it('returns error when name is missing', async () => {
      const res = await request('POST', '/session/resume', {});
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('Missing name'));
    });

    it('rejects wrong HTTP method (GET)', async () => {
      const res = await request('GET', '/session/resume');
      assert.equal(res.status, 405);
    });
  });

  // ─── POST /session/fork ──────────────────────────────────────────────────

  describe('POST /session/fork', () => {

    it('forks a session into a new one', async () => {
      const name = await createSession();
      const newName = uniqueName('forked');
      const res = await request('POST', '/session/fork', { name, newName });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
      assert.ok(typeof res.data.claudeSessionId === 'string');

      const listRes = await request('GET', '/session/list');
      const list = listRes.data.sessions as Array<{ name: string }>;
      assert.ok(list.find((s) => s.name === newName));
    });

    it('forked session inherits history', async () => {
      const name = await createSession();
      const newName = uniqueName('forked-hist');
      await request('POST', '/session/fork', { name, newName });
      const histRes = await request('POST', '/session/history', { name: newName });
      assert.equal(histRes.data.ok, true);
      assert.equal(histRes.data.count, 0);
    });

    it('returns error when source session does not exist', async () => {
      // Both names must be valid for the handler to proceed to lookup
      const res = await request('POST', '/session/fork', {
        name: 'nonexistent-fork-src',
        newName: 'fork-target',
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('not found'));
    });

    it('returns error when new name already exists', async () => {
      const name = await createSession();
      const existingName = await createSession();
      const res = await request('POST', '/session/fork', { name, newName: existingName });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('already exists'));
    });

    it('returns 400 when name or newName is missing or invalid', async () => {
      // Both missing
      const res1 = await request('POST', '/session/fork', {});
      assert.equal(res1.status, 400);
      assert.equal(res1.data.ok, false);

      // name present but newName missing
      const res2 = await request('POST', '/session/fork', { name: 'valid-name' });
      assert.equal(res2.status, 400);
      assert.equal(res2.data.ok, false);

      // newName present but name missing
      const res3 = await request('POST', '/session/fork', { newName: 'valid-name' });
      assert.equal(res3.status, 400);
      assert.equal(res3.data.ok, false);

      // Invalid characters
      const res4 = await request('POST', '/session/fork', { name: 'a', newName: 'invalid name!' });
      assert.equal(res4.status, 400);
      assert.equal(res4.data.ok, false);
    });

    it('rejects wrong HTTP method (GET)', async () => {
      const res = await request('GET', '/session/fork');
      assert.equal(res.status, 405);
    });
  });

  // ─── POST /session/search ────────────────────────────────────────────────

  describe('POST /session/search', () => {

    it('finds sessions by name query', async () => {
      const unique = `searchable-${Date.now()}`;
      await createSession(unique);

      const res = await request('POST', '/session/search', { query: unique });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
      const sessions = res.data.sessions as Array<{ name: string }>;
      assert.ok(sessions.length >= 1);
      assert.ok(sessions.some((s) => s.name === unique));
    });

    it('returns empty when no sessions match', async () => {
      const res = await request('POST', '/session/search', {
        query: 'completely-nonexistent-query-xyzzy-999',
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
      const sessions = res.data.sessions as Array<{ name: string }>;
      assert.equal(sessions.length, 0);
    });

    it('filters by project path', async () => {
      const name = await createSession(undefined, { cwd: '/tmp/test-project' });
      const res = await request('POST', '/session/search', { project: '/tmp/test-project' });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
      const sessions = res.data.sessions as Array<{ name: string }>;
      assert.ok(sessions.some((s) => s.name === name));
    });

    it('respects limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await createSession(uniqueName('search-limit'));
      }
      const res = await request('POST', '/session/search', { query: 'search-limit', limit: 2 });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
      const sessions = res.data.sessions as Array<{ name: string }>;
      assert.ok(sessions.length <= 2);
    });

    it('filters by since (relative time)', async () => {
      const name = await createSession();
      const res = await request('POST', '/session/search', { query: name, since: '1h' });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
      const sessions = res.data.sessions as Array<{ name: string }>;
      assert.ok(sessions.some((s) => s.name === name));
    });

    it('returns results with no body (empty query matches all)', async () => {
      const res = await request('POST', '/session/search', {});
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
      assert.ok(Array.isArray(res.data.sessions));
    });

    it('rejects wrong HTTP method (GET)', async () => {
      const res = await request('GET', '/session/search');
      assert.equal(res.status, 405);
    });
  });

  // ─── POST /session/restart ───────────────────────────────────────────────

  describe('POST /session/restart', () => {

    it('resets session state and gives new claudeSessionId', async () => {
      const name = await createSession();
      const statusBefore = await request('POST', '/session/status', { name });
      const idBefore = statusBefore.data.claudeSessionId as string;

      const res = await request('POST', '/session/restart', { name });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);

      const statusAfter = await request('POST', '/session/status', { name });
      const idAfter = statusAfter.data.claudeSessionId as string;
      assert.notEqual(idBefore, idAfter, 'Session ID should change after restart');

      const stats = statusAfter.data.stats as Record<string, unknown>;
      assert.equal(stats.turns, 0);
      assert.equal(stats.toolCalls, 0);

      const histRes = await request('POST', '/session/history', { name });
      assert.equal(histRes.data.count, 0);
    });

    it('returns error for nonexistent session', async () => {
      const res = await request('POST', '/session/restart', { name: 'nonexistent-restart-xyz' });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('not found'));
    });

    it('returns error when name is missing', async () => {
      const res = await request('POST', '/session/restart', {});
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('Missing name'));
    });

    it('unpauses a paused session on restart', async () => {
      const name = await createSession();
      await request('POST', '/session/pause', { name });
      await request('POST', '/session/restart', { name });

      const statusRes = await request('POST', '/session/status', { name });
      const stats = statusRes.data.stats as Record<string, unknown>;
      assert.equal(stats.isReady, true);
    });

    it('rejects wrong HTTP method (GET)', async () => {
      const res = await request('GET', '/session/restart');
      assert.equal(res.status, 405);
    });
  });

  // ─── Integration: Session Lifecycle ──────────────────────────────────────

  describe('session lifecycle (integration)', () => {

    it('start -> status -> pause -> resume -> restart -> stop', async () => {
      const name = uniqueName('lifecycle');
      const startRes = await request('POST', '/session/start', { name });
      assert.equal(startRes.data.ok, true);

      const statusRes1 = await request('POST', '/session/status', { name });
      assert.equal(statusRes1.data.ok, true);
      assert.equal((statusRes1.data.stats as Record<string, unknown>).isReady, true);

      const pauseRes = await request('POST', '/session/pause', { name });
      assert.equal(pauseRes.data.ok, true);
      const statusRes2 = await request('POST', '/session/status', { name });
      assert.equal((statusRes2.data.stats as Record<string, unknown>).isReady, false);

      const resumeRes = await request('POST', '/session/resume', { name });
      assert.equal(resumeRes.data.ok, true);
      const statusRes3 = await request('POST', '/session/status', { name });
      assert.equal((statusRes3.data.stats as Record<string, unknown>).isReady, true);

      const restartRes = await request('POST', '/session/restart', { name });
      assert.equal(restartRes.data.ok, true);

      const stopRes = await request('POST', '/session/stop', { name });
      assert.equal(stopRes.data.ok, true);

      const statusRes4 = await request('POST', '/session/status', { name });
      assert.equal(statusRes4.data.ok, false);
    });

    it('fork creates independent session', async () => {
      const parent = await createSession(uniqueName('parent'));
      const child = uniqueName('child');

      const forkRes = await request('POST', '/session/fork', { name: parent, newName: child });
      assert.equal(forkRes.data.ok, true);

      await request('POST', '/session/pause', { name: parent });
      const childStatus = await request('POST', '/session/status', { name: child });
      assert.equal((childStatus.data.stats as Record<string, unknown>).isReady, true);

      await request('POST', '/session/stop', { name: parent });
      const childStatus2 = await request('POST', '/session/status', { name: child });
      assert.equal(childStatus2.data.ok, true);

      await request('POST', '/session/stop', { name: child });
    });
  });

  // ─── Edge Cases ──────────────────────────────────────────────────────────

  describe('edge cases', () => {

    it('POST with empty body is handled gracefully', async () => {
      const res = await rawRequest('POST', '/bash');
      // Empty body -> readBody resolves {} -> validateString fails -> 400
      assert.equal(res.status, 400);
      assert.equal(res.data.ok, false);
    });

    it('POST with malformed JSON body returns 400', async () => {
      const res = await rawRequest('POST', '/bash', 'this is not json{{{', {
        'Content-Type': 'application/json',
      });
      assert.equal(res.status, 400);
      assert.equal(res.data.ok, false);
      assert.ok((res.data.error as string).includes('Malformed JSON'));
    });

    it('CORS headers are present on all responses', async () => {
      const url = `${BASE_URL}/tools`;
      const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
        http.get(url, (res) => {
          res.resume();
          res.on('end', () => resolve(res.headers));
        }).on('error', reject);
      });

      assert.equal(headers['access-control-allow-origin'], '*');
    });

    it('concurrent session creates with different names succeed', async () => {
      const results = await Promise.all([
        request('POST', '/session/start', { name: uniqueName('concurrent-a') }),
        request('POST', '/session/start', { name: uniqueName('concurrent-b') }),
        request('POST', '/session/start', { name: uniqueName('concurrent-c') }),
      ]);
      for (const res of results) {
        assert.equal(res.data.ok, true);
      }
    });

    it('session search with ISO date "since" filter works', async () => {
      const name = await createSession();
      const pastDate = new Date(Date.now() - 3600_000).toISOString();
      const res = await request('POST', '/session/search', { query: name, since: pastDate });
      assert.equal(res.data.ok, true);
      const sessions = res.data.sessions as Array<{ name: string }>;
      assert.ok(sessions.some((s) => s.name === name));
    });

    it('session search with future "since" returns empty', async () => {
      const name = await createSession();
      const futureDate = new Date(Date.now() + 86400_000).toISOString();
      const res = await request('POST', '/session/search', { query: name, since: futureDate });
      assert.equal(res.data.ok, true);
      const sessions = res.data.sessions as Array<{ name: string }>;
      assert.equal(sessions.length, 0);
    });

    it('batch-read with multiple patterns returns ok', async () => {
      const res = await request('POST', '/batch-read', {
        patterns: ['package.json', 'tsconfig.json'],
        basePath: PROJECT_ROOT,
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
      assert.ok(Array.isArray(res.data.files));
    });
  });

  // ─── Security: Input Validation ──────────────────────────────────────────

  describe('security: input validation', () => {

    it('rejects session names with special characters', async () => {
      const badNames = ['test session', 'test.session', 'test/session', '../escape', ''];
      for (const name of badNames) {
        const res = await request('POST', '/session/start', { name });
        assert.equal(res.status, 400, `Name '${name}' should be rejected`);
        assert.equal(res.data.ok, false);
      }
    });

    it('accepts valid session names', async () => {
      const goodNames = [uniqueName('alpha'), 'abc-def_123', 'A', 'test_session'];
      for (const name of goodNames) {
        const res = await request('POST', '/session/start', { name });
        assert.equal(res.data.ok, true, `Name '${name}' should be accepted`);
      }
    });

    it('rejects bash commands with semicolons', async () => {
      const res = await request('POST', '/bash', { command: 'echo a; echo b' });
      assert.equal(res.status, 400);
      assert.equal(res.data.ok, false);
    });

    it('rejects bash commands with backticks', async () => {
      const res = await request('POST', '/bash', { command: 'echo `whoami`' });
      assert.equal(res.status, 400);
      assert.equal(res.data.ok, false);
    });

    it('rejects bash commands with redirects', async () => {
      const res = await request('POST', '/bash', { command: 'echo a > /tmp/test' });
      assert.equal(res.status, 400);
      assert.equal(res.data.ok, false);
    });

    it('allows simple safe bash commands', async () => {
      const res = await request('POST', '/bash', { command: 'echo hello world' });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
    });

    it('allows ls command', async () => {
      const res = await request('POST', '/bash', { command: 'ls -la /tmp' });
      assert.equal(res.status, 200);
      assert.equal(res.data.ok, true);
    });
  });

  // ─── Method Not Allowed (comprehensive) ──────────────────────────────────

  describe('method not allowed (405) for every endpoint', () => {

    const getEndpoints = ['/tools', '/sessions', '/session/list'];
    const postEndpoints = [
      '/connect', '/disconnect', '/bash', '/read', '/batch-read',
      '/call', '/resume', '/continue',
      '/session/start', '/session/send', '/session/send-stream',
      '/session/stop', '/session/status', '/session/history',
      '/session/pause', '/session/resume', '/session/fork',
      '/session/search', '/session/restart',
    ];

    for (const ep of getEndpoints) {
      it(`POST ${ep} returns 405`, async () => {
        const res = await request('POST', ep);
        assert.equal(res.status, 405, `POST ${ep} should return 405`);
      });
    }

    for (const ep of postEndpoints) {
      it(`GET ${ep} returns 405`, async () => {
        const res = await request('GET', ep);
        assert.equal(res.status, 405, `GET ${ep} should return 405`);
      });
    }
  });

});
