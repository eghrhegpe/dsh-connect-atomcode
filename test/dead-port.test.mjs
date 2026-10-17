/**
 * dead-port.test.mjs — the sentinel discipline is machine-pinned, not a comment.
 *
 * Why a guard suite and not a note: the old failure was two suites independently
 * picking the same hardcoded "nothing listens here" port, and every runner in
 * the repo paying SERIAL for that collision. A convention ("use the helper")
 * rots the moment someone copies a mount fixture with its literal; these
 * assertions are what make the parallel default in scripts/test.mjs safe to
 * KEEP, and they fail in the direction that matters — a suite that quietly
 * re-hardcodes its port turns the whole tree red, not green.
 *
 * Scans read every `test/*.test.mjs` as TEXT with comments stripped (the same
 * predicate style as test/env-hermetic.test.mjs enforces: prose must not join a
 * scan set, and every scan asserts its own liveness — a predicate that can only
 * say "yes" is not a predicate). This file imports no artifact and mounts
 * nothing: it is deliberately invisible to the host-bundle HOME/state_path scan
 * it reads.
 *
 * The uniqueness scan EXCLUDES this file: the helper's arithmetic probes below
 * call `sentinelPort` with arbitrary offsets, and policing the guard's own test
 * digits would flag the tool for using the tool. The literal ban covers it.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { DEFAULT_BASE, DYNAMIC_BAND_FLOOR, requireDeadPort, sentinelPort } from './dead-port.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = join(ROOT, 'test');

/** Strip line comments and block comments so prose never joins a scan set. */
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const OFFSET_RE = /sentinelPort\((\d+)\)/g;
const LEGACY_RE = /459\d\d/;
const HARDCODE_RE = /CLOSED_PORT\s*=\s*\d/;

const scanned = readdirSync(TEST_DIR)
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => ({ name: f, stripped: withoutComments(readFileSync(join(TEST_DIR, f), 'utf8')) }));

const offsetUsers = scanned
  .filter((s) => s.name !== 'dead-port.test.mjs')
  .flatMap((s) => [...s.stripped.matchAll(OFFSET_RE)].map((m) => ({ file: s.name, offset: Number(m[1]) })));

describe('dead-port sentinels — unique, literal-free, and below every dynamic band', () => {
  it('every sentinel offset is taken by exactly one use site', () => {
    // Liveness: the scan must actually see the sites the helper documents (1..12
    // across seven suites). A near-zero count means the predicate broke, not
    // that the discipline holds.
    assert.ok(
      offsetUsers.length >= 12,
      `扫描面不对：只认出 ${offsetUsers.length} 处 sentinelPort 调用（应 ≥10）——判据本身失效时这里就会红`,
    );
    const byOffset = new Map();
    for (const u of offsetUsers) {
      const seen = byOffset.get(u.offset) ?? [];
      seen.push(u.file);
      byOffset.set(u.offset, seen);
    }
    const dupes = [...byOffset].filter(([, files]) => files.length > 1);
    assert.deepEqual(
      dupes,
      [],
      '每个哨兵偏移只许有一个使用点——两个套件挂同一个号，就是当年逼 runner 全串行的那个事故：' +
        dupes.map(([o, files]) => `offset ${o}: ${files.join(', ')}`).join('; '),
    );
  });

  it('no suite re-hardcodes the old sentinel band or a CLOSED_PORT literal', () => {
    // This guard file is excluded for the same reason as the offset census: it
    // LEGITIMATELY contains the forbidden shapes — LEGACY_RE itself, and the
    // planted sample below that proves the scan actually fires.
    const offenders = scanned
      .filter((s) => s.name !== 'dead-port.test.mjs')
      .filter((s) => LEGACY_RE.test(s.stripped) || HARDCODE_RE.test(s.stripped))
      .map((s) => `test/${s.name}`);
    assert.deepEqual(
      offenders,
      [],
      '「这里没有服务」的端口只能来自 dead-port.mjs 的偏移表——写死字面量（尤其旧 459xx 段，' +
        '它整个落在 OS 动态端口段里）就是重新引入那次撞号事故：' +
        offenders.join(', '),
    );
    // The predicate must be able to say "no": planted samples prove it bites.
    assert.equal(LEGACY_RE.test(withoutComments(`mod.apply(ctx, { port: 45999 });`)), true);
    assert.equal(HARDCODE_RE.test(withoutComments(`const CLOSED_PORT = 45992;`)), true);
    assert.equal(
      LEGACY_RE.test(withoutComments(`// the old 459xx band, prose only\nport: sentinelPort(4),`)),
      false,
      '剥注释必须真剥——历史注释里提到旧号不该让文件变红',
    );
  });

  it('the default band + every used offset stays under every OS dynamic range', () => {
    const maxOffset = Math.max(...offsetUsers.map((u) => u.offset));
    assert.ok(DEFAULT_BASE >= 1024, 'the band must not squat on privileged ports');
    assert.ok(
      DEFAULT_BASE + maxOffset < DYNAMIC_BAND_FLOOR,
      `哨兵顶端 ${DEFAULT_BASE + maxOffset} 越过了动态段下限 ${DYNAMIC_BAND_FLOOR}——` +
        '并行时 listen(0) 就可能被派到某个哨兵号上，"nothing listens" 重新变成假设',
    );
  });

  it('requireDeadPort proves the sentinel free, and refuses to pass a live port', async () => {
    const free = await requireDeadPort(sentinelPort(0));
    assert.ok(
      Number.isInteger(free) && free < DYNAMIC_BAND_FLOOR,
      `the probe port must come back as a number inside the pinned band (got ${free})`,
    );

    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const busy = server.address().port;
    try {
      await assert.rejects(() => requireDeadPort(busy), (err) => {
        assert.match(err.message, /is NOT free/, 'the refusal must be NAMED — a silent pass here is the bug this whole helper exists to catch');
        assert.match(err.message, /ATOMCODE_TEST_PORT_BASE/, 'and it must tell the developer the one fix: move the whole band');
        return true;
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('a malformed ATOMCODE_TEST_PORT_BASE throws instead of silently re-colliding', () => {
    const saved = process.env.ATOMCODE_TEST_PORT_BASE;
    try {
      process.env.ATOMCODE_TEST_PORT_BASE = '22000';
      assert.equal(sentinelPort(0 + 3), 22003, 'the override must move the WHOLE band');
      for (const bad of ['30000.5', 'not-a-port', '0', '80', '65000']) {
        process.env.ATOMCODE_TEST_PORT_BASE = bad;
        assert.throws(() => sentinelPort(0 + 1), /ATOMCODE_TEST_PORT_BASE/, `ATOMCODE_TEST_PORT_BASE=${bad} must throw, not default`);
      }
      process.env.ATOMCODE_TEST_PORT_BASE = '';
      assert.equal(sentinelPort(0 + 1), DEFAULT_BASE + 1, 'empty is the documented "no opinion" spelling');
    } finally {
      if (saved === undefined) delete process.env.ATOMCODE_TEST_PORT_BASE;
      else process.env.ATOMCODE_TEST_PORT_BASE = saved;
    }
  });
});
