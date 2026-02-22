# Claude Code Skill -- Backend API Reference

## Overview

The claude-code-skill backend is an HTTP server that wraps the `claude` CLI binary, exposing it as a JSON API. It manages persistent in-memory sessions, handles process lifecycle, supports SSE streaming, and provides convenience endpoints for common operations (bash execution, file reading, tool invocation).

### Starting the Server

```bash
npm run build && node dist/server.js
```

Or with environment overrides:

```bash
CLAUDE_CODE_PORT=9000 CLAUDE_CODE_HOST=0.0.0.0 CLAUDE_BIN=/usr/local/bin/claude node dist/server.js
```

### Base URL

All endpoints are prefixed with:

```
http://127.0.0.1:18795/backend-api/claude-code
```

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_CODE_PORT` | `18795` | Server listen port |
| `CLAUDE_CODE_HOST` | `127.0.0.1` | Server bind address |
| `CLAUDE_BIN` | auto-detected | Path to `claude` CLI binary |

### CORS

The server sends `Access-Control-Allow-Origin: *` on all responses and handles `OPTIONS` preflight requests.

### Request Limits

| Limit | Value |
|---|---|
| Max request body | 10 MB |
| Body read timeout | 30 seconds |
| Default process timeout | 120 seconds |

---

## Quick Start

Five calls to go from zero to a complete interaction:

```bash
# 1. Connect -- verifies the claude binary is available
curl -X POST http://127.0.0.1:18795/backend-api/claude-code/connect

# 2. Start a persistent session
curl -X POST http://127.0.0.1:18795/backend-api/claude-code/session/start \
  -H 'Content-Type: application/json' \
  -d '{"name":"demo","cwd":"/tmp","permissionMode":"acceptEdits"}'

# 3. Send a message
curl -X POST http://127.0.0.1:18795/backend-api/claude-code/session/send \
  -H 'Content-Type: application/json' \
  -d '{"name":"demo","message":"What files are in the current directory?"}'

# 4. Read the response from the JSON body (field: "response")

# 5. Stop the session
curl -X POST http://127.0.0.1:18795/backend-api/claude-code/session/stop \
  -H 'Content-Type: application/json' \
  -d '{"name":"demo"}'
