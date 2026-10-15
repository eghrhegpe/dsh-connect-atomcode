// Probe the AtomGit gateway signature gate: unsigned vs fake vs real signature.
// Uses a deliberately nonexistent model so a passed gate yields a model error,
// not a completed completion -> zero quota consumption.
//
// ✅ COST: zero. Both gateways are probed with a request that dies at the model
// gate / schema validation, so no completion is ever billed. This is the
// experiment behind docs/AtomGit-网关与-review-通路.md §「签名门到底验什么」.
// Reads the token from ~/.atomcode/auth.toml at runtime (never hardcodes it,
// and prints only its length + 8-char head).
//
// Archived from the repo root as `.probe-signing.mjs` (2026-10-16).
// Override the second gateway with PROBE_GW=<url> when re-running.
import fs from 'node:fs';
import crypto from 'node:crypto';

const auth = fs.readFileSync(process.env.USERPROFILE + '/.atomcode/auth.toml', 'utf8');
const token = (auth.match(/access_token\s*=\s*"([^"]+)"/) || [])[1];
if (!token) { console.log('NO TOKEN'); process.exit(1); }
console.log(`token len=${token.length} head=${token.slice(0, 8)}`);

const gw = 'https://llm-api.atomgit.com';
const path = '/v1/chat/completions';
// Round 2: real model name (passes the model gate, which fires first) +
// deliberately malformed messages (so a passed signature gate dies at schema
// validation instead of running a real completion -> still zero quota).
const body = JSON.stringify({ model: 'qwen3.8-27b', messages: 'not-an-array', max_tokens: 1 });
const bodyHash = crypto.createHash('sha256').update(body).digest('hex');

// HKDF-SHA256 exactly as signing.py: salt='atomcode-signing-v1', info='v1:', len=32
const prk = crypto.hkdfSync('sha256', Buffer.from(token), Buffer.from('atomcode-signing-v1'), Buffer.from('v1:'), 32);

const sign = (ts, nonce) =>
  crypto.createHmac('sha256', prk)
    .update(`POST\n${path}\n${bodyHash}\n${ts}\n${nonce}`)
    .digest('hex');

// Round 4: also test api-ai.gitcode.com — atomcode-open-api's default gateway.
// Gate order observed so far: model gate first (fires even unsigned), then the
// signature gate. Malformed messages keeps us at schema validation if both pass.
const GW = process.env.PROBE_GW || 'https://llm-api.atomgit.com';

async function probe(name, mode) {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (mode === 'fake') Object.assign(headers, {
    'X-AtomCode-Sig': 'atomcode-open-api', 'X-AtomCode-Ts': ts,
    'X-AtomCode-Nonce': nonce, 'X-AtomCode-Alg': 'atomcode-signing-v1', 'X-AtomCode-Ver': 'v1',
  });
  if (mode === 'real') Object.assign(headers, {
    'X-AtomCode-Sig': sign(ts, nonce), 'X-AtomCode-Ts': ts,
    'X-AtomCode-Nonce': nonce, 'X-AtomCode-Alg': 'atomcode-signing-v1', 'X-AtomCode-Ver': 'v1',
  });
  // Round 3: the binary also has an X-AtomCode-Client header — maybe the gate
  // greps for a header set that includes it (hence _MISSING, not _INVALID).
  if (mode === 'fake-c' || mode === 'real-c') headers['X-AtomCode-Client'] = 'atomcode/5.2.3';
  try {
    const r = await fetch(GW + path, { method: 'POST', headers, body });
    const text = await r.text();
    console.log(`[${name}] HTTP ${r.status}: ${text.slice(0, 400)}`);
  } catch (e) {
    console.log(`[${name}] ERR: ${e.message}`);
  }
}

await probe('A unsigned', null);
await probe('B fake-sig', 'fake');
await probe('C real-sig', 'real');
await probe('D fake+client', 'fake-c');
await probe('E real+client', 'real-c');

// Round 5: GET /v1/models on both gateways (list endpoint, zero quota) —
// does the token resolve, and which model ids does each gateway expose?
for (const base of ['https://api-ai.gitcode.com', 'https://llm-api.atomgit.com']) {
  try {
    const r = await fetch(base + '/v1/models', { headers: { Authorization: `Bearer ${token}` } });
    const t = await r.text();
    if (r.status === 200) {
      const j = JSON.parse(t);
      console.log(`[models ${base}] 200, count=${(j.data || []).length}`);
      console.log(`  ids: ${(j.data || []).map(m => m.id).join(', ')}`);
    } else console.log(`[models ${base}] ${r.status}: ${t.slice(0, 300)}`);
  } catch (e) { console.log(`[models ${base}] ERR ${e.message}`); }
}
