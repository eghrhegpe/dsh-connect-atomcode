// Probe: what does a NON-bypass /chat turn actually do when unattended?
//
// Resolves the open DECISIONS item: the README tells shared-repo users to set
// approval_mode to a non-bypass value, while DECISIONS.md says that leaves the
// unattended turn stuck on interactive approval (tool unusable). This probe
// measures the real daemon instead of guessing.
//
// ⚠️ COST: one small model turn (flash tier, one bash call in a throwaway
// temp dir). Guards: refuses to run while GET /chat/active shows a session;
// falls back to POST /chat/stop if the turn does not settle.
//
// What it answers:
//   1. accepted approval_mode values — a bogus value is 422'd by the daemon
//      BEFORE any model call (zero quota; the chat-stop.mjs 422 trick):
//      expected one of `build`, `accept_edits`, `bypass`, `plan`
//      (5.2.3, 2026-10-17) — note: the `on-request` our unit tests use is NOT
//      a daemon value; only the fake daemons in test/ ever saw it
//   2. on a real non-bypass turn with a COMMAND-class tool call (bash write):
//      does it stall on `permission_request`, auto-deny
//      (`[denied] .. requires interactive approval`), or auto-approve
//      (`[headless] auto-approved`)? The prompt is deliberately a bash write —
//      read-only tools are NOT the approval class, so a read-only listing
//      proves nothing (measured: build + read-only listing settles in 5s with
//      zero permission_request, 2026-10-17).
//   3. when it stalls, does POST /chat/permission {session_id, decision,
//      tool_name} (the SPA's own approval channel, Y/A/N) unstick it?
//
// What this proved (daemon 5.2.3, 2026-10-17, flash tier):
//   1. `approval_mode` is a closed enum: `build | accept_edits | bypass |
//      plan` (the 422 gate, zero quota). `on-request` — used by our unit
//      tests — is NOT a daemon value; only the fake daemons in test/ accept it.
//   2. An unattended NON-bypass turn does NOT stall on approval. Forced-command
//      turns (bash write) under both `build` and `accept_edits` finished in
//      7–8s with `tool_result success=true` and zero `permission_request`:
//      the headless daemon auto-approves the ask-class (binary string
//      `[headless] auto-approved`; this machine's config.toml carries no
//      approval/yolo/ask-timeout keys, so it is daemon design, not config).
//   3. Consequence: switching a shared repo OFF `bypass` buys no human gate
//      (non-bypass behaves like bypass for commands, unattended) and DROPS
//      the plugin's missing-directory refusal, which fires only on the
//      `bypass` pairing. The README's "shared repo: set non-bypass" advice
//      is therefore retracted; docs/DECISIONS.md records the resolution.
//
// Reads the token from ~/.atomcode/daemon-<port>.json at runtime; never
// hardcodes it. Usage: node scripts/probes/approval-mode.mjs [port] [approval_mode]
// (default mode: accept_edits — "auto-approve file edits, ask for commands")
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homedir } from 'node:os';

const port = Number(process.argv[2] || 13459);
const base = `http://127.0.0.1:${port}`;
const tokenFile = path.join(homedir(), '.atomcode', `daemon-${port}.json`);
let token = '';
try {
  token = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token || '';
} catch {
  console.error(`no token file at ${tokenFile} — the daemon on ${port} needs auth; cannot probe`);
  process.exit(1);
}
const auth = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };

// Guard: never start a probe turn while a real session is active.
const active = await fetch(`${base}/chat/active`, { headers: auth }).then((r) => r.json()).catch(() => null);
if (Array.isArray(active) && active.length > 0) {
  console.error(`REFUSING: ${active.length} chat session(s) active right now (${JSON.stringify(active)})`);
  process.exit(1);
}
console.log(`no active chat sessions — safe to probe`);

// Part 1 (zero quota): enumerate the accepted enum via the 422 parameter gate.
{
  const res = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ message: 'hi', approval_mode: 'definitely-not-a-value', working_dir: homedir() }),
  });
  const text = await res.text();
  console.log(`enum gate: HTTP ${res.status} ${(res.headers.get('content-type') || '').split(';')[0]} ${text.slice(0, 300)}`);
}

// Part 2: one real NON-bypass turn in a throwaway dir.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atomcode-approval-probe-'));
fs.writeFileSync(path.join(scratch, 'probe.txt'), 'probe\n');
console.log(`scratch dir: ${scratch}`);

// Cheapest tier if the catalog has one, else the daemon's own default.
let provider = '';
try {
  const models = await fetch(`${base}/models`, { headers: auth }).then((r) => r.json());
  const list = Array.isArray(models) ? models : models?.models || [];
  const flash = list.find((m) => String(m?.model || '').includes('flash')) || list.find((m) => m?.is_default);
  if (flash?.provider) provider = String(flash.provider);
} catch {
  /* default tier */
}
console.log(`provider: ${provider || '(daemon default)'}`);