```

---

## Endpoint Groups

| Group | Endpoints | Purpose |
|---|---|---|
| **Connection** | `/connect`, `/disconnect` | Server lifecycle |
| **Tools** | `/tools` | List available Claude tools |
| **One-shot** | `/bash`, `/read`, `/call` | Single command/file/tool invocations |
| **Sessions (filesystem)** | `/sessions`, `/batch-read` | Read on-disk Claude session history and batch file reads |
| **Resume** | `/resume`, `/continue` | Resume prior Claude CLI sessions |
| **Persistent** | `/session/*` (12 endpoints) | In-memory managed sessions with full lifecycle |

---

## Connection Endpoints

### POST /connect

Verify the `claude` binary exists and mark the server as connected.

**Request body:** None required (empty object accepted).

**Response:**

```json
{
  "ok": true,
  "status": "connected",
  "server": {
    "name": "claude-code-backend",
    "version": "1.0.0",
    "bin": "/Users/you/.local/bin/claude"
  },
  "tools": 13
}
```

If the binary is not found:

```json
{
  "ok": false,
  "error": "Claude binary not found at /usr/local/bin/claude. Set CLAUDE_BIN env var."
}
```

**curl:**

```bash
curl -X POST http://127.0.0.1:18795/backend-api/claude-code/connect
```

---

### POST /disconnect

Kill all active session processes, clear all in-memory sessions, and set the server to disconnected.

**Request body:** None required.

**Response:**

```json
{
  "ok": true
}
```

**curl:**

```bash
curl -X POST http://127.0.0.1:18795/backend-api/claude-code/disconnect
```

---

## Tools Endpoint

### GET /tools

List the known Claude Code tools. Requires a prior `/connect` call.

**Request body:** None (GET request).

**Response:**

```json
{
  "ok": true,
  "tools": [
    { "name": "Bash", "description": "Execute bash commands" },
    { "name": "Read", "description": "Read file contents" },
    { "name": "Write", "description": "Write file contents" },
    { "name": "Edit", "description": "Edit file contents with search/replace" },
    { "name": "Glob", "description": "Find files by glob pattern" },
    { "name": "Grep", "description": "Search file contents with regex" },
    { "name": "WebFetch", "description": "Fetch and process web content" },
    { "name": "WebSearch", "description": "Search the web" },
    { "name": "Task", "description": "Launch sub-agents for complex tasks" },
    { "name": "NotebookEdit", "description": "Edit Jupyter notebook cells" },
    { "name": "TodoRead", "description": "Read todo list" },
    { "name": "TodoWrite", "description": "Write todo list" },
    { "name": "AskUserQuestion", "description": "Ask the user a question" }
  ]
}
```

**Error (not connected):**

```json
{
  "ok": false,
  "error": "Not connected"
}
```

**curl:**

```bash
curl http://127.0.0.1:18795/backend-api/claude-code/tools
```

---

## One-shot Endpoints

### POST /bash

Execute a shell command directly (uses Node.js `exec`, not the Claude CLI).

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `command` | string | Yes | Shell command to execute |

**Response:**

```json
{
  "ok": true,
  "result": {
    "stdout": "file1.ts\nfile2.ts\n",
    "stderr": ""
  }
}
```

**Error:**

```json
{
  "ok": false,
  "error": "Missing command"
}
```

**curl:**

```bash
curl -X POST http://127.0.0.1:18795/backend-api/claude-code/bash \
  -H 'Content-Type: application/json' \
  -d '{"command":"ls -la /tmp"}'
```

---

### POST /read

Read a single file from the filesystem.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `file_path` | string | Yes | Absolute path to the file |

**Response:**

```json
{
  "ok": true,
  "result": {
    "type": "file",
    "file": {
      "content": "file contents here..."
    }
  }
}
```

**Error:**

```json
{
  "ok": false,
  "error": "ENOENT: no such file or directory, open '/nonexistent'"
}
```

**curl:**

```bash
curl -X POST http://127.0.0.1:18795/backend-api/claude-code/read \
  -H 'Content-Type: application/json' \
  -d '{"file_path":"/etc/hostname"}'
```

---

### POST /call

Invoke any Claude Code tool by name. This spawns a `claude` CLI process with a prompt instructing it to call the specified tool.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `tool` | string | Yes | Tool name (e.g., `Glob`, `Grep`, `Write`) |
| `args` | object | No | Tool-specific arguments (default: `{}`) |

**Response:**

```json
{
  "ok": true,
  "result": {
    "filenames": ["src/index.ts", "src/server.ts"]
  }
}
```

The `result` field contains whatever the tool returned. The server attempts to JSON-parse the result string; if parsing fails, it returns the raw string.

**Error:**

```json
{
  "ok": false,
  "error": "Claude invocation failed"
}
```

**curl:**

```bash
curl -X POST http://127.0.0.1:18795/backend-api/claude-code/call \
  -H 'Content-Type: application/json' \
  -d '{"tool":"Glob","args":{"pattern":"**/*.ts","path":"/home/user/project"}}'
