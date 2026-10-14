/**
 * daemon-parse.test.mjs — Pure-function tests for daemon.js helpers.
 * No daemon or network required.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_PORT,
  baseUrl,
  parseSseLine,
  defaultBinary,
} from '../lib/daemon.js';

describe('daemon.js — pure helpers', () => {
  it('DEFAULT_PORT is 13459', () => {
    assert.equal(DEFAULT_PORT, 13459);
  });

  it('baseUrl forms correct localhost URL', () => {
    assert.equal(baseUrl(13459), 'http://127.0.0.1:13459');
    assert.equal(baseUrl(8080), 'http://127.0.0.1:8080');
  });

  it('parseSseLine parses data: JSON lines', () => {
    const ev = parseSseLine('data: {"type":"text","content":"hello"}');
    assert.notEqual(ev, undefined);
    assert.equal(ev.type, 'text');
    assert.equal(ev.content, 'hello');
  });

  it('parseSseLine returns undefined for non-data lines', () => {
    assert.equal(parseSseLine(': keepalive'), undefined);
    assert.equal(parseSseLine('event: message'), undefined);
    assert.equal(parseSseLine(''), undefined);
    assert.equal(parseSseLine('  '), undefined);
  });

  it('parseSseLine returns undefined for [DONE]', () => {
    assert.equal(parseSseLine('data: [DONE]'), undefined);
  });

  it('parseSseLine returns undefined for malformed JSON', () => {
    assert.equal(parseSseLine('data: {bad json}'), undefined);
  });

  it('defaultBinary returns atomcode.exe on win32', () => {
    assert.equal(defaultBinary('win32'), 'atomcode.exe');
  });

  it('defaultBinary returns atomcode on non-win32', () => {
    assert.equal(defaultBinary('linux'), 'atomcode');
    assert.equal(defaultBinary('darwin'), 'atomcode');
  });

  it('parseSseLine handles empty data payload', () => {
    assert.equal(parseSseLine('data: '), undefined);
    assert.equal(parseSseLine('data:'), undefined);
  });

  it('parseSseLine handles tokens event', () => {
    const ev = parseSseLine('data: {"type":"tokens","prompt":100,"completion":50,"total":150}');
    assert.equal(ev.type, 'tokens');
    assert.equal(ev.total, 150);
  });

  it('parseSseLine handles done event', () => {
    const ev = parseSseLine('data: {"type":"done","tokens":123,"tool_calls":2,"session_id":"abc","stop_reason":"stopped"}');
    assert.equal(ev.type, 'done');
    assert.equal(ev.tokens, 123);
    assert.equal(ev.stop_reason, 'stopped');
  });
});
