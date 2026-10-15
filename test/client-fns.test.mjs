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
const { fmtDuration, fmtCountdown, quotaColor, liveRemaining, pctLabel, barWidth, quotaFacts, panelStyle, quotaView, providerRows, providerSelectModel, turnBoundaryRows } = mod.__test;

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
      providerSelectModel,
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
    // The LABEL is short (the long-winded form moved into `title`), so identity is
    // read from slotName — which is also the wire value the route takes.
    assert.deepEqual(rows.map((r) => r.slotName), ['ask', 'review']);
    assert.notEqual(rows[0].label, rows[1].label, 'two knobs may not share one label');
    assert.ok(rows[0].title.includes('atomcode_ask') && rows[1].title.includes('atomcode_review'), 'each title names its own tool');
    // The LABEL names the route, because the two namespaces are the single most
    // confusing thing on this card: the user read `atomcode-local` (a config.toml
    // direct-entry NAME) as "a config file", since nothing on screen said which route
    // it belonged to. Pinning the route in the label is the fix that does not depend
    // on the reader hovering.
    assert.match(rows[0].label, /ask/, 'the ask label names its route');
    assert.match(rows[1].label, /review/, 'the review label names its route');
    assert.match(rows[1].title, /不是文件路径/, 'and the review title kills the "config file" reading');
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

/**
 * providerSelectModel — the dropdown the panel renders.
 *
 * The interesting cases are the ones a render test cannot reach: a catalogue that
 * never arrived (daemon down), a pick the catalogue no longer offers, a state file
 * a newer build wrote, and the empty-string option that means "未插手". Each must
 * still produce a usable CONTROL or a stated REASON — an empty dropdown with no
 * explanation is the silent failure this repo forbids.
 */