```

---

## Session (Filesystem) Endpoints

### GET /sessions

Scan the `~/.claude/projects/` directory for JSONL session files. Returns up to 50 sessions, sorted by last modified time (newest first).

**Request body:** None (GET request).

**Response:**

```json
{
  "ok": true,
  "sessions": [
    {
      "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "summary": "Fix the authentication bug in the login handler",
      "projectPath": "/Users/you/project",
      "modified": "2026-02-21T10:30:00.000Z",
      "messageCount": 24
    }
  ]
}
```

| Response field | Type | Description |
|---|---|---|
| `sessionId` | string | UUID extracted from the JSONL filename |
| `summary` | string or undefined | First 100 chars of the first user message |
| `projectPath` | string | Decoded project directory path |
| `modified` | string | ISO 8601 timestamp of file modification |
| `messageCount` | number | Number of lines in the JSONL file |

**curl:**

```bash
curl http://127.0.0.1:18795/backend-api/claude-code/sessions
```

---

### POST /batch-read

Read multiple files at once using glob patterns. Patterns are expanded with bash globstar.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `patterns` | string[] | Yes | Array of glob patterns (e.g., `["src/**/*.ts", "*.json"]`) |
| `basePath` | string | No | Base directory for pattern resolution (default: server cwd) |

**Response:**

```json
{
  "ok": true,
  "files": [
    {
      "path": "/home/user/project/src/index.ts",
      "content": "import express from 'express';\n..."
    },
    {
      "path": "/home/user/project/src/broken.ts",
      "content": "",
      "error": "EACCES: permission denied"
    }
  ]
}
```

**Error:**

```json
{
  "ok": false,
  "error": "Missing patterns array"
}
```

**curl:**

```bash
curl -X POST http://127.0.0.1:18795/backend-api/claude-code/batch-read \
  -H 'Content-Type: application/json' \
  -d '{"patterns":["src/**/*.ts","package.json"],"basePath":"/home/user/project"}'
