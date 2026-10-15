/**
 * client-fns.test.mjs — the renderer's pure formatters.
 *
 * v0.3 tested the client half's REGISTRATION CONTRACT only (id, inject, slot
 * seats). Its actual logic — the countdown arithmetic, the 100% colour rule,
 * the bar clamp — had zero coverage, even though those are exactly the edge
 * cases that produce a lying panel (a countdown frozen at 0, a "77%" bar for a
 * 770% value, an error badge for a null quota).
 *
 * They are now reachable: `client.js` returns them on `__test`, so they are
 * asserted without a browser, a loader, or React.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = join(ROOT, 'client.js');

/**
 * A `require` that serves the web boot's SEED table.
 *
 * The quota panel depends on `react-dom` (createPortal) and
 * `@deepseek-ai/dsh-client-ui-primitives` (Tooltip + anchoring hooks). Both are
 * delivered to every factory as static modules by `dsh-web-frontend`, so a stub
 * that throws on them would NOT exercise the panel path — it would silently
 * take the degraded `title` branch instead, and the panel would ship untested.
 * Serving them here is what makes the assertions below real.
 */
function seededRequire(extra = {}) {
  return (name) => {
    if (name === 'react') {
      return {
        createElement: () => null,
        useState: () => [null, () => {}],
        useEffect: () => {},
        useRef: () => ({ current: null }),
        useCallback: (fn) => fn,
      };
    }
    if (name === 'react-dom') {
      return { createPortal: (node) => ({ portal: node }) };
    }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        Tooltip: () => null,
        useAnchoredPosition: () => ({ left: 10, top: 20 }),
        useDismissOnOutsidePointer: () => {},
        ...extra,
      };
    }
    throw new Error(`unexpected require(${name})`);
  };
}

/** Evaluate client.js against a stub loader and return the factory's module. */
async function loadClient(fakeRequire) {
  const registered = [];
  const savedWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (reg) => registered.push(reg) } };
  try {
    await import(`${pathToFileURL(CLIENT).href}?fns=${Date.now()}`);
  } finally {
    if (savedWindow === undefined) delete globalThis.window;
    else globalThis.window = savedWindow;
  }
  assert.equal(registered.length, 1);
  return registered[0].factory(fakeRequire || seededRequire());
}

const mod = await loadClient();
const { fmtDuration, fmtCountdown, quotaColor, liveRemaining, pctLabel, barWidth, quotaFacts, panelStyle, quotaView, providerRows } = mod.__test;

describe('client __test — the formatters are exposed', () => {
  it('exports every pure helper the panel renders through', () => {
    for (const [name, fn] of Object.entries({
      fmtDuration,
      fmtCountdown,
      quotaColor,
      liveRemaining,
      pctLabel,
      barWidth,
      quotaFacts,
      panelStyle,
      quotaView,
      providerRows,
    })) {
      assert.equal(typeof fn, 'function', `${name} must be callable from tests`);
    }
  });
});

describe('panelStyle — the anchor merge that positions the dialog', () => {
  const surface = {
    position: 'fixed',
    zIndex: 1100,
    width: 'min(264px, 100vw - 24px)',
    border: 0,
  };

  it('keeps the measured coordinates when the hook has anchored', () => {
    // The regression this pins: writing the off-screen fallback AFTER the
    // measured position (`assign({}, surface, anchored, {left:0, top:0})`)
    // clobbers left/top and pins the dialog to the viewport corner.
    const style = panelStyle(surface, { left: 137, top: 480 });
    assert.equal(style.left, 137);
    assert.equal(style.top, 480);
    assert.notEqual(style.visibility, 'hidden', 'an anchored panel must not be hidden');
  });

  it('retains the surface when merging', () => {
    const style = panelStyle(surface, { left: 1, top: 2 });
    assert.equal(style.position, 'fixed');
    assert.equal(style.zIndex, 1100);
    assert.equal(style.width, 'min(264px, 100vw - 24px)');
    assert.equal(style.border, 0);
  });

  it('parks the unmeasured panel off-screen instead of flashing it at 0,0', () => {
    // useAnchoredPosition returns null until it has measured; the host's own
    // ContextMeter hides in exactly this case, so the behaviour must match.
    const style = panelStyle(surface, null);
    assert.equal(style.visibility, 'hidden');
    assert.equal(style.left, 0);
    assert.equal(style.top, 0);
  });

  it('does not mutate the shared surface object', () => {
    // S.panelSurface is module-level and read by every render of every session.
    panelStyle(surface, { left: 9, top: 9 });
    panelStyle(surface, null);
    assert.deepEqual(surface, {
      position: 'fixed',
      zIndex: 1100,
      width: 'min(264px, 100vw - 24px)',
      border: 0,
    });
  });
});

