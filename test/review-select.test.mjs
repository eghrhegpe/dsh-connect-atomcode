/**
 * review-select.test.mjs — execute-time provider selection + local endpoint probe.
 *
 * These are the v0.4.1 additions that close two measured gaps:
 *   1. On an AtomGit login host the CLI's default_provider has no base_url, so
 *      `atomcode review` died with "missing base URL" even when a perfectly
 *      usable direct provider existed. Selection auto-picks the single usable
 *      candidate, refuses by name when several exist (never guesses which
 *      channel to bill), and follows an explicit `provider` argument.
 *   2. A loopback base_url (e.g. the atomcode-open-api sidecar) is a live
 *      process dependency; the probe turns "proxy not running" into a named
 *      diagnostic BEFORE the spawn instead of the CLI's opaque Cancelled.
 *
 * Pure functions + injected fetch only: no binary, no network, no quota.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listUsableProviders,
  selectReviewProvider,
  probeLocalEndpoint,
  checkReviewProvision,
} from '../lib/review.js';
// The loopback predicate is the SHARED module (`src/shared/loopback.ts`), not a
// review-local one: the renderer bundles the same source, so this import and
// `client-fns.test.mjs`'s `isLoopbackEndpoint` are two views of one artifact.
import { isLoopbackBaseUrl } from '../lib/loopback.js';

function withConfig(lines, fn) {
  const home = mkdtempSync(join(tmpdir(), 'atomcode-sel-'));
  const cfgDir = join(home, '.atomcode');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'config.toml'), lines.join('\n'), 'utf8');
  try {
    return fn(cfgDir);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const GATEWAY_CFG = [
  'default_provider = "AtomGit-qwen3.8-27b"',
  '[provider_accounts.AtomGit]',
  'provider = "openai"',
  'base_url = "https://llm-api.atomgit.com/v1"',
];

const LOCAL_PROXY_CFG = [
  ...GATEWAY_CFG,
  '',
  '[providers.atomcode-local]',
  'provider = "openai"',
  'base_url = "http://127.0.0.1:8899/v1"',
  'api_key = "local-proxy-any-string"',
  'model = "deepseek-ai/DeepSeek-V4-Flash"',
];

describe('listUsableProviders — the single "usable" definition', () => {
  it('keeps non-gateway entries with base_url + (api_key or model)', () => {
    const usable = listUsableProviders(LOCAL_PROXY_CFG.join('\n'));
    assert.deepEqual(usable.map((p) => p.name), ['atomcode-local']);
    assert.equal(usable[0].baseUrl, 'http://127.0.0.1:8899/v1');
  });

  it('excludes the AtomGit gateway, base_url-less and key-less entries', () => {
    const raw = [
      '[providers.gw]',
      'base_url = "https://llm-api.atomgit.com/v1"',
      'api_key = "sk"',
      '[providers.no-url]',
      'api_key = "sk"',
      '[providers.no-key]',
      'base_url = "https://x.test/v1"',
      '[providers.ok]',
      'base_url = "https://y.test/v1"',
      'model = "m"',
    ].join('\n');
    assert.deepEqual(listUsableProviders(raw).map((p) => p.name), ['ok']);
  });

  it('agrees with checkReviewProvision (probe and selection cannot diverge)', () => {
    const home = mkdtempSync(join(tmpdir(), 'atomcode-agree-'));
    const cfgDir = join(home, '.atomcode');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'config.toml'), LOCAL_PROXY_CFG.join('\n'), 'utf8');
    try {
      const prov = checkReviewProvision(cfgDir);
      const sel = selectReviewProvider('', cfgDir);
      assert.equal(prov.available, true);
      assert.ok(prov.providers.includes(sel.provider), 'the selected provider must be one the probe reported usable');
      // The endpoint map the panel warns from must describe the SAME entry the
      // selection pinned — otherwise the panel's loopback warning names a
      // different provider than the one the review will actually bill through.
      assert.equal(
        prov.endpoints[String(sel.provider)],
        'http://127.0.0.1:8899/v1',
        'the selected provider must carry its base_url in the endpoint map',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('selectReviewProvider', () => {
  it('account default + one usable direct entry → auto-selects it (fixes "missing base URL")', () => {
    withConfig(LOCAL_PROXY_CFG, (cfgDir) => {
      const s = selectReviewProvider('', cfgDir);
      assert.equal(s.provider, 'atomcode-local');
      assert.equal(s.auto, true);
      assert.equal(s.error, '');
      assert.equal(s.baseUrl, 'http://127.0.0.1:8899/v1');
      assert.ok(s.reason.length > 0, 'auto-selection must explain itself (it gets logged)');
    });
  });

  it('default_provider IS a usable direct entry → uses it, not auto', () => {
    withConfig(
      ['default_provider = "direct"', '[providers.direct]', 'base_url = "https://x.test/v1"', 'api_key = "sk"'],
      (cfgDir) => {
        const s = selectReviewProvider('', cfgDir);
        assert.equal(s.provider, 'direct');
        assert.equal(s.auto, false);
        assert.equal(s.error, '');
      },
    );
  });

  it('a default_provider in SINGLE quotes is still the default', () => {
    // Legal TOML; the old double-quote-only regex read it as UNSET, which
    // dropped the call into auto-selection and let the single direct entry be
    // picked for the user — a billing decision made by a regex miss.
    withConfig(
      [
        "default_provider = 'direct'",
        '[providers.direct]',
        'base_url = "https://x.test/v1"',
        'api_key = "sk"',
        '',
        '[providers.other]',
        'base_url = "https://y.test/v1"',
        'api_key = "sk2"',
      ],
      (cfgDir) => {
        const s = selectReviewProvider('', cfgDir);
        assert.equal(s.provider, 'direct');
        assert.equal(s.auto, false, 'a readable default must not fall through to auto-selection');
        assert.equal(s.error, '', 'nor to the several-entries refusal');
      },
    );
  });

  it('a same-named key inside a SECTION is not the review default', () => {
    withConfig(
      [
        '[ui]',
        'default_provider = "ui-model"',
        '',
        '[providers.only]',
        'base_url = "https://only.test/v1"',
        'api_key = "sk"',
      ],
      (cfgDir) => {
        const s = selectReviewProvider('', cfgDir);
        assert.equal(s.auto, true, 'with no root default the single usable entry is auto-pinned');
        assert.equal(s.provider, 'only');
        assert.ok(/default_provider/.test(s.reason), 'and the auto-selection says the default was unset');
      },
    );
  });

  it('explicit provider argument wins over everything', () => {
    withConfig(LOCAL_PROXY_CFG, (cfgDir) => {
      const s = selectReviewProvider('atomcode-local', cfgDir);
      assert.equal(s.provider, 'atomcode-local');
      assert.equal(s.auto, false);
      assert.equal(s.error, '');
    });
  });

  it('a requested name outside the usable list passes through (built-ins like openrouter)', () => {
    withConfig(LOCAL_PROXY_CFG, (cfgDir) => {
      const s = selectReviewProvider('openrouter', cfgDir);
      assert.equal(s.provider, 'openrouter');
      assert.equal(s.baseUrl, '', 'no probe info for an unknown name — but never blocked');
      assert.equal(s.error, '');
    });
  });

  it('account default + SEVERAL usable entries → named refusal, never a guess', () => {
    withConfig(
      [
        ...GATEWAY_CFG,
        '[providers.a]',
        'base_url = "https://a.test/v1"',
        'api_key = "sk-a"',
        '[providers.b]',
        'base_url = "https://b.test/v1"',
        'api_key = "sk-b"',
      ],
      (cfgDir) => {
        const s = selectReviewProvider('', cfgDir);
        assert.equal(s.provider, null);
        assert.ok(s.error.length > 0, 'ambiguity must be an error, not silence');
        assert.match(s.error, /\ba\b, b\b/, 'the refusal must name the candidates');
        assert.match(s.error, /provider/, 'and what the caller should do about it');
      },
    );
  });

  it('no usable entry at all → error (provision refuses first, but selection stays total)', () => {
    withConfig(GATEWAY_CFG, (cfgDir) => {
      const s = selectReviewProvider('', cfgDir);
      assert.equal(s.provider, null);
      assert.ok(s.error.length > 0);
    });
  });

  it('missing config file → pass-through without throwing', () => {
    const s = selectReviewProvider('x', join(tmpdir(), 'atomcode-nope-404'));
    assert.equal(s.provider, 'x');
    assert.equal(s.error, '');
  });
});

/**
 * isLoopbackBaseUrl — the host's export of the SHARED predicate.
 *
 * It is re-exported from `lib/review.js` but defined in `src/shared/loopback.ts`,
 * which the renderer bundles too (`isLoopbackEndpoint` in `client.js`, asserted
 * by `client-fns.test.mjs`). Both halves answered this question with hand-written
 * copies before; these two suites are what make the shared module's contract
 * visible from each side.
 */
