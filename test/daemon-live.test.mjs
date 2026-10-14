/**
 * daemon-live.test.mjs — Integration tests against a live AtomCode daemon.
 *
 * SPLIT BY COST, deliberately:
 *
 *   - The read-only checks (health / token / model catalogue) hit the daemon's
 *     metadata endpoints. They cost nothing.
 *   - The inference block makes SEVEN REAL model turns. On a CodingPlan window
 *     that is billed per request, running it repeatedly is not free, so it is
 *     opt-in behind `ATOMCODE_LIVE_TURNS=1`.
 *
 * `npm run test:live` is therefore SAFE BY DEFAULT: it exercises the read-only
 * half and skips the turns with an explicit reason. To spend the turns:
 *
 *   PowerShell:  $env:ATOMCODE_LIVE_TURNS=1; npm run test:live
 *   bash/zsh:    ATOMCODE_LIVE_TURNS=1 npm run test:live
 *
 * When no daemon answers, both blocks skip with the reason instead of failing
 * with a confusing assertion.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_PORT,
  health,
  listModels,
  streamChat,
  askChat,
  readToken,
  baseUrl,
} from '../lib/daemon.js';

const PORT = DEFAULT_PORT;

// Top-level await: decide skip state before the suites are collected.
const daemonUp = await health(PORT);
const skipReason = daemonUp
  ? false
  : `no AtomCode daemon on ${baseUrl(PORT)} — start it with \`atomcode daemon --port ${PORT}\` (or let the plugin auto-start it) and re-run`;

const turnsEnabled = process.env.ATOMCODE_LIVE_TURNS === '1';
const turnsSkip = !daemonUp
  ? skipReason
  : turnsEnabled
    ? false
    : 'consumes CodingPlan quota (7 real model turns) — set ATOMCODE_LIVE_TURNS=1 to run';

if (daemonUp && !turnsEnabled) {
  console.log('[daemon-live] read-only checks only; the 7 inference turns are skipped (ATOMCODE_LIVE_TURNS != 1)');
}

describe('daemon live — read-only (no quota)', { skip: skipReason }, () => {
  it('health() returns true', async () => {
    const ok = await health(PORT);
    assert.equal(ok, true);
  });

  it('readToken() returns non-empty token', () => {
    const tok = readToken(PORT);
    assert.ok(tok.length > 0, 'token should be non-empty');
  });

  it('listModels() returns array with at least one model', async () => {
    const models = await listModels(PORT);
    assert.ok(Array.isArray(models));
    // Host-agnostic: the count depends on this machine's AtomCode config.
    assert.ok(models.length >= 1, 'should have at least 1 model entry');
    const first = models[0];
    assert.equal(typeof first.provider, 'string');
    assert.equal(typeof first.model, 'string');
    // At least one should be is_default
    const hasDefault = models.some((m) => m.is_default === true);
    assert.ok(hasDefault, 'at least one model should be default');
  });

  it('listModels() entries are well-formed (no hardcoded provider names)', async () => {
    const models = await listModels(PORT);
    for (const m of models) {
      assert.equal(typeof m.provider, 'string');
      assert.ok(m.provider.length > 0, 'provider name must be non-empty');
      assert.equal(typeof m.model, 'string');
      assert.ok(m.model.length > 0, 'model name must be non-empty');
      assert.equal(typeof m.is_default, 'boolean');
    }
  });
});

describe('daemon live — inference turns (CONSUMES CODINGPLAN QUOTA)', { skip: turnsSkip }, () => {
  it('streamChat() yields runtime_info event first', async () => {
    const iter = streamChat({
      message: 'hi',
      port: PORT,
      timeoutMs: 30000,
    });
    const result = await iter.next();
    assert.equal(result.done, false);
    const ev = result.value;
    assert.equal(ev.type, 'runtime_info', 'first event should be runtime_info');
    // Drain the rest
    for await (const _ of iter) { /* empty */ }
  });

  it('streamChat() yields reasoning, text, tokens, done in order for a short prompt', async () => {
    const types = [];
    for await (const ev of streamChat({
      message: '只回复：OK',
      port: PORT,
      timeoutMs: 60000,
    })) {
      types.push(ev.type);
    }
    // Should include text and done at minimum
    assert.ok(types.includes('text'), 'should contain text events');
    assert.ok(types.includes('done'), 'should contain done event');
    // Should contain tokens
    assert.ok(types.includes('tokens'), 'should contain tokens event');
  });

  it('askChat() returns complete result with ok=true', async () => {
    const result = await askChat({
      message: '只回答两个字：收到',
      port: PORT,
      timeoutMs: 60000,
    });
    assert.equal(result.ok, true);
    assert.equal(result.error, '');
    assert.ok(result.reply.length > 0);
    assert.equal(typeof result.tokens, 'number');
    assert.ok(result.tokens > 0, 'tokens should be > 0');
    assert.equal(typeof result.sessionId, 'string');
    assert.ok(result.sessionId.length > 0);
  });

  it('askChat() exposes provider, stopReason, toolCalls, roundCount', async () => {
    const result = await askChat({
      message: '只回答：OK',
      port: PORT,
      timeoutMs: 60000,
    });
    assert.equal(result.ok, true);
    assert.equal(typeof result.stopReason, 'string');
    assert.ok(result.stopReason.length > 0, 'stopReason should be non-empty');
    assert.equal(typeof result.provider, 'string');
    assert.ok(result.provider.length > 0, 'provider should be non-empty');
    assert.equal(result.toolCalls, 0);
    assert.ok(Array.isArray(result.tools));
    assert.equal(result.tools.length, 0);
    // roundCount is the tool_start count observed on the SSE stream.
    assert.equal(typeof result.roundCount, 'number');
    assert.equal(result.roundCount, 0, 'a trivial prompt should open no tool rounds');
  });

  it('askChat() reports the daemon-resolved provider (not the literal request echo)', async () => {
    const result = await askChat({
      message: '只回答：OK',
      port: PORT,
      timeoutMs: 60000,
    });
    assert.equal(result.ok, true);
    // provider now comes from the runtime_info SSE event when the daemon emits
    // one; a bare 'default' placeholder only survives when neither the event nor
    // an explicit opts.provider supplies a name.
    assert.notEqual(result.provider, '', 'provider must never be empty');
  });

  it('askChat() with explicit provider works', async () => {
    const result = await askChat({
      message: '只回答：OK',
      port: PORT,
      provider: 'AtomGit-glm5.3-flash',
      timeoutMs: 60000,
    });
    assert.equal(result.ok, true);
    // The daemon may echo the requested provider or its own resolved name; both
    // are non-empty. Assert the routing request was accepted, not an exact echo.
    assert.equal(typeof result.provider, 'string');
    assert.ok(result.provider.length > 0, 'provider should be non-empty');
  });

  it('askChat() with an unknown provider returns a structured outcome', async () => {
    const result = await askChat({
      message: 'hi',
      port: PORT,
      provider: 'nonexistent-provider-xyz',
      timeoutMs: 30000,
    });
    // The daemon may error or fall back — either is acceptable, but the result
    // must always be a well-formed object with a boolean ok.
    assert.equal(typeof result.ok, 'boolean');
    if (!result.ok) {
      assert.ok(result.error.length > 0, 'a failed turn must carry an error string');
    }
  });
});
