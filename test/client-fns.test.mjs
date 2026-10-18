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
const { fmtDuration, fmtCountdown, quotaColor, liveRemaining, pctLabel, barWidth, quotaFacts, panelStyle, quotaView, providerRows, providerSelectModel, turnBoundaryRows, isLoopbackEndpoint, daemonStatusLine, protocolDriftNotice, inFlightText, createReviewHandoff, createMessageAsk,
  messageTextOf,
} = mod.__test;

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
      daemonStatusLine,
      protocolDriftNotice,
      inFlightText,
      messageTextOf,
      // The 锐评 hand-off: the rail that captures the composer, and the prefill
      // that is the ONLY thing the plugin still does from a transcript row.
      createReviewHandoff,
      createMessageAsk,
    })) {
      assert.equal(typeof fn, 'function', `${name} must be callable from tests`);
    }
  });

  it('does NOT export the deleted popover surface', () => {
    // 方针 A removed the plugin's own channel. These names must stay gone: a
    // re-export would mean the popover or the /ask client path came back.
    for (const gone of ['createAskChip', 'readSessionCwd', 'turnSummaryText', 'reviewPrompt', 'atomReviewPrompt', 'atomReviewPromptWithReply']) {
      assert.equal(mod.__test[gone], undefined, `${gone} belonged to the deleted popover and must not return`);
    }
  });
});

describe('messageTextOf — the 锐评 button reads the reply the host already rendered', () => {
  // Snapshot shape copied from what the host builds. The id the owner hands us
  // lives on the TURN-TAIL node's `data.closing` (that is the node the action
  // row belongs to), while the assistant-step node carries `finalNode` under its
  // own `data`. The first version of `messageTextOf` only knew the second shape
  // and therefore never matched anything in a real browser — the popover said
  // 「没取到这条回复的正文」 on every click.
  const snapshotOf = (nodes) => ({ nodes: { values: () => nodes } });
  const step = (messageId, blocks) => ({ kind: 'assistant-step', data: { blocks, finalNode: { messageId, blocks } } });
  const tail = (messageId, blocks) => ({ kind: 'turn-tail', data: { closing: { finalNode: { messageId }, blocks } } });

  it('reads the closing message of a turn-tail node — the shape the host really publishes', () => {
    const snapshot = snapshotOf([
      step('m-other', [{ kind: 'text', text: '别拿错' }]),
      tail('m1', [
        { kind: 'reasoning', text: '思考过程不该进引用' },
        { kind: 'text', text: '改完了：' },
        { kind: 'tool-call' },
        { kind: 'text', text: '三个文件。' },
      ]),
    ]);
    assert.equal(messageTextOf(snapshot, 'm1'), '改完了：三个文件。');
  });

  it('still reads an assistant-step node that carries the settled message itself', () => {
    assert.equal(messageTextOf(snapshotOf([step('m1', [{ kind: 'text', text: '直接命中' }])]), 'm1'), '直接命中');
  });

  it('returns null when the message is not in the projection, "" when it has no prose', () => {
    // The two MUST differ: "not found" is what lights the popover's named note,
    // while an empty reply legitimately degrades to the directory-scoped review.
    const snapshot = snapshotOf([tail('m1', [])]);
    assert.equal(messageTextOf(snapshot, 'm-gone'), null);
    assert.equal(messageTextOf(snapshot, 'm1'), '');
  });

  it('survives an unfinished turn (closing null), a missing snapshot and a throwing store', () => {
    // `tailData` publishes `closing: null` for a turn with no prose reply; the
    // owner never renders the row then, and this must not throw if it ever does.
    assert.equal(messageTextOf(snapshotOf([{ kind: 'turn-tail', data: { closing: null } }]), 'm1'), null);
    assert.equal(messageTextOf(snapshotOf([{ kind: 'assistant-step', data: { blocks: [{ kind: 'text', text: 'x' }] } }]), 'm1'), null);
    assert.equal(messageTextOf(null, 'm1'), null);
    assert.equal(messageTextOf({ nodes: {} }, 'm1'), null);
    assert.equal(
      messageTextOf({
        nodes: {
          values() {
            throw new Error('store disposed');
          },
        },
      }, 'm1'),
      null,
    );
    assert.equal(messageTextOf(snapshotOf([step('m1', [{ kind: 'text', text: 'x' }])]), null), null);
  });
});