```

---

## Resume Endpoints

### POST /resume

Resume a specific Claude CLI session by its UUID and send a new prompt.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | Yes | Claude CLI session UUID |
| `prompt` | string | Yes | Message to send |
| `cwd` | string | No | Working directory (default: server cwd) |

**Response:**

```json
{
  "ok": true,
  "output": "Here are the results of your request...",
  "stderr": ""
}
```

**Error:**

```json
{
  "ok": false,
  "error": "Missing sessionId or prompt"
}
```

**curl:**

```bash
curl -X POST http://127.0.0.1:18795/backend-api/claude-code/resume \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","prompt":"Continue where you left off","cwd":"/home/user/project"}'
```

---

### POST /continue

Continue the most recent Claude CLI session in a given working directory.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | Yes | Message to send |
| `cwd` | string | No | Working directory (default: server cwd) |

**Response:**

```json
{
  "ok": true,
  "output": "Continuing from where we left off...",
  "stderr": ""
}
```

**Error:**

```json
{
  "ok": false,
  "error": "Missing prompt"
}
```

**curl:**

```bash
curl -X POST http://127.0.0.1:18795/backend-api/claude-code/continue \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"What was the last thing we did?","cwd":"/home/user/project"}'
```

---

## Persistent Session Endpoints

These 12 endpoints manage in-memory sessions with full lifecycle control. Each session wraps a Claude CLI session UUID and tracks history, stats, and state.

### POST /session/start

Create a new persistent session.

**Request body:**

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string | Yes | -- | Unique session name |
| `cwd` | string | No | server cwd | Working directory |
| `sessionId` | string | No | random UUID | Resume an existing Claude CLI session |
| `customSessionId` | string | No | -- | Force a specific UUID (takes priority over `sessionId`) |
| `model` | string | No | -- | Model name (e.g., `claude-opus-4-5`) |
| `baseUrl` | string | No | -- | Custom API endpoint for proxy backends |
| `permissionMode` | string | No | `acceptEdits` | One of: `acceptEdits`, `bypassPermissions`, `default`, `delegate`, `dontAsk`, `plan` |
| `allowedTools` | string[] | No | -- | Tools to auto-approve |
| `disallowedTools` | string[] | No | -- | Tools to deny |
| `tools` | string[] | No | -- | Limit available tools |
| `maxTurns` | number | No | -- | Max agent loop turns |
| `maxBudgetUsd` | number | No | -- | Max API spend in USD |
| `systemPrompt` | string | No | -- | Replace system prompt entirely |
| `appendSystemPrompt` | string | No | -- | Append to system prompt |
| `dangerouslySkipPermissions` | boolean | No | `false` | Skip all permission checks |
| `agents` | object | No | -- | Sub-agent definitions: `{"name": {"description":"...","prompt":"..."}}` |
| `agent` | string | No | -- | Default agent to use |
| `addDir` | string[] | No | -- | Additional directories for tool access |

**Response:**

```json
{
  "ok": true,
  "claudeSessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

**Errors:**

```json
{"ok": false, "error": "Missing name"}
{"ok": false, "error": "Session 'demo' already exists"}
```

**curl:**

```bash
curl -X POST http://127.0.0.1:18795/backend-api/claude-code/session/start \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "my-session",
    "cwd": "/home/user/project",
    "permissionMode": "plan",
    "allowedTools": ["Bash", "Read", "Edit"],
    "maxTurns": 20,
    "appendSystemPrompt": "Always write tests for new code."
  }'
```

---

### POST /session/send

Send a message to a persistent session and wait for the full response. Blocks until the Claude CLI process completes.

**Request body:**

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string | Yes | -- | Session name |
| `message` | string | Yes | -- | Message to send |
| `timeout` | number | No | `120000` | Timeout in milliseconds |

**Response:**

```json
{
  "ok": true,
  "response": "I found 3 TODO comments in your codebase..."
}
```

**Errors:**

```json
{"ok": false, "error": "Missing name or message"}
{"ok": false, "error": "Session 'demo' not found"}
{"ok": false, "error": "Session 'demo' is paused"}
{"ok": false, "error": "Claude invocation failed"}
```

**curl:**

```bash
curl -X POST http://127.0.0.1:18795/backend-api/claude-code/session/send \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-session","message":"List all TypeScript files","timeout":60000}'
```

---

### POST /session/send-stream

Send a message and receive the response as a Server-Sent Events (SSE) stream. See the [SSE Streaming](#sse-streaming) section below for event format details.

**Request body:**

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string | Yes | -- | Session name |
| `message` | string | Yes | -- | Message to send |
| `timeout` | number | No | `120000` | Timeout in milliseconds |

**Response:** SSE stream with `Content-Type: text/event-stream`. See [SSE Streaming](#sse-streaming).

**Errors (returned as JSON if session lookup fails before streaming begins):**

```json
{"ok": false, "error": "Session 'demo' not found"}
{"ok": false, "error": "Session 'demo' is paused"}
```

**curl:**

```bash
curl -N -X POST http://127.0.0.1:18795/backend-api/claude-code/session/send-stream \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-session","message":"Refactor the auth module"}'
```

---

### GET /session/list

List all active in-memory persistent sessions.

**Request body:** None (GET request).

**Response:**

```json
{
  "ok": true,
  "sessions": [
    {
      "name": "my-session",
      "cwd": "/home/user/project",
      "created": "2026-02-21T10:00:00.000Z",
      "isReady": true
    }
  ]
}
```

| Response field | Type | Description |
|---|---|---|
| `name` | string | Session name |
| `cwd` | string | Working directory |
| `created` | string | ISO 8601 creation timestamp |
| `isReady` | boolean | `true` if not paused and no active process |

**curl:**

```bash
curl http://127.0.0.1:18795/backend-api/claude-code/session/list
```

---

### POST /session/stop

Stop and delete a persistent session. Kills any active Claude CLI process.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Session name |

**Response:**

```json
{
  "ok": true
}
```

**Errors:**

```json
{"ok": false, "error": "Missing name"}
{"ok": false, "error": "Session 'demo' not found"}
```

**curl:**

```bash
curl -X POST http://127.0.0.1:18795/backend-api/claude-code/session/stop \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-session"}'
```

---

### POST /session/status

Get detailed status and statistics for a persistent session.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Session name |

**Response:**

```json
{
  "ok": true,
  "claudeSessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "cwd": "/home/user/project",
  "created": "2026-02-21T10:00:00.000Z",
  "stats": {
    "turns": 5,
    "toolCalls": 12,
    "tokensIn": 0,
    "tokensOut": 0,
    "uptime": 3600,
    "lastActivity": "2026-02-21T11:00:00.000Z",
    "isReady": true
  }
}
```

| Stats field | Type | Description |
|---|---|---|
| `turns` | number | Total conversation turns |
| `toolCalls` | number | Total tool invocations |
| `tokensIn` | number | Input tokens (reserved, currently 0) |
| `tokensOut` | number | Output tokens (reserved, currently 0) |
| `uptime` | number | Seconds since session creation |
| `lastActivity` | string | ISO 8601 timestamp of last activity |
| `isReady` | boolean | `true` if not paused and no active process |

**curl:**

```bash
curl -X POST http://127.0.0.1:18795/backend-api/claude-code/session/status \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-session"}'
```

---

### POST /session/history

Retrieve the conversation history for a persistent session.

**Request body:**

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string | Yes | -- | Session name |
| `limit` | number | No | `20` | Max number of entries to return (from the end) |

**Response:**

```json
{
  "ok": true,
  "count": 42,
  "history": [
    {
      "time": "2026-02-21T10:05:00.000Z",
      "type": "human",
      "event": {
        "message": {
          "content": [
            { "type": "text", "text": "Find all TODO comments" }
          ]
        }
      }
    },
    {
      "time": "2026-02-21T10:05:15.000Z",
      "type": "assistant",
      "event": {
        "message": {
          "content": [
            { "type": "text", "text": "I found 3 TODO comments..." }
          ]
        }
      }
    }
  ]
}
```

| Response field | Type | Description |
|---|---|---|
| `count` | number | Total number of history entries (before limit) |
| `history` | array | Array of history entries, newest last |
| `history[].time` | string | ISO 8601 timestamp |
| `history[].type` | string | `"human"` or `"assistant"` |
| `history[].event.message.content` | array | Content blocks with `type` and `text` fields |

**curl:**

```bash
curl -X POST http://127.0.0.1:18795/backend-api/claude-code/session/history \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-session","limit":10}'
```

---

### POST /session/pause

Pause a persistent session. Kills any active process and sets the paused flag. Messages sent to a paused session will be rejected.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Session name |

**Response:**

```json
{
  "ok": true
}
```

**curl:**

```bash
curl -X POST http://127.0.0.1:18795/backend-api/claude-code/session/pause \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-session"}'
```

---

### POST /session/resume

Resume a paused persistent session. Clears the paused flag so messages can be sent again.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Session name |

**Response:**

```json
{
  "ok": true
}
```

**curl:**

```bash
curl -X POST http://127.0.0.1:18795/backend-api/claude-code/session/resume \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-session"}'
```

---

### POST /session/fork

Fork an existing session into a new session. The new session gets a fresh Claude session UUID but inherits the full conversation history and all configuration from the source session.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Source session name |
| `newName` | string | Yes | Name for the forked session |

**Response:**

```json
{
  "ok": true,
  "claudeSessionId": "new-uuid-for-forked-session"
}
```

**Errors:**

```json
{"ok": false, "error": "Missing name or newName"}
{"ok": false, "error": "Session 'source' not found"}
{"ok": false, "error": "Session 'target' already exists"}
```

**curl:**

```bash
curl -X POST http://127.0.0.1:18795/backend-api/claude-code/session/fork \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-session","newName":"my-session-experiment"}'
```

---

### POST /session/search

Search active in-memory sessions by name, working directory, project path, or creation time.

**Request body:**

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `query` | string | No | -- | Case-insensitive substring match on session name or cwd |
| `project` | string | No | -- | Substring match on cwd |
| `since` | string | No | -- | Filter by creation time. Accepts relative (`"1h"`, `"2d"`, `"30m"`) or ISO 8601 |
| `limit` | number | No | `20` | Max results |

**Response:**

```json
{
  "ok": true,
  "sessions": [
    {
      "name": "my-session",
      "cwd": "/home/user/project",
      "created": "2026-02-21T10:00:00.000Z",
      "summary": "Find all TODO comments"
    }
  ]
}
```

The `summary` field contains the first 100 characters of the last human message in the session history.

**curl:**

```bash
curl -X POST http://127.0.0.1:18795/backend-api/claude-code/session/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"auth","since":"2d","limit":10}'
```

---

### POST /session/restart

Restart a session by resetting its Claude session UUID, stats, and history. The session configuration (name, cwd, model, permissions, etc.) is preserved. Any active process is killed.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Session name |

**Response:**

```json
{
  "ok": true
}
```

**curl:**

```bash
curl -X POST http://127.0.0.1:18795/backend-api/claude-code/session/restart \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-session"}'
```

---

## SSE Streaming

The `/session/send-stream` endpoint returns a `text/event-stream` response. Each event is a single `data:` line containing a JSON object.

### Event Types

| Event type | Fields | Description |
|---|---|---|
| `text` | `text` (string) | Incremental text fragment from the assistant |
| `tool_use` | `tool` (string) | A tool invocation has started (e.g., `"Bash"`, `"Read"`) |
| `tool_result` | -- | A tool invocation has completed |
| `error` | `error` (string) | An error occurred (stderr output or timeout) |
| `done` | -- | Stream has ended; the response is complete |

### Raw SSE Format

```
data: {"type":"text","text":"Let me look at "}

data: {"type":"text","text":"the files..."}

data: {"type":"tool_use","tool":"Glob"}

data: {"type":"tool_result"}

data: {"type":"text","text":"I found 5 TypeScript files."}

data: {"type":"done"}

```

Each line is prefixed with `data: ` followed by a JSON object, terminated by `\n\n`.

### Client Example (JavaScript)

```javascript
const response = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'my-session', message: 'Hello' })
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const event = JSON.parse(line.slice(6));
      switch (event.type) {
        case 'text':    process.stdout.write(event.text); break;
        case 'tool_use': console.log(`[Tool: ${event.tool}]`); break;
        case 'done':    console.log('\n--- Complete ---'); break;
        case 'error':   console.error(event.error); break;
      }
    }
  }
}
```

### Timeout and Disconnection

- If the process exceeds the timeout, the server sends an `error` event and closes the stream.
- If the client disconnects (closes the connection), the server kills the Claude CLI process via `SIGTERM`.

---

## Session Lifecycle

```
                        /session/start
                              |
                              v
                    +-------------------+
                    |      ACTIVE       |<-----------+
                    |  (isReady: true)  |            |
                    +-------------------+            |
                       |      |      |               |
          /session/send|      |      |/session/pause |  /session/resume
          /session/    |      |      |               |  (unpause)
          send-stream  |      |      v               |
                       |      |  +----------+        |
                       |      |  |  PAUSED  |--------+
                       |      |  +----------+
                       |      |
                       v      |
              +-------------+ | /session/stop
              |  PROCESSING | |
              | (isReady:   | |
              |    false)   | |
              +-------------+ |
                    |         |
                    | (done)  v
                    |    +---------+
                    +--->| STOPPED |
                         | (deleted|
                         |from map)|
                         +---------+

          /session/restart: ACTIVE -> ACTIVE (reset UUID, stats, history)
          /session/fork:    ACTIVE -> new ACTIVE session (copy config + history)
```

### State Descriptions

| State | `isReady` | Description |
|---|---|---|
| **Active** | `true` | Session exists and is accepting messages |
| **Processing** | `false` | A Claude CLI process is running for this session |
| **Paused** | `false` | Session is suspended; messages are rejected with an error |
| **Stopped** | N/A | Session has been removed from memory |

### State Transitions

| From | To | Trigger |
|---|---|---|
| -- | Active | `POST /session/start` |
| Active | Processing | `POST /session/send` or `/session/send-stream` |
| Processing | Active | Claude CLI process completes |
| Active | Paused | `POST /session/pause` |
| Paused | Active | `POST /session/resume` |
| Active | Stopped | `POST /session/stop` |
| Paused | Stopped | `POST /session/stop` |
| Active | Active (reset) | `POST /session/restart` |
| Active | Active (new) | `POST /session/fork` (creates a second session) |

---

## Error Codes

All error responses share the same shape:

```json
{
  "ok": false,
  "error": "description of what went wrong"
}
```

### HTTP Status Codes

| Status | Condition | Example |
|---|---|---|
| **200** | Successful request, or business-logic error | `{"ok": true, ...}` or `{"ok": false, "error": "Session not found"}` |
| **404** | URL does not match the prefix or any known endpoint | `{"ok": false, "error": "Not found"}` or `{"ok": false, "error": "Unknown endpoint: /foo"}` |
| **405** | HTTP method does not match the endpoint's expected method | `{"ok": false, "error": "Method GET not allowed"}` |
| **500** | Unhandled server exception | `{"ok": false, "error": "...exception message..."}` |

Note: Most business-logic errors (missing parameters, session not found, etc.) return HTTP 200 with `"ok": false`. This simplifies client-side handling since the response body always parses as JSON.

### Common Business-Logic Errors (HTTP 200)

| Error message | Endpoint(s) | Cause |
|---|---|---|
| `"Missing command"` | `/bash` | No `command` field in body |
| `"Missing file_path"` | `/read` | No `file_path` field in body |
| `"Missing tool"` | `/call` | No `tool` field in body |
| `"Missing patterns array"` | `/batch-read` | `patterns` is not an array or is empty |
| `"Missing sessionId or prompt"` | `/resume` | Missing required fields |
| `"Missing prompt"` | `/continue` | No `prompt` field |
| `"Missing name"` | `/session/start`, `/session/stop`, `/session/status`, `/session/history`, `/session/pause`, `/session/resume`, `/session/restart` | No `name` field |
| `"Missing name or message"` | `/session/send`, `/session/send-stream` | Missing required fields |
| `"Missing name or newName"` | `/session/fork` | Missing required fields |
| `"Session 'X' already exists"` | `/session/start`, `/session/fork` | Duplicate session name |
| `"Session 'X' not found"` | `/session/send`, `/session/send-stream`, `/session/stop`, `/session/status`, `/session/history`, `/session/pause`, `/session/resume`, `/session/fork`, `/session/restart` | No session with that name |
| `"Session 'X' is paused"` | `/session/send`, `/session/send-stream` | Session was paused; call `/session/resume` first |
| `"Not connected"` | `/tools` | `/connect` has not been called |
| `"Claude invocation failed"` | `/call`, `/resume`, `/continue`, `/session/send` | Claude CLI process failed or returned no output |

### Claude CLI Exit Code Classification

When the Claude CLI process exits with a non-zero code, the server classifies it internally:

| Exit code | Category |
|---|---|
| 0 | `success` |
| 1 | `runtime_error` |
| 2 | `usage_error` |
| -1 | `process_failure` |
| other | `unknown_error_{code}` |

---

## Complete Endpoint Reference

| # | Method | Path | Description |
|---|---|---|---|
| 1 | POST | `/connect` | Verify Claude binary and connect |
| 2 | POST | `/disconnect` | Kill sessions and disconnect |
| 3 | GET | `/tools` | List available tools |
| 4 | POST | `/bash` | Execute a shell command |
| 5 | POST | `/read` | Read a single file |
| 6 | POST | `/call` | Invoke any Claude tool |
| 7 | GET | `/sessions` | List filesystem session history |
| 8 | POST | `/batch-read` | Read multiple files by glob |
| 9 | POST | `/resume` | Resume a Claude CLI session by ID |
| 10 | POST | `/continue` | Continue the most recent session |
| 11 | POST | `/session/start` | Create a persistent session |
| 12 | POST | `/session/send` | Send message (blocking) |
| 13 | POST | `/session/send-stream` | Send message (SSE stream) |
| 14 | GET | `/session/list` | List active persistent sessions |
| 15 | POST | `/session/stop` | Stop and delete a session |
| 16 | POST | `/session/status` | Get session status and stats |
| 17 | POST | `/session/history` | Get conversation history |
| 18 | POST | `/session/pause` | Pause a session |
| 19 | POST | `/session/resume` | Resume a paused session |
| 20 | POST | `/session/fork` | Fork a session |
| 21 | POST | `/session/search` | Search sessions |
| 22 | POST | `/session/restart` | Restart a session (reset state) |

All paths are relative to the base prefix: `/backend-api/claude-code`.