describe('quotaFacts — the panel rows', () => {
  const full = {
    plan: 'Lite-体验版',
    expires: '2026-10-19',
    planWindow: '5d / 共 7d',
  };

  it('renders one row per fact, in reading order', () => {
    assert.deepEqual(quotaFacts(full, 18, 3 * 3600 + 22 * 60), [
      'CodingPlan Lite-体验版',
      '2026-10-19 · 5d / 共 7d',
      '5 小时窗口已用 18%',
      '约 3h22m 后重置',
    ]);
  });

  it('falls back to the bare product name when the plan is unknown', () => {
    const [lead] = quotaFacts({}, 0, null);
    assert.equal(lead, 'CodingPlan', 'never render an empty first row');
  });

  it('drops an unknown row instead of leaving a hole in a sentence', () => {
    // This is what replaced the joined `title` string: a missing expiry must
    // not produce "CodingPlan Lite ·  · 已用 18%".
    const rows = quotaFacts({ plan: 'Lite' }, 18, null);
    assert.deepEqual(rows, ['CodingPlan Lite', '5 小时窗口已用 18%']);
    for (const row of rows) {
      assert.ok(!row.includes(' · ·'), `row must not contain an empty segment: ${row}`);
      assert.ok(row.trim() !== '', 'no blank rows');
    }
  });

  it('never invents a countdown when the snapshot cannot support one', () => {
    const rows = quotaFacts({ plan: 'Lite' }, 18, null);
    assert.ok(!rows.some((row) => row.includes('后重置')), 'no reset row without a countdown');
  });
});

describe('the panel degrades without the seed modules', () => {
  it('still materializes when react-dom and primitives are both absent', async () => {
    // A factory that throws takes its consumer down with it, so the chip must
    // survive a host that serves neither seed — by falling back to `title`.
    const bare = (name) => {
      if (name === 'react') {
        return {
          createElement: () => null,
          useState: () => [null, () => {}],
          useEffect: () => {},
          useRef: () => ({ current: null }),
          useCallback: (fn) => fn,
        };
      }
      throw new Error(`ERR_MODULE_NOT_FOUND: ${name}`);
    };
    const degraded = await loadClientBare(bare);
    assert.equal(typeof degraded.apply, 'function', 'factory must return even without the seeds');
    assert.equal(degraded.__test.barWidth(140), 100, 'pure helpers stay reachable when degraded');
  });
});

/** Load the factory with a `require` that refuses every non-react specifier. */
async function loadClientBare(fakeRequire) {
  const registered = [];
  const savedWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (reg) => registered.push(reg) } };
  try {
    await import(`${pathToFileURL(CLIENT).href}?bare=${Date.now()}`);
  } finally {
    if (savedWindow === undefined) delete globalThis.window;
    else globalThis.window = savedWindow;
  }
  assert.equal(registered.length, 1);
  return registered[0].factory(fakeRequire);
}

