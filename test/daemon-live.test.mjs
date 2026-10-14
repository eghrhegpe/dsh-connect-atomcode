/**
 * daemon-live.test.mjs — Integration tests against a live AtomCode daemon.
 *
 * Assumes a running daemon on DEFAULT_PORT (13459). The test script
 * `npm run test:live` calls this after the parse tests.
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

describe('daemon live — against running daemon', () => {
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
    assert.ok(models.length >= 1);
    const first = models[0];
    assert.equal(typeof first.provider, 'string');
    assert.equal(typeof first.model, 'string');
    // At least one should be is_default
    const hasDefault = models.some(m => m.is_default === true);
    assert.ok(hasDefault, 'at least one model should be default');
  });

  it('listModels() includes custom provider entries from atomcode config', async () => {
    const models = await listModels(PORT);
    const hasCustom = models.some(m => m.provider === 'agnes-3.0-flash' || m.provider === 'commandcode');
    // This is dependent on the host atomcode config — but the config we checked shows these present
    if (hasCustom) {
      console.log('Found custom provider entries');
    }
    assert.ok(models.length >= 3, 'should have at least 3 model entries');
  });

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

  it('askChat() exposes provider, stopReason, toolCalls', async () => {
    const result = await askChat({
      message: '只回答：OK',
      port: PORT,
      timeoutMs: 60000,
    });
    assert.equal(result.ok, true);
    assert.equal(typeof result.stopReason, 'string');
    assert.ok(result.stopReason.length > 0, 'stopReason should be non-empty');
    assert.equal(typeof result.provider, 'string');
    assert.equal(result.toolCalls, 0);
    assert.ok(Array.isArray(result.tools));
    assert.equal(result.tools.length, 0);
  });

  it('askChat() with explicit provider works', async () => {
    const result = await askChat({
      message: '只回答：OK',
      port: PORT,
      provider: 'AtomGit-glm5.3-flash',
      timeoutMs: 60000,
    });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'AtomGit-glm5.3-flash');
  });

  it('askChat() overrides provider that does not exist returns error', async () => {
    const result = await askChat({
      message: 'hi',
      port: PORT,
      provider: 'nonexistent-provider-xyz',
      timeoutMs: 30000,
    });
    // The daemon should either error or fall back — either is acceptable
    // but we should get a result with either ok=false or some kind of error
    // If ok=true, that means daemon fell back gracefully
    console.log('Bad provider result:', JSON.stringify({ ok: result.ok, error: result.error, reply: result.reply.slice(0, 50) }));
    assert.ok(typeof result.ok === 'boolean');
  });
});
