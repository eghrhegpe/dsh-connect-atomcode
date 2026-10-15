// Step ①: one REAL completion against api-ai.gitcode.com (costs 1 quota turn)
// to prove the gateway path end-to-end before wiring the proxy.
//
// ⚠️ COST: ONE real completion turn on the CodingPlan window. This is the
// experiment that proved api-ai.gitcode.com accepts an unsigned bearer request
// (see docs/AtomGit-网关与-review-通路.md §「签名门到底验什么」, probe row A).
// Reads the token from ~/.atomcode/auth.toml at runtime; never hardcodes it.
//
// Archived from the repo root as `.probe-real-call.mjs` (2026-10-16).
import fs from 'node:fs';

const auth = fs.readFileSync(process.env.USERPROFILE + '/.atomcode/auth.toml', 'utf8');
const token = (auth.match(/access_token\s*=\s*"([^"]+)"/) || [])[1];

const body = JSON.stringify({
  model: 'deepseek-ai/DeepSeek-V4-Flash',
  messages: [{ role: 'user', content: '只回复两个字：通了' }],
  max_tokens: 20,
  stream: false,
});

const r = await fetch('https://api-ai.gitcode.com/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body,
});
const text = await r.text();
console.log(`HTTP ${r.status}`);
try {
  const j = JSON.parse(text);
  if (j.choices) {
    console.log(`model=${j.model} content=${JSON.stringify(j.choices[0]?.message?.content)}`);
    console.log(`usage=${JSON.stringify(j.usage)}`);
  } else console.log(text.slice(0, 500));
} catch { console.log(text.slice(0, 500)); }