describe('fmtDuration', () => {
  it('formats sub-second, second and multi-second spans', () => {
    assert.equal(fmtDuration(1), '1 ms');
    assert.equal(fmtDuration(999), '999 ms');
    assert.equal(fmtDuration(1000), '1.0 s');
    assert.equal(fmtDuration(12_340), '12.3 s');
    assert.equal(fmtDuration(1_234_567), '1234.6 s');
  });

  it('renders "—" instead of a fake 0 for unusable input', () => {
    // "0 ms" would read as "uptime is zero", which is a different claim.
    for (const bad of [0, -1, NaN, Infinity, null, undefined, '12', {}]) {
      assert.equal(fmtDuration(bad), '—', `fmtDuration(${String(bad)})`);
    }
  });
});

describe('fmtCountdown', () => {
  it('drops to seconds, then minutes, then hours', () => {
    assert.equal(fmtCountdown(0), '0s');
    assert.equal(fmtCountdown(45), '45s');
    assert.equal(fmtCountdown(59), '59s');
    assert.equal(fmtCountdown(60), '1m0s');
    assert.equal(fmtCountdown(1753), '29m13s');
    assert.equal(fmtCountdown(3600), '1h0m');
    assert.equal(fmtCountdown(3660), '1h1m');
    assert.equal(fmtCountdown(7199), '1h59m');
  });

  it('renders "—" for a missing or negative countdown, never "-1m"', () => {
    // A negative value reaching this function means the caller forgot to clamp;
    // printing it would surface an impossible countdown on screen.
    for (const bad of [-1, -3600, NaN, Infinity, null, undefined, '5m']) {
      assert.equal(fmtCountdown(bad), '—', `fmtCountdown(${String(bad)})`);
    }
  });
});

describe('quotaColor', () => {
  const ERROR = 'var(--dsw-alias-state-error-primary)';
  const NORMAL = 'var(--dsw-alias-label-primary)';

  it('is normal below an exhausted window', () => {
    assert.equal(quotaColor(0, false), NORMAL);
    assert.equal(quotaColor(77, false), NORMAL);
    assert.equal(quotaColor(99.9, false), NORMAL, 'not an error before 100%');
  });

  it('is an error exactly at/over 100% or when the server says limited', () => {
    assert.equal(quotaColor(100, false), ERROR);
    assert.equal(quotaColor(120, false), ERROR);
    assert.equal(quotaColor(80, true), ERROR, 'an explicit limited flag wins');
  });

  it('is normal (not an alarm) when there is no number at all', () => {
    for (const bad of [null, undefined, NaN, '50', {}]) {
      assert.equal(quotaColor(bad, false), NORMAL, `quotaColor(${String(bad)}) must not alarm`);
    }
  });
});

describe('liveRemaining — the locally advanced countdown', () => {
  const fetchedAt = 1_700_000_000_000;

  it('subtracts the elapsed time between polls', () => {
    assert.equal(liveRemaining(1753, fetchedAt, fetchedAt), 1753, 'no time passed');
    assert.equal(liveRemaining(1753, fetchedAt, fetchedAt + 30_000), 1723);
    assert.equal(liveRemaining(1753, fetchedAt, fetchedAt + 1753_000), 0);
  });

  it('clamps a stale snapshot to 0 rather than going negative', () => {
    // The window reset since the fetch: "0s" is honest, "-13s" is not.
    assert.equal(liveRemaining(10, fetchedAt, fetchedAt + 60_000), 0);
  });

  it('returns null when the snapshot cannot support a countdown', () => {
    assert.equal(liveRemaining(null, fetchedAt, fetchedAt), null);
    assert.equal(liveRemaining(undefined, fetchedAt, fetchedAt), null);
    assert.equal(liveRemaining(NaN, fetchedAt, fetchedAt), null);
    assert.equal(liveRemaining(1753, null, fetchedAt), null);
    assert.equal(liveRemaining(1753, undefined, fetchedAt), null);
  });
});