// The prompt forces a COMMAND-class tool call (bash). That matters: the
// DECISIONS claim is that an unattended non-bypass turn STALLS on interactive
// approval. Read-only tools (file listing) are auto-run even under `build`
// (measured 2026-10-17: zero permission_request, turn settles in 5s), so a
// read-only prompt would not exercise the approval path at all. Under
// `accept_edits` ("auto-approve file edits, ask for commands") a bash call is
// exactly the class that must be asked about — the decisive test.
const mode = process.argv[3] || 'accept_edits';
const body = {
  message:
    '请在当前目录创建一个空文件 probe.txt（用 write_file 之类的文件工具），然后用 bash 工具执行 `echo probe > probe2.txt`。不要做其他事。',
  approval_mode: mode,
  working_dir: scratch,
  ...(provider ? { provider } : {}),
};
console.log(`POST /chat ${JSON.stringify(body)}`);

const res = await fetch(`${base}/chat`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
const ct = res.headers.get('content-type') || '';
if (!ct.includes('event-stream')) {
  console.log(`no SSE: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  process.exit(0);
}

// Consume the SSE stream, logging every event with an offset.
const started = Date.now();
const decoder = new TextDecoder();
let buf = '';
let session_id = null;
let pendingPermission = null;
const seen = [];
let streamDone = false;

async function nextEvent(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (buf.includes('\n')) {
      const idx = buf.indexOf('\n');
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.startsWith('data:')) {
        let ev;
        try {
          ev = JSON.parse(line.slice(5));
        } catch {
          continue;
        }
        seen.push([Math.round((Date.now() - started) / 1000), ev.type || '?', ev]);
        if (ev.type === 'session_assigned') session_id = ev.session_id;
        if (ev.type === 'permission_request' && !pendingPermission) pendingPermission = ev;
        return ev;
      }
    }
    let chunk;
    try {
      const r = await readNextChunk(res.body);
      if (r === null) { streamDone = true; continue; }
      chunk = r;
    } catch {
      streamDone = true;
      continue;
    }
    buf += decoder.decode(chunk, { stream: true });
  }
  return null;
}

// res.body is a WHATWG ReadableStream: read one chunk at a time.
const reader = res.body.getReader();
async function readNextChunk() {
  const { value, done } = await reader.read();
  return done ? null : value;
}

let ev = await nextEvent(60_000);
while (ev) {
  const t = seen[seen.length - 1][0];
  const detail =
    ev.type === 'permission_request'
      ? ` ${JSON.stringify(ev)}`
      : ev.type === 'tool_start'
        ? ` name=${ev.name}`
        : ev.type === 'tool_result'
          ? ` success=${ev.success}`
          : ev.type === 'done'
            ? ` stop_reason=${ev.stop_reason} tool_calls=${ev.tool_calls ?? ev.stats?.tool_calls}`
            : '';
  console.log(`[${t}s] ${ev.type}${detail}`);
  if (ev.type === 'permission_request') {
    // Wait briefly: the daemon may auto-deny / auto-approve headless instead of
    // actually waiting for an answer.
    ev = await nextEvent(12_000);
    continue;
  }
  if (ev.type === 'done' || ev.type === 'error') break;
  ev = await nextEvent(60_000);
  if (ev === null && streamDone) break;
}

if (pendingPermission && session_id) {
  console.log(`stalled on permission_request: ${JSON.stringify(pendingPermission)}`);
  const stall = await fetch(`${base}/chat/active`, { headers: auth }).then((r) => r.json()).catch(() => null);
  console.log(`/chat/active while stalled: ${JSON.stringify(stall)?.slice(0, 300)}`);
  const tool = pendingPermission.tool_name;
  const answer = await fetch(`${base}/chat/permission`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ session_id, decision: 'Y', tool_name: tool }),
  }).then((r) => r.json().catch(() => ({ status: r.status })));
  console.log(`POST /chat/permission {session_id, decision:"Y", tool_name:${JSON.stringify(tool)}} → ${JSON.stringify(answer)?.slice(0, 300)}`);
  // Drain the stream to the terminal event (or stop it if the answer did not
  // unstick it).
  let ev2 = await nextEvent(90_000);
  while (ev2) {
    const t = seen[seen.length - 1][0];
    console.log(`[${t}s] ${ev2.type}`);
    if (ev2.type === 'done' || ev2.type === 'error') break;
    ev2 = await nextEvent(90_000);
  }
  if (ev2?.type !== 'done' && ev2?.type !== 'error' && session_id) {
    const stop = await fetch(`${base}/chat/stop`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ session_id }),
    }).then((r) => r.json().catch(() => ({ status: r.status })));
    console.log(`still stuck — POST /chat/stop → ${JSON.stringify(stop)?.slice(0, 300)}`);
  }
} else if (!pendingPermission) {
  console.log(`turn settled without any permission_request (events: ${seen.map((s) => s[1]).join(' → ')})`);
}

console.log(`event sequence: ${seen.map((s) => s[1]).join(' → ')}`);
fs.rmSync(scratch, { recursive: true, force: true });