describe('isLoopbackBaseUrl', () => {
  it('recognizes loopback forms', () => {
    for (const url of [
      'http://127.0.0.1:8899/v1',
      'http://127.1.2.3:9/v1',
      'http://localhost:11434/v1',
      'http://[::1]:8080/v1',
      'https://127.0.0.1/v1',
    ]) {
      assert.equal(isLoopbackBaseUrl(url), true, url);
    }
  });

  it('rejects remote and unparseable values (never probe blindly)', () => {
    for (const url of ['https://api.openai.com/v1', 'http://10.0.0.5:8000/v1', 'not a url', '', '127.0.0.1:8899']) {
      assert.equal(isLoopbackBaseUrl(url), false, url);
    }
  });
});

describe('probeLocalEndpoint', () => {
  it('any HTTP response (even 4xx) proves liveness', async () => {
    const seen = [];
    const p = await probeLocalEndpoint('http://127.0.0.1:8899/v1', {
      fetchImpl: async (url) => {
        seen.push(url);
        return { status: 404 };
      },
    });
    assert.equal(p.alive, true);
    assert.match(p.detail, /404/);
    assert.deepEqual(seen, ['http://127.0.0.1:8899/health'], 'health endpoint first, single try on success');
  });

  it('falls back to <base>/models when /health is unreachable', async () => {
    const seen = [];
    const p = await probeLocalEndpoint('http://127.0.0.1:8899/v1', {
      fetchImpl: async (url) => {
        seen.push(url);
        if (url.endsWith('/health')) throw new Error('ECONNREFUSED');
        return { status: 200 };
      },
    });
    assert.equal(p.alive, true);
    assert.deepEqual(seen, ['http://127.0.0.1:8899/health', 'http://127.0.0.1:8899/v1/models']);
  });

  it('every candidate failing → dead, with the transport error preserved', async () => {
    const p = await probeLocalEndpoint('http://127.0.0.1:9/v1', {
      fetchImpl: async () => {
        throw new Error('fetch failed: ECONNREFUSED');
      },
    });
    assert.equal(p.alive, false);
    assert.match(p.detail, /ECONNREFUSED/);
    assert.equal(p.tried.length, 2, 'both candidate URLs must be reported');
  });

  it('unparseable base_url → dead without calling fetch', async () => {
    let called = false;
    const p = await probeLocalEndpoint('garbage', {
      fetchImpl: async () => {
        called = true;
        return { status: 200 };
      },
    });
    assert.equal(p.alive, false);
    assert.equal(called, false);
    assert.match(p.detail, /unparseable/);
  });
});