describe('pctLabel and barWidth', () => {
  it('rounds a fractional percentage for display', () => {
    assert.equal(pctLabel(77.4), '77%');
    assert.equal(pctLabel(77.6), '78%');
    assert.equal(pctLabel(0), '0%');
    assert.equal(pctLabel(100), '100%');
  });

  it('renders "—" when there is no number', () => {
    for (const bad of [null, undefined, NaN, '77']) {
      assert.equal(pctLabel(bad), '—', `pctLabel(${String(bad)})`);
    }
  });

  it('clamps the bar into [0,100] so it cannot overflow its track', () => {
    assert.equal(barWidth(0), 0);
    assert.equal(barWidth(50), 50);
    assert.equal(barWidth(100), 100);
    assert.equal(barWidth(140), 100);
    assert.equal(barWidth(-5), 0);
    assert.equal(barWidth(NaN), 0);
    assert.equal(barWidth(null), 0);
  });
});

/**
 * quotaView — the single derivation both chip variants share.
 *
 * Extracted because the pre-split code built the label string unconditionally
 * from a `pct` that defaulted to null, so the composer dock printed
 * `atom · 5小时 null%` for the frame before the first stats response landed —
 * while the function's own doc comment claimed it rendered nothing then.
 * Making `label` unconstructable unless the quota is known turns that whole bug
 * class into a type error rather than a review finding.
 */
describe('quotaView — one snapshot in, one render model out', () => {
  const NOW = 1_700_000_000_000;
  const healthy = {
    available: true,
    usagePercent: 18,
    plan: 'Lite-体验版',
    expires: '2026-10-19',
    planWindow: '5d / 共 7d',
    resetInSecs: 3600,
    fetchedAt: NOW,
    limited: false,
  };

  it('produces no label at all while the quota is unknown', () => {
    for (const q of [undefined, null, {}, { available: false }, { available: true }, { available: true, usagePercent: null }, { available: true, usagePercent: '18' }]) {
      const v = quotaView(q, NOW);
      assert.equal(v.known, false, `must report unknown for ${JSON.stringify(q)}`);
      assert.equal(v.label, undefined, 'a constructible label is how null% reached the screen');
      assert.equal(v.pct, undefined);
    }
  });

  it('never renders the string "null" or "undefined" in the label', () => {
    // The regression stated outright: the old code path could emit this text.
    const v = quotaView(healthy, NOW);
    assert.equal(v.label, 'atom · 5小时 18%');
    assert.ok(!/null|undefined|NaN/.test(v.label), v.label);
  });

  it('keeps the normal state ambient (tertiary), not primary', () => {
    // The dock is a readout strip; a primary-color gauge among the session
    // pills reads as a control the host owns.
    assert.equal(quotaView(healthy, NOW).color, 'var(--dsw-alias-label-tertiary)');
  });

  it('alarms only on an exhausted window, by either signal', () => {
    const ERROR = 'var(--dsw-alias-state-error-primary)';
    assert.equal(quotaView({ ...healthy, limited: true }, NOW).color, ERROR);
    assert.equal(quotaView({ ...healthy, usagePercent: 100 }, NOW).color, ERROR);
    assert.equal(quotaView({ ...healthy, usagePercent: 99.9 }, NOW).color, 'var(--dsw-alias-label-tertiary)');
  });

  it('advances the countdown locally from fetchedAt', () => {
    const v = quotaView({ ...healthy, resetInSecs: 3600 }, NOW + 600_000);
    assert.deepEqual(v.facts.at(-1), '约 50m0s 后重置', 'countdown must follow the clock, not the snapshot');
  });

  it('drops the countdown row entirely when the snapshot cannot support one', () => {
    const v = quotaView({ ...healthy, resetInSecs: null }, NOW);
    assert.ok(!v.facts.some((f) => f.includes('后重置')), JSON.stringify(v.facts));
  });

  it('carries a clamped bar width so the panel bar cannot overflow', () => {
    assert.equal(quotaView({ ...healthy, usagePercent: 770 }, NOW).barWidth, 100);
    assert.equal(quotaView({ ...healthy, usagePercent: 0 }, NOW).barWidth, 0);
  });
});