describe('providerSelectModel — one slot, one dropdown, one namespace', () => {
  const ASK_FALLBACK = '未插手（AtomCode 自己的默认）';
  const REVIEW_FALLBACK = '未插手（按 config.toml 自动选择）';

  it('leads with the "no pick" option and then the catalogue', () => {
    const m = providerSelectModel({ ask: { panel: null, catalog: ['A', 'B'] } }, 'ask', ASK_FALLBACK);
    assert.deepEqual(m.options.map((o) => o.value), ['', 'A', 'B']);
    assert.equal(m.options[0].label, ASK_FALLBACK, 'clearing must be reachable and named');
    assert.equal(m.value, '', 'nothing pinned selects the empty option');
    assert.equal(m.disabled, false);
  });

  it('shows the PINNED value even when the catalogue no longer offers it', () => {
    // A daemon that restarted with a different config would otherwise render a real
    // setting as "nothing chosen" — a lie by omission about what the bridge sends.
    const m = providerSelectModel({ ask: { panel: 'Gone-Profile', catalog: ['A'] } }, 'ask', ASK_FALLBACK);
    assert.deepEqual(m.options.map((o) => o.value), ['', 'Gone-Profile', 'A']);
    assert.equal(m.value, 'Gone-Profile');
  });

  it('states WHY it is unusable instead of rendering an empty dropdown', () => {
    const down = providerSelectModel({ ask: { panel: null, catalog: null, catalogError: 'fetch failed' } }, 'ask', ASK_FALLBACK);
    assert.equal(down.disabled, true);
    assert.match(down.reason, /fetch failed/);

    const none = providerSelectModel({ review: { panel: null, catalog: [] } }, 'review', REVIEW_FALLBACK);
    assert.equal(none.disabled, true);
    assert.match(none.reason, /没有直连条目/, 'an empty catalogue explains itself');

    const foreign = providerSelectModel(
      { foreignVersion: true, storeError: 'written by a newer build', ask: { panel: 'X', catalog: ['X'] } },
      'ask',
      ASK_FALLBACK
    );
    assert.equal(foreign.disabled, true, 'a state file from a newer build must not be silently overwritten by a click');
    assert.match(foreign.reason, /newer build/);
    assert.equal(foreign.value, 'X', 'and the pick it holds is still shown');
  });

  it('reports an old host without the provider branch', () => {
    for (const missing of [undefined, null, {}, 'nope']) {
      const m = providerSelectModel(missing, 'ask', ASK_FALLBACK);
      assert.equal(m.disabled, true, `must disable for ${JSON.stringify(missing)}`);
      assert.match(m.reason, /宿主没有提供档位接口/);
      assert.deepEqual(m.options.map((o) => o.value), ['']);
    }
  });

  it('never lets one slot read the other slot or another namespace', () => {
    const provider = {
      ask: { panel: 'AtomGit-glm5.3-flash', catalog: ['AtomGit-glm5.3-flash', 'AtomGit-qwen3.8-27b'] },
      review: { panel: 'atomcode-local', catalog: ['atomcode-local'] },
    };
    const ask = providerSelectModel(provider, 'ask', ASK_FALLBACK);
    const review = providerSelectModel(provider, 'review', REVIEW_FALLBACK);
    assert.equal(ask.value, 'AtomGit-glm5.3-flash');
    assert.equal(review.value, 'atomcode-local');
    assert.ok(!ask.options.some((o) => o.value === 'atomcode-local'), 'a direct entry is not a model profile');
    assert.ok(!review.options.some((o) => o.value.startsWith('AtomGit-')), 'and a profile is not a direct entry');
  });

  it('carries the effective value and its source through, and notes ONLY a mismatch', () => {
    const m = providerSelectModel({ ask: { panel: 'A', catalog: ['A'], effective: 'A', source: 'panel' } }, 'ask', ASK_FALLBACK);
    assert.equal(m.effective, 'A');
    assert.equal(m.source, 'panel');
    // effective === panel is the ordinary case (the click took). Saying so would be
    // narrating the user's own action back to them, and it cost a line per row.
    assert.equal(m.note, '', 'agreement is silent');

    // A pick that LOST to another layer is the only case worth a sentence.
    const lost = providerSelectModel(
      { ask: { panel: '', catalog: ['A'], effective: 'A', source: 'config' } },
      'ask',
      ASK_FALLBACK
    );
    assert.equal(lost.note, 'A', 'an effective value that differs from the control must be surfaced');

    // Junk in those display fields must not throw or leak "undefined" text.
    const junk = providerSelectModel({ ask: { panel: null, catalog: [], effective: 42, source: [] } }, 'ask', ASK_FALLBACK);
    assert.equal(junk.effective, '');
    assert.equal(junk.source, '');
    assert.equal(junk.note, '');
  });

  it('words each empty state for its OWN endpoint, never the other slot\'s', () => {
    // These two shared one sentence, and that sentence named BOTH sources — so the
    // ask slot told the user about config.toml direct entries when what was actually
    // missing was daemon /models. Each reason may mention only its own source.
    const ask = providerSelectModel({ ask: { panel: null, catalog: [] } }, 'ask', ASK_FALLBACK);
    const review = providerSelectModel({ review: { panel: null, catalog: [] } }, 'review', REVIEW_FALLBACK);
    assert.equal(ask.reason, 'daemon 未列出档位');
    assert.equal(review.reason, 'config.toml 里没有直连条目');
    assert.ok(!/config\.toml/.test(ask.reason), 'the ask slot must not explain itself via the review source');
    assert.ok(!/models/.test(review.reason), 'nor the other way round');
    // A disabled control reports its reason, never a stale mismatch note.
    assert.equal(ask.note, '');
    assert.equal(review.note, '');
  });

  it('flattens BOTH catalogue shapes — objects (ask) and strings (review)', () => {
    // Measured against a real daemon (atomcode 5.2.3) and a real config.toml: the two
    // endpoints answer in DIFFERENT shapes for the same field, and both flow through
    // this one function.
    //   GET /models        -> [{provider:"AtomGit-glm5.3-flash", model:"glm5.3-flash", isDefault:false, effortLevels:[...]}, ...]
    //   review direct entries -> ["atomcode-local"]
    // Mapping both with a "must be a string" helper silently dropped every ask option
    // (an object is not a string), so the ask dropdown rendered EMPTY while review
    // worked — and the shared empty-state sentence made it look like a wording bug.
    const realAsk = [
      { provider: 'AtomGit-glm5.3-flash', model: 'glm5.3-flash', isDefault: false, effortLevels: ['low', 'high'] },
      { provider: 'AtomGit-qwen3.8-27b', model: 'qwen3.8-27b', isDefault: true, effortLevels: ['low', 'medium', 'xhigh'] },
    ];
    const ask = providerSelectModel({ ask: { panel: null, catalog: realAsk } }, 'ask', ASK_FALLBACK);
    assert.deepEqual(
      ask.options.map((o) => o.value),
      ['', 'AtomGit-glm5.3-flash', 'AtomGit-qwen3.8-27b'],
      'the ask dropdown must list the model PROFILES, not nothing'
    );
    assert.equal(ask.disabled, false, 'and it must be usable, not disabled');
    // The bare model id is NOT a valid provider on either path (红线 8): using it
    // would look right in the dropdown and fail at the daemon.
    assert.ok(!ask.options.some((o) => o.value === 'glm5.3-flash'), 'never offer the bare model id');

    const review = providerSelectModel({ review: { panel: null, catalog: ['atomcode-local'] } }, 'review', REVIEW_FALLBACK);
    assert.deepEqual(review.options.map((o) => o.value), ['', 'atomcode-local']);
    assert.equal(review.disabled, false);
  });

  it('treats a catalogue of unusable elements as EMPTY, and a missing one as unavailable', () => {
    // Junk elements must not become blank options, and must not fabricate a list.
    const junk = providerSelectModel({ ask: { panel: null, catalog: [null, 42, {}, { provider: '' }, '  '] } }, 'ask', ASK_FALLBACK);
    assert.equal(junk.disabled, true, 'nothing usable in the catalogue means nothing to pick');
    assert.match(junk.reason, /daemon 未列出档位/);
    assert.deepEqual(junk.options.map((o) => o.value), [''], 'and no blank option may appear');
    // A non-array is "the host could not tell us", NOT "there are none" — different
    // reason, different sentence.
    const missing = providerSelectModel({ ask: { panel: null, catalog: 'nope' } }, 'ask', ASK_FALLBACK);
    assert.match(missing.reason, /暂不可用/, missing.reason);
  });

  it('keeps the long provenance OUT of the value, for the hover title', () => {
    // The card body must stay short; the explanation of what the two namespaces are
    // belongs in `title`. This pins that the short form is what renders as the value.
    for (const cfg of [{}, { defaultProvider: 'P', reviewDefaultProvider: 'R' }]) {
      for (const row of providerRows(cfg)) {
        assert.ok(!/config\.toml|GET \/models|\/models/.test(row.value), `value must not carry provenance: ${row.value}`);
        assert.ok(row.title.length > 20, 'and the provenance must exist somewhere (title)');
        assert.ok(!/[（(]/.test(row.value), `value must not carry a parenthetical: ${row.value}`);
      }
    }
  });
});

/**
 * turnBoundaryRows — the "回合边界" card.
 *
 * The whole point of this card is that its three knobs are PATCH-ONLY: the panel has
 * no input for them, so every value shown is either the plugin's built-in default or
 * something the user authored in cordis.patch.yml. Printing both identically is what
 * made the old card six constant rows, so each row must say which it is — and it must
 * take that verdict from the HOST (cfg.authored / cfg.defaults), never from comparing
 * against a default hardcoded in the renderer.
 */
describe('turnBoundaryRows — patch-only knobs must not masquerade as live settings', () => {
  const HOST = { authored: { approvalMode: false, workingDir: false, askMaxRounds: false }, defaults: { approvalMode: 'bypass', askMaxRounds: 25 } };

  it('labels an untouched knob as the plugin default', () => {
    const rows = turnBoundaryRows({ approvalMode: 'bypass', askMaxRounds: 25, ...HOST });
    assert.match(rows[0].text, /bypass（插件默认）/, rows[0].text);
    assert.match(rows[2].text, /25（插件默认）/, rows[2].text);
  });

  it('labels a knob the patch AUTHORED as changed, even when the value looks default', () => {
    // The trap this test exists for: `approval_mode: bypass` written explicitly is
    // STILL authored. Only the host knows that; a renderer comparing the value to the
    // default cannot tell the two apart and would call it "插件默认" — a false claim
    // about a setting the user deliberately wrote down.
    const rows = turnBoundaryRows({
      approvalMode: 'bypass',
      askMaxRounds: 25,
      authored: { approvalMode: true, workingDir: false, askMaxRounds: true },
      defaults: { approvalMode: 'bypass', askMaxRounds: 25 },
    });
    assert.match(rows[0].text, /bypass（已改）/, rows[0].text);
    assert.match(rows[2].text, /25（已改）/, rows[2].text);
  });

  it('follows the HOST default rather than a number of its own', () => {
    // If lib/index.js ever moves the bounded default off 25, a client-side
    // `=== 25` would tag the new default as "已改". The verdict must move with the host.
    const rows = turnBoundaryRows({
      approvalMode: 'strict',
      askMaxRounds: 40,
      authored: { approvalMode: false, workingDir: false, askMaxRounds: false },
      defaults: { approvalMode: 'strict', askMaxRounds: 40 },
    });
    assert.match(rows[0].text, /strict（插件默认）/, rows[0].text);
    assert.match(rows[2].text, /40（插件默认）/, rows[2].text);
  });

  it('names the working directory as the session cwd when unset', () => {
    const rows = turnBoundaryRows({ defaultWorkingDir: '', ...HOST });
    assert.equal(rows[1].text, '（会话工作目录）');
    assert.match(rows[1].title, /working_dir 留空/);
    // With `authored` present and false, a value is still our default — not authored.
    const set = turnBoundaryRows({ defaultWorkingDir: 'D:\\repo', ...HOST });
    assert.match(set[1].text, /（插件默认）/, 'unauthored must not claim authorship');
    assert.match(set[1].text, /^D:\\repo/);
  });

  it('reports 0 rounds as 不限 without a default tag (0 is a deliberate choice)', () => {
    const rows = turnBoundaryRows({ askMaxRounds: 0, ...HOST });
    assert.equal(rows[2].text, '不限');
    assert.ok(!/已改/.test(rows[2].text), '0 rounds is authored by definition, so 已改 would be noise');
  });

  it('degrades on a host that reports no authored/defaults branch at all', () => {
    // An older host (or the desktop install copy) must still render three rows with
    // real values — and must make NO authorship claim, rather than inventing one.
    // This is the case the LIVE host was actually in: it served `approvalMode:
    // "bypass"` and `askMaxRounds: 25` with no `authored`/`defaults` keys at all.
    for (const cfg of [undefined, null, {}, { approvalMode: 'bypass', askMaxRounds: 25 }]) {
      const rows = turnBoundaryRows(cfg);
      assert.equal(rows.length, 3, `three rows for ${JSON.stringify(cfg)}`);
      for (const row of rows) {
        assert.ok(row.label && row.title, 'every row keeps its label and its hover explanation');
        assert.ok(!/已改|插件默认/.test(row.text), `no authorship claim without host evidence: ${row.text}`);
      }
    }
  });

  it('never calls a user-set value "the plugin default" without evidence', () => {
    // The trap: with no `defaults` to compare against, a naive `value === fallback`
    // check reports false, which used to print "（插件默认）" over the user's own
    // deliberate setting — a flat lie on exactly the knob that matters (`ask` is a
    // NON-default approval mode). Absent evidence must stay absent.
    const noEvidence = turnBoundaryRows({ approvalMode: 'ask', defaultWorkingDir: 'D:\\repo', askMaxRounds: 40 });
    assert.equal(noEvidence[0].text, 'ask', 'the value is shown, but not labelled');
    assert.equal(noEvidence[1].text, 'D:\\repo');
    assert.equal(noEvidence[2].text, '40');
    for (const row of noEvidence) {
      assert.ok(!/插件默认/.test(row.text), `must not claim default: ${row.text}`);
      assert.ok(!/已改/.test(row.text), `and must not claim authorship either: ${row.text}`);
    }
  });

  it('never renders a raw null/undefined for a missing value', () => {
    const rows = turnBoundaryRows({ approvalMode: 42, askMaxRounds: 'lots', defaultWorkingDir: {} });
    for (const row of rows) {
      assert.ok(!/null|undefined|42|lots|\[object/.test(row.text), `junk leaked: ${row.text}`);
      assert.ok(!/（已改）/.test(row.text), 'and junk is not authored work');
    }
  });

  it('keeps the bypass explanation reachable, since this card is where it lives', () => {
    // The card that carries the safety posture must always explain what bypass means,
    // even for a user who never opened cordis.patch.yml.
    const rows = turnBoundaryRows({ approvalMode: 'bypass', ...HOST });
    assert.match(rows[0].title, /approval_mode/);
    assert.match(rows[0].title, /无人值守/);
  });
});