describe('createReviewHandoff — 锐评 PREFILLS the official command, it never sends', () => {
  // 方针 A: the plugin owns no channel. The 锐评 row hands ONE assistant reply to
  // `/atomcode-review` by putting the text at the composer's caret; the HOST runs
  // it, in the transcript, session-scoped. Two things make that contract real and
  // both are pinned here: the rail is how a seat that lacks `inputActions`
  // reaches the composer anyway, and every way the prefill can fail is NAMED on
  // the console (红线 3) instead of swallowed.
  //
  // `console.warn` is swapped per case (try/finally, not beforeEach) because the
  // suite imports only `describe, it` from node:test — the hook exports are not
  // globals here, and a silently-unrestored console would leak into later cases.
  function withWarnings(run) {
    const saved = console.warn;
    const seen = [];
    console.warn = (...args) => {
      seen.push(args.map(String).join(' '));
    };
    try {
      return run(seen);
    } finally {
      console.warn = saved;
    }
  }

  /** A composer rail that records what it was asked to insert, and answers `ok`. */
  function recordingRail(seen, ok = true) {
    return {
      captureInsertion: () => 'span-1',
      insertText(text) {
        seen.push(text);
        return ok;
      },
    };
  }

  it('renders NOTHING, and that empty render is the point', () => {
    const { ReviewRail } = createReviewHandoff();
    assert.equal(ReviewRail({ inputActions: recordingRail([]) }), null);
    assert.equal(ReviewRail({}), null, 'no rail on the props is still a null render, not a throw');
    assert.equal(ReviewRail(null), null);
  });

  it('the rail is what makes the composer reachable from the message row', () => {
    // The row lives in `conversation.chat.assistant-actions`, which is handed
    // `{ messageId }` and NOT `inputActions`. Without this capture the prefill
    // could not work at all — the two seats are welded through this one line.
    const seen = [];
    const { ReviewRail, requestReview } = createReviewHandoff();
    ReviewRail({ inputActions: recordingRail(seen) });
    assert.equal(requestReview({ text: '改完了' }), true);
    assert.deepEqual(seen, ['/atomcode-review 改完了']);
  });

  it('quotes the reply, and drops the argument entirely when there is none', () => {
    // "quoted nothing" and "could not find it" stay different failures: an empty
    // reply is legal and reviews the working tree, it is not an error.
    const seen = [];
    const { ReviewRail, requestReview } = createReviewHandoff();
    ReviewRail({ inputActions: recordingRail(seen) });
    withWarnings((warnings) => {
      requestReview({ text: '我把重试改成了指数退避。' });
      assert.equal(seen.at(-1), '/atomcode-review 我把重试改成了指数退避。');
      for (const input of [{ text: null }, {}, { text: '' }, { text: undefined }]) {
        requestReview(input);
        assert.equal(seen.at(-1), '/atomcode-review', 'a missing reply degrades to a directory-scoped review');
      }
      assert.deepEqual(warnings, [], 'neither the quoted nor the unquoted path is a failure');
    });
  });

  it('names the failure when no rail has rendered yet', () => {
    withWarnings((warnings) => {
      const { requestReview } = createReviewHandoff();
      assert.equal(requestReview({ text: 'x' }), false);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /输入框还没挂载/);
      assert.match(warnings[0], /\/atomcode-review/, 'the note says what to type by hand');
      assert.match(warnings[0], /^\[atomcode-bridge\] /, 'same diagnostic channel as the rest of the client');
    });
  });

  it('names EACH way the composer can refuse the text', () => {
    // Three distinct causes, three distinct sentences. Collapsing them into one
    // "insert failed" is what 红线 3 forbids — each one tells the user a
    // different thing about which host surface is missing.
    withWarnings((warnings) => {
      const { ReviewRail, requestReview } = createReviewHandoff();

      ReviewRail({});
      assert.equal(requestReview({ text: 'x' }), false);
      assert.match(warnings.at(-1), /这个宿主没有暴露输入框操作/);

      ReviewRail({
        inputActions: {
          captureInsertion() {
            throw new Error('readonly');
          },
          insertText: () => true,
        },
      });
      assert.equal(requestReview({ text: 'x' }), false);
      assert.match(warnings.at(-1), /输入框当前不可写/);

      ReviewRail({ inputActions: recordingRail([], false) });
      assert.equal(requestReview({ text: 'x' }), false);
      assert.match(warnings.at(-1), /输入框内容变了/);

      assert.equal(warnings.length, 3, 'one line per cause, no doubles');
      for (const w of warnings) assert.match(w, /请手动输入 \/atomcode-review/, 'every failure tells the user the way out');
    });
  });

  it('never sends, never delivers, never touches the network', () => {
    // The whole point of 方针 A. If a future edit reaches for `fetch`, `/ask` or
    // `/inject` from this module, this case is the tripwire: the module has no
    // such dependency, and the only observable is the composer text.
    const seen = [];
    const { ReviewRail, requestReview } = createReviewHandoff();
    ReviewRail({ inputActions: recordingRail(seen) });
    requestReview({ text: '改完了' });
    assert.deepEqual(seen, ['/atomcode-review 改完了']);
    assert.equal(requestReview.length, 1, 'requestReview takes the reply only — no sessionId, no cwd, no transport');
  });

  it('is a fresh closure per factory, so two rails cannot cross wires', () => {
    const first = [];
    const second = [];
    const a = createReviewHandoff();
    const b = createReviewHandoff();
    a.ReviewRail({ inputActions: recordingRail(first) });
    b.ReviewRail({ inputActions: recordingRail(second) });
    a.requestReview({ text: 'A' });
    b.requestReview({ text: 'B' });
    assert.deepEqual(first, ['/atomcode-review A']);
    assert.deepEqual(second, ['/atomcode-review B']);
  });
});
describe('daemonStatusLine — the panel shows the HOST\'s cause, never its own', () => {
  it('an up daemon carries its version and no cause', () => {
    assert.equal(daemonStatusLine({ up: true }, '5.2.3'), 'daemon 运行中 5.2.3');
    assert.equal(daemonStatusLine({ up: true }, ''), 'daemon 运行中');
  });

  it('a down daemon shows the sentence the host worded', () => {
    // The sentence is composed by the host (`describeDaemonDown`) and quoted
    // verbatim by the tool errors. Re-wording it here is what let one port get
    // four different causes all reported as "未监听".
    const line = daemonStatusLine({ up: false, downMessage: '端口被非 AtomCode 服务占用（/health 未声明 atomcode-daemon）', autoStart: true });
    assert.match(line, /端口被非 AtomCode 服务占用/);
    assert.match(line, /可自动拉起/);
    assert.doesNotMatch(line, /未监听/);
  });

  it('an OLDER host that sends no cause says so instead of blaming the port', () => {
    const line = daemonStatusLine({ up: false }, null);
    assert.match(line, /原因未记录（宿主较旧）/, 'a missing reason must be named, not silently blank');
  });

  it('auto-start off is not advertised as recoverable', () => {
    assert.doesNotMatch(daemonStatusLine({ up: false, downMessage: '没有任何进程在监听', autoStart: false }, null), /可自动拉起/);
  });
});