/**
 * providerRows — the card's two model knobs.
 *
 * The contract is the SHAPE, not the wording: exactly two rows, always, with the
 * ask profile and the review entry on SEPARATE labels. A merged row, or a row
 * that vanishes when unset, is how two different namespaces (daemon 档位名 vs CLI
 * 直连条目名) start reading as one knob — and how an unpinned setting becomes
 * indistinguishable from an older host that does not report it at all.
 */
describe('providerRows — the two provider knobs, never merged, never dropped', () => {
  it('emits two rows with distinct ask / review labels on a bare config', () => {
    const rows = providerRows({});
    assert.equal(rows.length, 2, 'both knobs must always render');
    assert.ok(/ask/.test(rows[0].label) && !/review/.test(rows[0].label), JSON.stringify(rows[0].label));
    assert.ok(/review/.test(rows[1].label) && !/ask/.test(rows[1].label), JSON.stringify(rows[1].label));
    assert.equal(rows[0].pinned, false);
    assert.equal(rows[1].pinned, false);
  });

  it('says 未插手 in words instead of leaving a hole when nothing is pinned', () => {
    for (const cfg of [{}, null, undefined, { defaultProvider: null, reviewDefaultProvider: null }]) {
      const rows = providerRows(cfg);
      assert.equal(rows.length, 2, `a missing config branch must not drop rows (${JSON.stringify(cfg)})`);
      for (const r of rows) {
        assert.match(r.value, /未插手/, r.value);
        assert.ok(!/null|undefined/.test(r.value), `never render the raw absence: ${r.value}`);
      }
    }
  });

  it('renders a pinned name verbatim (no decoration) and marks it pinned', () => {
    const rows = providerRows({
      defaultProvider: 'AtomGit-glm5.3-flash',
      reviewDefaultProvider: 'atomcode-local',
    });
    assert.deepEqual(rows.map((r) => r.value), ['AtomGit-glm5.3-flash', 'atomcode-local']);
    assert.deepEqual(rows.map((r) => r.pinned), [true, true]);
  });

  it('pins ONE knob without implying anything about the other', () => {
    const rows = providerRows({ defaultProvider: 'AtomGit-qwen3.8-27b' });
    assert.equal(rows[0].pinned, true);
    assert.match(rows[0].value, /qwen/);
    assert.equal(rows[1].pinned, false, 'the review knob must not inherit the ask value');
    assert.match(rows[1].value, /未插手/);
  });

  it('trims a real name but treats whitespace as unset', () => {
    assert.equal(providerRows({ defaultProvider: ' AtomGit-glm5.3-flash ' })[0].value, 'AtomGit-glm5.3-flash');
    const blank = providerRows({ defaultProvider: '   ', reviewDefaultProvider: '\t' });
    assert.deepEqual(blank.map((r) => r.pinned), [false, false], 'a blank name must not render as a provider');
  });

  it('drops non-string junk instead of coercing it into a name', () => {
    // The snapshot is host-supplied; a number reaching the screen would read as
    // a legitimate profile the user could then never find in /models.
    for (const bad of [42, true, {}, [], () => 'AtomGit-glm5.3-flash']) {
      const rows = providerRows({ defaultProvider: bad, reviewDefaultProvider: bad });
      assert.deepEqual(rows.map((r) => r.pinned), [false, false], `must reject ${typeof bad}`);
    }
  });

  it('tolerates a config branch of the wrong type', () => {
    for (const weird of ['string', 7, [], () => {}]) {
      const rows = providerRows(weird);
      assert.equal(rows.length, 2, 'a malformed branch still renders both rows');
      assert.deepEqual(rows.map((r) => r.pinned), [false, false]);
    }
  });
});