// Step ④: measure the /chat/stop contract, so the bridge can stop the daemon's
// turn when a plugin-side abort closes the HTTP stream.
//
// ⚠️ COST: none — it never stops a REAL turn. The guard below refuses to run
// while any session is active (`GET /chat/active`), and the only stop request
// it sends names a session id that cannot exist ("probe-...-never"). Worst case
// the daemon answers "was not running".
//
// What this proved (daemon 5.2.3, 2026-10-17):
//   A. no auth            → HTTP 401 (the endpoint EXISTS; only the auth gate)
//   B. body {}            → HTTP 422 "missing field `session_id`" — the id is
//                           REQUIRED, there is no "stop whatever is running"
//   C. unknown session id → HTTP 200 {"success":true,"message":"Chat session
//                           <id> was not running"} — a 200 does NOT mean a turn
//                           was stopped, so `ok` must mean "the daemon
//                           processed the request", not "the turn is gone"
//
// Reads the token from ~/.atomcode/daemon-<port>.json at runtime; never
// hardcodes it. Usage: node scripts/probes/chat-stop.mjs [port]
import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.argv[2] || 13459);
const base = `http://127.0.0.1:${port}`;

const tokenFile = join(homedir(), '.atomcode', `daemon-${port}.json`);
let token = '';
try {
  token = JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token || '';
} catch {
  console.log(`no token file at ${tokenFile} — probing unauthenticated only`);
}
const auth = token ? { Authorization: `Bearer ${token}` } : {};

const show = async (label, method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...auth },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  console.log(`${label}: ${method} ${path} → HTTP ${res.status} ${text.slice(0, 200)}`);
  return { status: res.status, text };
};

console.log(`daemon: ${base} (token: ${token ? 'yes' : 'none'})`);

// Guard: never send a stop while a real turn is running.
const active = await fetch(`${base}/chat/active`, { headers: auth }).then((r) => r.json()).catch(() => null);
if (Array.isArray(active) && active.length > 0) {
  console.error(`REFUSING to probe: ${active.length} chat session(s) active right now (${JSON.stringify(active)})`);
  process.exit(1);
}
console.log(`no active chat sessions (${JSON.stringify(active)}) — safe to probe`);

if (!token) {
  await show('A  no auth', 'POST', '/chat/stop', {});
  process.exit(0);
}
await show('A  unauthenticated shape is checked by the 401 path — skipped here', 'GET', '/health');
await show('B  empty body (no session_id)', 'POST', '/chat/stop', {});
await show('C  a session id that cannot exist', 'POST', '/chat/stop', {
  session_id: `probe-${port}-never-existed`,
});