describe('protocolDriftNotice — silence is the default, and it is the contract', () => {
  it('an EMPTY list renders as silence', () => {
    // 红线 3 asks for a named diagnostic; it does not ask for a permanent one.
    // A notice that shows on every stock install is furniture, and furniture is
    // how a real warning gets skipped.
    assert.equal(protocolDriftNotice({ unknownTypes: [] }), '');
  });

  it('a host too old to send the field renders as silence too', () => {
    // Absence must NOT be read as drift: an older host omits the whole field,
    // and crying wolf at every user who has not upgraded is the failure this
    // branch is meant to avoid.
    assert.equal(protocolDriftNotice(undefined), '');
    assert.equal(protocolDriftNotice(null), '');
    assert.equal(protocolDriftNotice({ daemonVersion: '5.2.3' }), '');
    assert.equal(protocolDriftNotice({ unknownTypes: null }), '');
  });

  it('a drifted type is named, and the fuse consequence is stated', () => {
    const notice = protocolDriftNotice({ unknownTypes: ['tool_begin', 'a_new_thing'] });
    assert.match(notice, /tool_begin/, 'the observed type must be named, not summarised');
    assert.match(notice, /a_new_thing/, 'every type, not just the first');
    assert.match(notice, /熔断/, 'the notice must say WHY it matters, not merely that something changed');
  });

  it('junk in the array cannot smuggle a blank or a non-string into the sentence', () => {
    // The snapshot is host-supplied and an older/other build is free to send
    // anything. A blank entry would render "（）" — a warning about nothing.
    assert.equal(protocolDriftNotice({ unknownTypes: ['', null, undefined, 42] }), '');
    assert.equal(protocolDriftNotice({ unknownTypes: ['ok_type', ''] }), protocolDriftNotice({ unknownTypes: ['ok_type'] }));
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
    assert.deepEqual(quotaFacts(full, 3 * 3600 + 22 * 60), [
      'Lite-体验版',
      '2026-10-19 · 5d / 共 7d',
      '约 3h22m 后重置',
    ]);
  });

  it('does not repeat a fact the panel header already shows', () => {
    // The panel header renders "CodingPlan 额度" + the big percent + the bar.
    // A row saying the product name or "窗口已用 N%" is the same fact twice
    // inside 264px, which is what the user reported as clutter.
    const rows = quotaFacts(full, 3 * 3600 + 22 * 60);
    for (const row of rows) {
      assert.ok(!/^CodingPlan/.test(row), `the header already says CodingPlan: ${row}`);
      assert.ok(!row.includes('窗口已用'), `the big percent already says the usage: ${row}`);
    }
  });

  it('drops an unknown row instead of leaving a hole in a sentence', () => {
    // This is what replaced the joined `title` string: a missing expiry must
    // not produce "Lite ·  · 5d / 共 7d".
    const rows = quotaFacts({ plan: 'Lite' }, null);
    assert.deepEqual(rows, ['Lite']);
    for (const row of rows) {
      assert.ok(!row.includes(' · ·'), `row must not contain an empty segment: ${row}`);
      assert.ok(row.trim() !== '', 'no blank rows');
    }
  });

  it('omits the plan row entirely when the plan is unknown', () => {
    // No "CodingPlan" placeholder row: the header carries the product name, so
    // an unknown plan is an absent row, not a fallback string.
    const rows = quotaFacts({}, null);
    assert.deepEqual(rows, [], 'an all-unknown quota contributes no rows');
  });

  it('never invents a countdown when the snapshot cannot support one', () => {
    const rows = quotaFacts({ plan: 'Lite' }, null);
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

  it('never prints a 60 in the seconds slot of a fractional countdown', () => {
    // The panel passes `liveRemaining()`'s fractional seconds, so the boundary
    // half-second is reachable: rounding the remainder on its own printed
    // "4m60s" (299.99) — a countdown that reads like the bug it is.
    assert.equal(fmtCountdown(299.99), '5m0s');
    assert.equal(fmtCountdown(59.6), '1m0s');
    assert.equal(fmtCountdown(3599.6), '1h0m');
    assert.equal(fmtCountdown(119.4), '1m59s');
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
    assert.equal(v.label, 'atom · 18% · 1h0m 后重置');
    assert.ok(!/null|undefined|NaN/.test(v.label), v.label);
  });

  it('leads the chip with the countdown, never the plan period', () => {
    // `atom · 3d / 共 7d 2%` glued a PLAN-PERIOD figure (days left of the
    // billing period, from the `到期 <date>（5d / 共 7d）` line) to the
    // ROLLING-WINDOW percent, so it read as "2% of 7 days". The user cares
    // when quota comes back, not when the subscription lapses.
    const label = quotaView(healthy, NOW).label;
    assert.ok(!/共\s*7d|5d\s*\//.test(label), `the plan period is not a usage window: ${label}`);
    assert.ok(label.includes('后重置'), `the countdown is the reason to show this at all: ${label}`);
  });

  it('omits the countdown rather than inventing one', () => {
    // No `resetInSecs` => no timing claim. Same rule as the panel rows: a
    // missing fact is an absent segment, never a placeholder.
    const v = quotaView({ ...healthy, resetInSecs: null }, NOW);
    assert.equal(v.label, 'atom · 18%', 'the percent stands alone without a countdown');
    assert.ok(!/后重置/.test(v.label), v.label);
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
describe('providerRows — ONE provider knob, because there is one ladder', () => {
  // The card used to show TWO rows for two namespaces: `default_provider` for
  // ask (a daemon profile name) and `review_default_provider` for the CLI (a
  // `[providers.<name>]` direct entry). The CLI is gone, `atomcode_review` is an
  // ask turn, and both routes resolve through the same ladder — so a second row
  // would be the panel advertising a knob that no longer controls anything.
  it('emits exactly one row on a bare config', () => {
    const rows = providerRows({});
    assert.equal(rows.length, 1, 'one ladder, one row');
    assert.equal(rows[0].label, '默认对话模型');
    assert.ok(rows[0].title.includes('问 AtomCode'), 'the title names the shared tool');
    assert.ok(rows[0].title.includes('代码评审'), 'and the second entry point that shares it');
    assert.equal(rows[0].pinned, false);
  });

  it('says 未插手 in words instead of leaving a hole when nothing is pinned', () => {
    for (const cfg of [{}, null, undefined, { defaultProvider: null }]) {
      const rows = providerRows(cfg);
      assert.equal(rows.length, 1, `a missing config branch must not drop the row (${JSON.stringify(cfg)})`);
      assert.match(rows[0].value, /未插手/, rows[0].value);
      assert.ok(!/null|undefined/.test(rows[0].value), `never render the raw absence: ${rows[0].value}`);
    }
  });

  it('renders a pinned name verbatim (no decoration) and marks it pinned', () => {
    const rows = providerRows({ defaultProvider: 'AtomGit-glm5.3-flash' });
    assert.equal(rows[0].value, 'AtomGit-glm5.3-flash');
    assert.equal(rows[0].pinned, true);
  });

  it('trims a real name but treats whitespace as unset', () => {
    assert.equal(providerRows({ defaultProvider: ' AtomGit-glm5.3-flash ' })[0].value, 'AtomGit-glm5.3-flash');
    assert.equal(providerRows({ defaultProvider: '   ' })[0].pinned, false, 'a blank name must not render as a provider');
  });

  it('drops non-string junk instead of coercing it into a name', () => {
    // The snapshot is host-supplied; a number reaching the screen would read as
    // a legitimate profile the user could then never find in /models.
    for (const bad of [42, true, {}, [], () => 'AtomGit-glm5.3-flash']) {
      const rows = providerRows({ defaultProvider: bad });
      assert.equal(rows[0].pinned, false, `must reject ${typeof bad}`);
    }
  });

  it('tolerates a config branch of the wrong type', () => {
    for (const weird of ['string', 7, [], () => {}]) {
      const rows = providerRows(weird);
      assert.equal(rows.length, 1, 'a malformed branch still renders the row');
      assert.equal(rows[0].pinned, false);
    }
  });

  it('keeps the long provenance OUT of the value, for the hover title', () => {
    // The card body must stay short; the explanation of what the ladder is
    // belongs in `title`. This pins that the short form is what renders.
    for (const cfg of [{}, { defaultProvider: 'P' }]) {
      const row = providerRows(cfg)[0];
      assert.ok(!/config\.toml|\/models/.test(row.value), `value must not carry provenance: ${row.value}`);
      assert.ok(row.title.length > 20, 'and the provenance must exist somewhere (title)');
      assert.ok(!/[（(]/.test(row.value), `value must not carry a parenthetical: ${row.value}`);
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
describe('providerSelectModel — one branch, one dropdown, one namespace', () => {
  const FALLBACK = '未插手（AtomCode 自己的默认）';

  it('leads with the "no pick" option and then the catalogue', () => {
    const m = providerSelectModel({ panel: null, catalog: ['A', 'B'] }, FALLBACK);
    assert.deepEqual(m.options.map((o) => o.value), ['', 'A', 'B']);
    assert.equal(m.options[0].label, FALLBACK, 'clearing must be reachable and named');
    assert.equal(m.value, '', 'nothing pinned selects the empty option');
    assert.equal(m.disabled, false);
  });

  it('shows the PINNED value even when the catalogue no longer offers it', () => {
    // A daemon that restarted with a different config would otherwise render a real
    // setting as "nothing chosen" — a lie by omission about what the bridge sends.
    const m = providerSelectModel({ panel: 'Gone-Profile', catalog: ['A'] }, FALLBACK);
    assert.deepEqual(m.options.map((o) => o.value), ['', 'Gone-Profile', 'A']);
    assert.equal(m.value, 'Gone-Profile');
  });

  it('states WHY it is unusable instead of rendering an empty dropdown', () => {
    const down = providerSelectModel({ panel: null, catalog: null, catalogError: 'fetch failed' }, FALLBACK);
    assert.equal(down.disabled, true);
    assert.match(down.reason, /fetch failed/);

    const none = providerSelectModel({ panel: null, catalog: [] }, FALLBACK);
    assert.equal(none.disabled, true);
    assert.equal(none.reason, 'daemon 未列出档位', 'an empty catalogue explains itself, and names the daemon');

    const foreign = providerSelectModel(
      { foreignVersion: true, storeError: 'written by a newer build', panel: 'X', catalog: ['X'] },
      FALLBACK
    );
    assert.equal(foreign.disabled, true, 'a state file from a newer build must not be silently overwritten by a click');
    assert.match(foreign.reason, /newer build/);
    assert.equal(foreign.value, 'X', 'and the pick it holds is still shown');
  });

  it('keeps a panel pick VISIBLE when the catalogue is unfetchable', () => {
    // A disabled select whose value has no matching <option> renders as
    // "nothing selected" — the pick on disk must stay visible (红线 3).
    const m = providerSelectModel({ panel: 'AtomGit-glm5.3-flash', catalog: null, catalogError: 'daemon 未在线' }, FALLBACK);
    assert.equal(m.disabled, true);
    assert.equal(m.value, 'AtomGit-glm5.3-flash');
    assert.ok(
      m.options.some((o) => o.value === 'AtomGit-glm5.3-flash'),
      'the stored pick must be among the options even when the catalogue is null',
    );
  });

  it('reports an old host without the provider branch', () => {
    // `{}` is NOT in this list any more: the branch is FLAT now (panel / config /
    // effect live on the object itself), so `{}` is a well-formed branch that
    // simply carries nothing — it reads as "no catalogue" and says so, rather
    // than claiming the host has no provider route at all. Only a genuinely
    // absent or non-object branch is "the host is too old".
    for (const missing of [undefined, null, 'nope', 42]) {
      const m = providerSelectModel(missing, FALLBACK);
      assert.equal(m.disabled, true, `must disable for ${JSON.stringify(missing)}`);
      assert.match(m.reason, /宿主没有提供档位接口/);
      assert.deepEqual(m.options.map((o) => o.value), ['']);
    }
    const flatEmpty = providerSelectModel({}, FALLBACK);
    assert.equal(flatEmpty.disabled, true);
    assert.match(flatEmpty.reason, /暂不可用/, 'an empty flat branch is "no catalogue", not "no route"');
  });

  it('carries the effective value and its source through, and notes ONLY a mismatch', () => {
    const m = providerSelectModel({ panel: 'A', catalog: ['A'], effective: 'A', source: 'panel' }, FALLBACK);
    assert.equal(m.effective, 'A');
    assert.equal(m.source, 'panel');
    // effective === panel is the ordinary case (the click took). Saying so would be
    // narrating the user's own action back to them, and it cost a line per row.
    assert.equal(m.note, '', 'agreement is silent');

    // A pick that LOST to another layer is the only case worth a sentence.
    // note is a full sentence worded by source, not a bare value.
    const lost = providerSelectModel({ panel: '', catalog: ['A'], effective: 'A', source: 'config' }, FALLBACK);
    assert.equal(lost.note, '当前生效 A（来自配置）', 'config-source note is worded by source');

    // A panel pick that lost to a per-call argument says "不是这里选的".
    const panelLost = providerSelectModel({ panel: 'B', catalog: ['A'], effective: 'A', source: 'argument' }, FALLBACK);
    assert.equal(panelLost.note, '本次调用指定 A', 'argument-source note names the override');

    // A panel pick that lost to config says "不是这里选的".
    const configOverride = providerSelectModel({ panel: 'B', catalog: ['A'], effective: 'A', source: 'config' }, FALLBACK);
    assert.equal(configOverride.note, '当前生效 A（来自配置）', 'config-source note is worded by source');

    // Nothing pinned and AtomCode decided: that IS news, because the user is
    // looking at an empty control and wondering what actually ran.
    const own = providerSelectModel({ panel: '', catalog: ['A'], effective: 'A', source: 'atomcode' }, FALLBACK);
    assert.equal(own.note, '当前生效 A（AtomCode 默认）', 'the third source has its own wording');

    // Junk in those display fields must not throw or leak "undefined" text.
    const junk = providerSelectModel({ panel: null, catalog: [], effective: 42, source: [] }, FALLBACK);
    assert.equal(junk.effective, '');
    assert.equal(junk.source, '');
    assert.equal(junk.note, '');
  });

  it('flattens the /models shape — objects with a provider field, never the bare model id', () => {
    // Measured against a real daemon (atomcode 5.2.3):
    //   GET /models -> [{provider:"AtomGit-glm5.3-flash", model:"glm5.3-flash", isDefault:false, effortLevels:[...]}, ...]
    // Mapping with a "must be a string" helper silently dropped every option
    // (an object is not a string), so the dropdown rendered EMPTY while the
    // catalogue was fine — a shape bug that looked like a wording bug.
    const realCatalog = [
      { provider: 'AtomGit-glm5.3-flash', model: 'glm5.3-flash', isDefault: false, effortLevels: ['low', 'high'] },
      { provider: 'AtomGit-qwen3.8-27b', model: 'qwen3.8-27b', isDefault: true, effortLevels: ['low', 'medium', 'xhigh'] },
    ];
    const m = providerSelectModel({ panel: null, catalog: realCatalog }, FALLBACK);
    assert.deepEqual(
      m.options.map((o) => o.value),
      ['', 'AtomGit-glm5.3-flash', 'AtomGit-qwen3.8-27b'],
      'the dropdown must list the model PROFILES, not nothing'
    );
    assert.equal(m.disabled, false, 'and it must be usable, not disabled');
    // The bare model id is NOT a valid provider (红线 8): using it would look
    // right in the dropdown and fail at the daemon.
    assert.ok(!m.options.some((o) => o.value === 'glm5.3-flash'), 'never offer the bare model id');
  });

  it('treats a catalogue of unusable elements as EMPTY, and a missing one as unavailable', () => {
    // Junk elements must not become blank options, and must not fabricate a list.
    const junk = providerSelectModel({ panel: null, catalog: [null, 42, {}, { provider: '' }, '  '] }, FALLBACK);
    assert.equal(junk.disabled, true, 'nothing usable in the catalogue means nothing to pick');
    assert.match(junk.reason, /daemon 未列出档位/);
    assert.deepEqual(junk.options.map((o) => o.value), [''], 'and no blank option may appear');
    // A non-array is "the host could not tell us", NOT "there are none" — different
    // reason, different sentence.
    const missing = providerSelectModel({ panel: null, catalog: 'nope' }, FALLBACK);
    assert.match(missing.reason, /暂不可用/, missing.reason);
  });

  it('marks the profile AtomCode would pick by itself, as a LABEL only', () => {
    // `isDefault` used to be mapped into the snapshot and read by NOTHING — a
    // field shipped on every 30s poll to be dropped at the renderer. Now it is
    // the only reason the catalogue is not a bare name list: it tells the user
    // whether pinning changes anything at all.
    const realCatalog = [
      { provider: 'AtomGit-glm5.3-flash', isDefault: false },
      { provider: 'AtomGit-qwen3.8-27b', isDefault: true },
    ];
    const m = providerSelectModel({ panel: null, catalog: realCatalog }, FALLBACK);
    assert.deepEqual(m.options.map((o) => o.label), [FALLBACK, 'AtomGit-glm5.3-flash', 'AtomGit-qwen3.8-27b（默认）']);
    // The LABEL never becomes the value: "（默认）" is not a provider name, and
    // sending it would be a profile the daemon has never heard of (红线 8).
    assert.deepEqual(m.options.map((o) => o.value), ['', 'AtomGit-glm5.3-flash', 'AtomGit-qwen3.8-27b']);
    // A pinned default keeps its plain value even when the label carries the tag.
    const pinned = providerSelectModel({ panel: 'AtomGit-qwen3.8-27b', catalog: realCatalog }, FALLBACK);
    assert.equal(pinned.value, 'AtomGit-qwen3.8-27b');
    assert.equal(pinned.disabled, false);
  });

  it('never warns about a local sidecar, because there is no sidecar any more', () => {
    // A loopback endpoint used to make a process on this machine a live
    // dependency of the review CLI, and the control said so at the click. The
    // CLI is gone; /models returns profile names, not endpoints, so the host no
    // longer has a name→base_url map to send. A warning left behind here would
    // be the panel describing a risk that no longer exists — and a stale
    // endpoint map arriving from an older host must be ignored, not rendered.
    const stale = providerSelectModel(
      {
        panel: 'atomcode-local',
        catalog: [{ provider: 'atomcode-local' }],
        endpoints: { 'atomcode-local': 'http://127.0.0.1:8899/v1' },
      },
      FALLBACK
    );
    assert.equal(stale.warning, '');
    assert.equal(stale.disabled, false, 'it is still a selectable profile');
  });
});

/**
 * isLoopbackEndpoint — the renderer's NAME for the host's loopback test.
 *
 * Not a copy any more: both halves import `src/shared/loopback.ts`, because the
 * warning must be worded from the same fact the host probes on (`isLoopbackBaseUrl`)
 * — "this choice bills through a process on your machine". Anything unparseable
 * is NOT loopback; guessing would produce warnings about endpoints nobody can
 * point at. Asserted from BOTH halves (`review-select.test.mjs` covers the host
 * export) so that a future edit to one entry point cannot leave the other
 * silently behind.
 */
describe('isLoopbackEndpoint', () => {
  it('recognises the local shapes and nothing else', () => {
    for (const url of ['http://127.0.0.1:8899/v1', 'http://127.0.0.1', 'http://localhost:8899/v1', 'http://[::1]:8899/v1', 'http://localhost']) {
      assert.equal(isLoopbackEndpoint(url), true, url);
    }
    for (const url of ['https://openrouter.example/v1', 'http://192.168.1.9:8899/v1', 'http://0127.0.0.1/v1', 'not a url', '', null, undefined, 42]) {
      assert.equal(isLoopbackEndpoint(url), false, String(url));
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

  it('labels a knob the host reports as DEPARTED as changed', () => {
    // `authored` means "this value differs from the plugin's shipped default". The
    // host decides it, because a renderer sees only the resolved value: `bypass`
    // written deliberately and `bypass` as our own fallback are the same string.
    // NOTE the counterpart case, which used to be asserted the other way and was
    // WRONG: the shipped cordis.patch.yml writes every key, so key-presence is true
    // on a stock install — "did the config contain it" would tag every row 「已改」.
    const rows = turnBoundaryRows({
      approvalMode: 'ask',
      askMaxRounds: 40,
      authored: { approvalMode: true, workingDir: false, askMaxRounds: true },
      defaults: { approvalMode: 'bypass', askMaxRounds: 25 },
    });
    assert.match(rows[0].text, /ask（已改）/, rows[0].text);
    assert.match(rows[2].text, /40（已改）/, rows[2].text);
  });

  it('does NOT cry wolf when the values merely restate the defaults', () => {
    // The live host was in exactly this state: a stock patch with approval_mode:
    // bypass / ask_max_rounds: 25 and nothing changed by the user. Tagging those
    // 「已改」 is the noise this whole card exists to remove.
    const rows = turnBoundaryRows({
      approvalMode: 'bypass',
      askMaxRounds: 25,
      authored: { approvalMode: false, workingDir: false, askMaxRounds: false },
      defaults: { approvalMode: 'bypass', askMaxRounds: 25 },
    });
    for (const row of rows) {
      assert.ok(!/已改/.test(row.text), `nothing was changed, so nothing may claim it: ${row.text}`);
    }
    assert.match(rows[0].text, /（插件默认）/);
    assert.match(rows[2].text, /（插件默认）/);
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
    assert.equal(rows[1].text, '（跟随本次会话的工作目录）');
    assert.match(rows[1].title, /没单独指定/);
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
    // An older host (or the desktop install copy) must still render four rows with
    // real values — and must make NO authorship claim, rather than inventing one.
    // This is the case the LIVE host was actually in: it served `approvalMode:
    // "bypass"` and `askMaxRounds: 25` with no `authored`/`defaults` keys at all.
    // The brief row shows a bare dash there: no mode value, no tag.
    for (const cfg of [undefined, null, {}, { approvalMode: 'bypass', askMaxRounds: 25 }]) {
      const rows = turnBoundaryRows(cfg);
      assert.equal(rows.length, 4, `four rows for ${JSON.stringify(cfg)}`);
      for (const row of rows) {
        assert.ok(row.label && row.title, 'every row keeps its label and its hover explanation');
        assert.ok(!/已改|插件默认/.test(row.text), `no authorship claim without host evidence: ${row.text}`);
      }
      assert.equal(rows[3].label, '评审时自动补提示词');
      assert.equal(rows[3].text, '—', 'no mode evidence on an old host: a dash, not a guess');
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
    assert.match(rows[0].title, /自动执行/);
    assert.match(rows[0].title, /无需你逐次确认/);
  });

  it('names a REFUSED approval_mode instead of labelling the fallback as the default', () => {
    // The host refuses an off-enum value and resolves to the default, so
    // `authored` says false — the "（插件默认）" tag would then tell a user who
    // typed something that they never touched the knob. The refused spelling
    // rides on `approvalModeRejected`, and the row must show BOTH the value in
    // force and the fact that the file asked for something else.
    const rejected = turnBoundaryRows({
      approvalMode: 'bypass',
      approvalModeRejected: 'bypasss',
      ...HOST,
    });
    assert.match(rejected[0].text, /bypasss/, 'the value the file asked for must be named');
    assert.match(rejected[0].text, /fallback|回落/, 'and that it was not honoured');
    assert.ok(!/插件默认/.test(rejected[0].text), 'a refused value is not "the plugin default"');
    assert.match(rejected[0].title, /build \/ accept_edits \/ bypass \/ plan/, 'the legal set is one hover away');

    // No rejection ⇒ nothing added (the row is unchanged for every normal config).
    const legal = turnBoundaryRows({ approvalMode: 'bypass', ...HOST });
    assert.ok(!/回落/.test(legal[0].text));
    assert.ok(!/回落/.test(legal[0].title));
  });
});

describe('inFlightText — what the panel says while a turn is running', () => {
  // The row exists because an `atomcode_ask` reply arrives in ONE piece: for the
  // minutes a turn runs, the panel previously had a frozen counter and nothing
  // else — indistinguishable from a hung plugin. The sentence below is the only
  // thing on screen for that whole window, so its wording is behaviour.
  const base = {
    elapsedMs: 134_000,
    rounds: 3,
    completed: 2,
    chars: 1200,
    sessionId: 'sess-1',
    lastTool: 'bash',
    tokens: 0,
    workingDir: null,
    provider: 'Fake-Provider',
  };

  it('names the counts, the last tool, the size so far and the age', () => {
    const text = inFlightText(base);
    assert.match(text, /3 次工具调用/, 'the round count');
    assert.match(text, /1 未回/, 'and how many are still waiting — a stuck turn is usually waiting on one');
    assert.match(text, /最近 bash/, 'the tool name, not just a number');
    assert.match(text, /1200 字/, 'how much has arrived — a SIZE, never the text itself');
    assert.match(text, /2m14s/, 'the age, formatted by the same helper the rest of the panel uses');
  });

  it('says what has not happened yet instead of printing zeroes', () => {
    // A bare `0 次工具调用` beside real counters reads as a stalled turn; the
    // wording has to separate "just started" from "not moving".
    const text = inFlightText({ ...base, elapsedMs: 400, rounds: 0, completed: 0, chars: 0, lastTool: '' });
    assert.match(text, /尚无工具调用/);
    assert.match(text, /尚无输出/);
  });

  it('never prints a negative outstanding count', () => {
    // `completed` can exceed `rounds` only if a future daemon answers a call it
    // never announced. The row must not read「（-1 未回）」.
    const text = inFlightText({ ...base, rounds: 1, completed: 2 });
    assert.doesNotMatch(text, /-/);
  });

  it('is exported to the offline suite like every other renderer helper', () => {
    assert.equal(typeof inFlightText, 'function');
  });
});
describe('createMessageAsk — the 锐评 row hands its OWN reply to the command', () => {
  // The surviving half of the old popover, and the whole of it is now: read the
  // reply the host already rendered, hand it to `requestReview`, stop. These
  // cases pin the read path (messageTextOf over the chat projection), the
  // null-vs-empty distinction that decides whether the command gets an argument,
  // and the hook-before-guard ordering that would otherwise be a conditional hook.
  //
  // `h` is the three-line element builder the component is written against —
  // nothing here needs React, because the button is a single element.
  const h = (type, props, ...children) => ({
    type,
    props: Object.assign({}, props, { children: children.length <= 1 ? children[0] : children }),
  });

  const snapshotOf = (nodes) => ({ nodes: { values: () => nodes } });
  const tail = (messageId, blocks) => ({ kind: 'turn-tail', data: { closing: { finalNode: { messageId }, blocks } } });

  /** Capture console.warn for one case (only `describe, it` are imported). */
  function withWarnings(run) {
    const saved = console.warn;
    const seen = [];
    console.warn = (...args) => {
      seen.push(args.map(String).join(' '));
    };
    try {
      return run(seen);
    } finally {
      console.warn = saved;
    }
  }

  it('renders ONE 锐评 button and sends the rendered reply, not the message id', () => {
    const seen = [];
    const MessageAsk = createMessageAsk({ h, requestReview: (r) => seen.push(r) || true });
    const button = MessageAsk({
      messageId: 'm1',
      useChat: (select) => select(snapshotOf([tail('m1', [{ kind: 'text', text: '改完了：三个文件。' }])])),
    });
    assert.equal(button.type, 'button');
    assert.equal(button.props.children, '锐评');
    assert.match(button.props.title, /\/atomcode-review/, 'the title says where the text is going');
    button.props.onClick();
    assert.deepEqual(seen, [{ text: '改完了：三个文件。' }], 'the reply is quoted; the id stays local');
  });

  it('passes "" through without a warning — a tool-only step has no prose but IS found', () => {
    withWarnings((warnings) => {
      const seen = [];
      const MessageAsk = createMessageAsk({ h, requestReview: (r) => seen.push(r) || true });
      const button = MessageAsk({
        messageId: 'm1',
        useChat: (select) => select(snapshotOf([tail('m1', [{ kind: 'tool-call' }])])),
      });
      button.props.onClick();
      assert.deepEqual(seen, [{ text: '' }]);
      assert.deepEqual(warnings, [], 'found-but-empty is not the same failure as not-found');
    });
  });

  it('names WHY a reply could not be read, then still prefills the command', () => {
    // The two causes look identical from the composer, so the console line is the
    // only place they differ — and it must not turn into a refusal: the click
    // still inserts `/atomcode-review` and reviews the working tree.
    withWarnings((warnings) => {
      const seen = [];
      const MessageAsk = createMessageAsk({ h, requestReview: (r) => seen.push(r) || true });
      const button = MessageAsk({
        messageId: 'm-gone',
        useChat: (select) => select(snapshotOf([tail('m1', [{ kind: 'text', text: '别的消息' }])])),
      });
      button.props.onClick();
      assert.deepEqual(seen, [{ text: null }], 'the click still hands over a null reply');
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /^\[atomcode-bridge\] /);
      assert.match(warnings[0], /m-gone/, 'the id is named, or the line is unactionable');
      assert.match(warnings[0], /nodes=1 kinds=turn-tail/, 'the projection is reported, which is what diagnoses a shape change');
    });
  });

  it('survives a throwing store and a missing hook, and still prefills', () => {
    withWarnings((warnings) => {
      const seen = [];
      const MessageAsk = createMessageAsk({ h, requestReview: (r) => seen.push(r) || true });

      const throwing = MessageAsk({
        messageId: 'm1',
        useChat: () => {
          throw new Error('store disposed');
        },
      });
      throwing.props.onClick();
      assert.deepEqual(seen, [{ text: null }]);
      // A store that threw is swallowed into "no snapshot", so the report reads
      // nodes=0 kinds=none — the SAME line an absent hook produces. That is
      // deliberate: the click's outcome is identical either way, and the console
      // never claims to know more than it observed.
      assert.match(warnings.at(-1), /nodes=0 kinds=none/);

      // No `useChat` on the props at all: same named outcome, no crash.
      const noHook = MessageAsk({ messageId: 'm1' });
      noHook.props.onClick();
      assert.deepEqual(seen.at(-1), { text: null });
      assert.equal(warnings.length, 2, 'one line per click that could not read a reply');
      assert.equal(warnings[0], warnings[1], 'a thrown store and an absent hook are indistinguishable here, on purpose');
    });
  });

  it('renders NOTHING without a messageId — and the hook still ran first', () => {
    // The hook sits ABOVE the guard on purpose: a hook called after an early
    // return is a conditional hook, and if `messageId` ever arrived late React
    // would throw on the changed hook count. This case fails loudly if a future
    // edit "tidies" the guard up above the hook.
    let hookCalls = 0;
    const MessageAsk = createMessageAsk({ h, requestReview: () => true });
    const rendered = MessageAsk({
      messageId: '',
      useChat: (select) => {
        hookCalls += 1;
        return select(snapshotOf([]));
      },
    });
    assert.equal(rendered, null);
    assert.equal(hookCalls, 1, 'the subscription must happen before the guard');

    assert.equal(MessageAsk({ messageId: 42, useChat: (select) => select(snapshotOf([])) }), null);
    assert.equal(MessageAsk({ useChat: (select) => select(snapshotOf([])) }), null);
    assert.equal(MessageAsk(null), null, 'a null props bag is a null render, not a TypeError');
  });

  it('builds the button once per factory, with the tool title the user reads', () => {
    const MessageAsk = createMessageAsk({ h, requestReview: () => true });
    const button = MessageAsk({ messageId: 'm1', useChat: (select) => select(snapshotOf([])) });
    assert.equal(button.props.type, 'button');
    assert.equal(typeof button.props.style, 'object', 'the row styles it like the host action row');
    assert.match(button.props.title, /按回车/, 'the title tells the human the click is only half the step');
    assert.doesNotMatch(button.props.title, /送到会话|弹窗/, 'no popover vocabulary survives');
  });
});
