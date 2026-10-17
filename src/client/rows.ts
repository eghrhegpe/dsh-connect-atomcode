/**
 * Card rows — pure functions that compute what each card displays.
 *
 * `turnBoundaryRows`: patch-only knobs and their provenance verdict.
 * `providerRows` / `providerSelectModel`: the model dropdown rows and model.
 *
 * All are pure so they can be unit-tested without a browser.
 */

import type {
  BoundaryRow,
  ConfigBranch,
  DaemonBranch,
  InFlightTurn,
  ProtocolBranch,
  ProviderBranch,
  ProviderRow,
  ProviderSelectModel,
  ProviderSlotName,
} from './types.ts';
import { isLoopbackBaseUrl } from '../shared/loopback.ts';
import { fmtCountdown } from './quota.ts';

// ── 启动情况（daemon 存活） ───────────────────────────────────────────────

/**
 * The one line for a turn that is running right now.
 *
 * An ask reply is aggregated and returned in ONE piece, so before this existed
 * the panel had nothing true to say for the whole turn: a frozen counter and a
 * minutes-long gap, indistinguishable from a hung plugin. This prints counts and
 * names only — never partial content, which would become a second, worse copy of
 * a deliverable rendered somewhere nobody asked for.
 *
 * The tool call that has NOT answered is named too (`rounds - completed`):
 * "3 轮 · 1 未回" says a tool call is outstanding, which is what a turn that
 * looks stuck is usually waiting on.
 */
export function inFlightText(turn: InFlightTurn): string {
  const pending = Math.max(0, (turn.rounds || 0) - (turn.completed || 0));
  const parts = [
    `${turn.rounds || 0} 次工具调用${pending > 0 ? `（${pending} 未回）` : ''}`,
    turn.lastTool ? `最近 ${turn.lastTool}` : '尚无工具调用',
    // Characters accumulated, NOT the text: it answers "is it producing
    // anything" without shipping the answer twice.
    turn.chars > 0 ? `已收 ${turn.chars} 字` : '尚无输出',
    // `fmtCountdown`, not `fmtDuration`: a turn runs in MINUTES, and
    // `fmtDuration` renders those as a stopwatch (`134.0 s`), which is the
    // wrong shape for the one number a waiting user actually reads. This helper
    // already speaks minutes and hours (it formats the rolling-window reset),
    // so the two long durations on the page now read the same way.
    `已跑 ${fmtCountdown(Math.round((turn.elapsedMs || 0) / 1000))}`,
  ];
  return parts.join(' · ');
}

/**
 * The one line the panel puts on the bundle card about daemon liveness.
 *
 * `downMessage` is worded by the HOST (`describeDaemonDown`), and the tool errors
 * quote that same function — so the page and the model are handed one sentence,
 * not two translations of one fact. Re-deriving the cause here would put the
 * cause in two places with two independent chances to drift, which is precisely
 * how "未监听" came to be said about four different failures.
 *
 * An older host sends no `downMessage` at all. Say that, rather than leaving the
 * port standing where a reason belongs.
 */
export function daemonStatusLine(
  daemon: DaemonBranch | null | undefined,
  daemonVersion?: string | null,
): string {
  const d: DaemonBranch = daemon && typeof daemon === 'object' ? daemon : {};
  if (d.up) {
    const version = typeof daemonVersion === 'string' && daemonVersion !== '' ? ' ' + daemonVersion : '';
    return 'daemon 运行中' + version;
  }
  const why =
    typeof d.downMessage === 'string' && d.downMessage !== ''
      ? d.downMessage
      : '原因未记录（宿主较旧）';
  return `daemon 未运行（${why}${d.autoStart ? '；可自动拉起' : ''}）`;
}

// ── 协议漂移（面板告警） ──────────────────────────────────────────────────

/**
 * The sentence for a daemon that sent event types this client does not know, or
 * `''` when there is nothing to say.
 *
 * Pure for the same reason `daemonStatusLine` is one: the rule is then testable
 * without a browser, and the panel and the tool render cannot word one fact two
 * ways.
 *
 * Silence is the DEFAULT, and here it carries meaning. An older host sends no
 * `unknownTypes` at all, and a notice that fired on absence would cry wolf on
 * every stock install — which is how a real warning gets trained out. Only a
 * NON-EMPTY list is news.
 */
export function protocolDriftNotice(protocol: ProtocolBranch | null | undefined): string {
  const p: ProtocolBranch = protocol && typeof protocol === 'object' ? protocol : {};
  const types = Array.isArray(p.unknownTypes)
    ? p.unknownTypes.filter((t) => typeof t === 'string' && t !== '')
    : [];
  if (types.length === 0) return '';
  return (
    `协议漂移：daemon 发来了本插件不认识的事件类型（${types.slice().sort().join(', ')}），` +
    'AtomCode 可能已升级或改了事件名。本插件的轮数熔断靠计数 tool_start 生效——' +
    '若被改名的正是这类被计数的事件，熔断会少计甚至完全不触发，此时 round_count 不可信，' +
    '请调小 ask 的 max_rounds 或人工盯防。'
  );
}

// ── 回合边界 ──────────────────────────────────────────────────────────────

/**
 * The "回合边界" card's rows — a pure function so the honesty rule below is
 * testable without a browser.
 *
 * The rule: a patch-only knob is labelled by WHAT THE HOST SAYS ABOUT IT, not by
 * whether it happens to look default-ish. `cfg.authored` means "this value
 * DEPARTS from the plugin's shipped default" — the host decides that, because a
 * renderer only sees the resolved value and could not tell a deliberate
 * `approval_mode: bypass` from our own fallback. Comparing `askMaxRounds === 25`
 * here would also be a SECOND copy of a number `lib/index.js` owns.
 *
 * Rows are KEPT (not hidden) when at their defaults, because this is the card
 * that carries the `bypass` safety posture — silently dropping it would remove
 * the one place a user can see that AtomCode's own tools run unattended.
 */
export function turnBoundaryRows(cfg: ConfigBranch | null | undefined): BoundaryRow[] {
  const src: ConfigBranch = cfg && typeof cfg === 'object' ? cfg : {};
  const authored: NonNullable<ConfigBranch['authored']> =
    src.authored && typeof src.authored === 'object' ? src.authored : {};
  const defaults: NonNullable<ConfigBranch['defaults']> =
    src.defaults && typeof src.defaults === 'object' ? src.defaults : {};
  const askDefault = Number.isInteger(defaults.askMaxRounds) ? (defaults.askMaxRounds as number) : null;
  const approvalDefault = typeof defaults.approvalMode === 'string' ? defaults.approvalMode : '';
  const mode = typeof src.approvalMode === 'string' ? src.approvalMode : '';
  const dir = typeof src.defaultWorkingDir === 'string' ? src.defaultWorkingDir : '';
  const rounds = Number.isInteger(src.askMaxRounds) ? (src.askMaxRounds as number) : null;
  // Verdict: 'changed' | 'default' | 'unknown'.
  //
  // 'unknown' is NOT decoration — it is the only honest answer when the host
  // reports no `authored` branch AND sent no default to compare against. An
  // older host (or the desktop install copy) hands us only the RESOLVED value,
  // and `approvalMode: 'ask'` from it is either the user's choice or a build
  // whose default is 'ask' — we cannot tell. Tagging that "（插件默认）" would
  // assert what we do not know, the same class of lie as printing a guessed
  // quota number (红线 2). So when we cannot tell, we do not tag at all.
  type Verdict = 'changed' | 'default' | 'unknown';
  const verdict = (
    key: 'approvalMode' | 'workingDir' | 'askMaxRounds',
    value: unknown,
    fallback: unknown,
  ): Verdict => {
    if (authored && key in authored) return authored[key] === true ? 'changed' : 'default';
    if (fallback === null || fallback === undefined || fallback === '') return 'unknown';
    return value === fallback ? 'default' : 'changed';
  };
  const tag = (v: Verdict): string =>
    v === 'changed' ? '（已改）' : v === 'default' ? '（插件默认）' : '';
  return [
    {
      label: '审批模式',
      text: mode === '' ? '—' : mode + tag(verdict('approvalMode', mode, approvalDefault)),
      title:
        'patch 字段 approval_mode；面板上没有输入框，改它要动 cordis.patch.yml。' +
        'bypass = AtomCode 自己的工具在回合内无人值守执行（AtomCode 侧自主，与 DSH 的权限预设无关）。',
    },
    {
      label: '工作目录',
      text: dir === '' ? '（会话工作目录）' : dir + tag(verdict('workingDir', dir, null)),
      title: dir === '' ? 'patch 字段 working_dir 留空 = 靠调用参数或会话工作目录' : 'patch 字段 working_dir',
    },
    {
      label: 'ask 轮数上限',
      text:
        rounds === null
          ? '—'
          : rounds > 0
            ? String(rounds) + tag(verdict('askMaxRounds', rounds, askDefault))
            : '不限',
      title:
        'patch 字段 ask_max_rounds。超出即停止等待（不是远端 kill：daemon 侧的回合可能仍在后台跑完）。',
    },
  ];
}

// ── 运行环境（模型档位） ──────────────────────────────────────────────────

/**
 * Is this base_url a loopback endpoint — i.e. a local sidecar process the
 * review then DEPENDS on?
 *
 * This IS the host's predicate (`isLoopbackBaseUrl`), imported from
 * `src/shared/loopback.ts` under the renderer's name for it. It used to be a
 * hand-written copy: the host decides whether to probe before spawning, and the
 * renderer words the warning ("this choice bills through a process on your
 * machine, and stops working the moment it exits") — two halves needing one fact
 * is exactly the case a shared module exists for.
 */
export { isLoopbackBaseUrl as isLoopbackEndpoint };

/**
 * The model rows, derived from ONE stats snapshot.
 *
 * Two entries, always both, never collapsed into one: they are TWO DIFFERENT
 * namespaces (ask = daemon model profile, review = CLI direct entry), and one
 * merged row would read as "same knob, two names" — the exact confusion
 * 红线 8 exists to prevent.
 */
export function providerRows(cfg: ConfigBranch | null | undefined): ProviderRow[] {
  const src: ConfigBranch = cfg && typeof cfg === 'object' ? cfg : {};
  const name = (v: unknown): string => (typeof v === 'string' && v.trim() !== '' ? v.trim() : '');
  const ask = name(src.defaultProvider);
  const review = name(src.reviewDefaultProvider);
  return [
    {
      slotName: 'ask',
      label: '默认档位 · ask',
      fallback: '未插手',
      value: ask || '未插手',
      pinned: ask !== '',
      title:
        'atomcode_ask 走 daemon：这里选的是模型档位（GET /models 的 provider 字段，' +
        '形如 AtomGit-glm5.3-flash）。未插手 = 连 provider 字段都不发，由 AtomCode 自己的默认决定。' +
        '只影响不显式传 provider 的调用。',
    },
    {
      slotName: 'review',
      label: '默认 provider · review',
      fallback: '未插手',
      value: review || '未插手',
      pinned: review !== '',
      title:
        'atomcode_review 走 CLI：这里选的是 config.toml 里的直连条目名（[providers.<name>]，' +
        '形如 atomcode-local —— 那是个名字，不是文件路径）。未插手 = 由 config.toml 的默认或唯一直连条目顶上。' +
        '与左边是两套命名空间，不能同一个名字两边用。',
    },
  ];
}

/**
 * The dropdown model for one provider slot — pure, so every edge is testable
 * without a browser or a daemon.
 *
 * Three things it owns:
 *  - the selected value is the PANEL pick, NOT the effective one
 *  - a panel pick missing from the catalogue is APPENDED, never dropped
 *  - an unusable slot renders a REASON, never a bare empty dropdown (红线 3)
 */
export function providerSelectModel(
  provider: ProviderBranch | null | undefined,
  slotName: ProviderSlotName,
  fallbackLabel: string,
): ProviderSelectModel {
  const src = provider && typeof provider === 'object' ? provider[slotName] : null;
  if (!src || typeof src !== 'object') {
    return {
      value: '',
      options: [{ value: '', label: fallbackLabel }],
      disabled: true,
      reason: '宿主没有提供档位接口（旧版本，或 /provider 路由未注册）',
      effective: '',
      source: '',
      note: '',
      warning: '',
    };
  }
  const name = (v: unknown): string => (typeof v === 'string' && v.trim() !== '' ? v.trim() : '');
  const panel = name(src.panel);
  // The two slots do NOT agree on the catalogue element shape, because the two
  // endpoints do not: /models answers with OBJECTS ({provider, isDefault})
  // while the review CLI's direct entries are plain STRINGS. Both go through
  // here, so both are flattened to the option VALUE — and a shape the host did
  // not send is null (unavailable), never [] (empty), which would read as
  // "your machine has no models".
  const optionValue = (v: string | { provider?: string }): string => {
    if (typeof v === 'string') return name(v);
    if (v && typeof v === 'object') {
      return name(v.provider);
    }
    return '';
  };
  // `isDefault` is the ONLY reason the ask catalogue is not a bare name list:
  // it says which profile AtomCode would pick by itself, i.e. whether a pin
  // changes anything. It ships as a LABEL, never as the value — the value is
  // what gets sent as `provider`, and "（默认）" is not a provider name.
  const optionEntry = (v: string | { provider?: string; isDefault?: boolean }): { value: string; label: string } | null => {
    const value = optionValue(v);
    if (value === '') return null;
    const isDefault = !!(v && typeof v === 'object' && v.isDefault === true);
    return { value, label: isDefault ? `${value}（默认）` : value };
  };
  const catalog = Array.isArray(src.catalog)
    ? src.catalog.map(optionEntry).filter((e): e is { value: string; label: string } => e !== null)
    : null;
  // A pinned name the catalogue can't vouch for (unfetchable, or a shape the
  // host never sent) still stays VISIBLE — a disabled select whose value has
  // no matching <option> renders as "nothing selected", which reads as a lie
  // when a pick is actually on disk.
  const pinned = panel ? [{ value: panel, label: panel }] : [];
  const list =
    catalog === null
      ? pinned
      : catalog.some((e) => e.value === panel)
        ? catalog
        : pinned.concat(catalog);
  const options = [{ value: '', label: fallbackLabel }].concat(list);
  const effective = name(src.effective);
  const source = name(src.source);
  const branch: ProviderBranch = provider as ProviderBranch;
  let disabled = false;
  let reason = '';
  if (branch.foreignVersion === true) {
    disabled = true;
    reason = name(branch.storeError) || '状态文件由更新版本的插件写入，本版本不覆盖它';
  } else if (catalog === null) {
    disabled = true;
    reason = name(src.catalogError) || name(branch.storeError) || '档位列表暂不可用（daemon 未在线？）';
  } else if (list.length === 0) {
    disabled = true;
    reason =
      slotName === 'ask'
        ? 'daemon 未列出档位'
        : 'config.toml 里没有直连条目';
  }
  // `note` is a human-readable sentence about the effective value, worded by
  // SOURCE. The old shape was a bare `effective` that the caller formatted as
  // "这次调用实际用 X（不是这里选的）" — which is a lie when the user never
  // picked anything (panel === '') and the value came from config or AtomCode's
  // own default. Now:
  //   - source === 'panel'  → "不是这里选的" (the pick lost to a later layer)
  //   - source === 'config' → "来自配置" (the config field won)
  //   - source === 'atomcode' → "AtomCode 默认" (nothing pinned; ask slot)
  //   - source === 'auto'   → nothing (review slot: the CLI picks, see below)
  //   - source === 'argument' → "本次调用指定" (per-call argument overrode)
  // The last two are worth naming: `argument` is the execute path's own rung —
  // a POLL snapshot asks the ladder with no argument, so the panel does not
  // normally produce it, and it is handled anyway because the host's ladder
  // (one ladder now, shared by both callers) can, and an unhandled source would
  // render a silently empty note. `auto` says nothing on purpose: leaving review
  // unpinned is not a value, it is a delegation to the CLI's own ladder.
  // An empty note means "nothing to say" — the control shows what the user
  // chose, so narrating that fact is decoration.
  let note = '';
  if (!disabled && effective !== '' && effective !== panel) {
    if (source === 'panel') {
      note = '这次调用实际用 ' + effective + '（不是这里选的）';
    } else if (source === 'config') {
      note = '当前生效 ' + effective + '（来自配置）';
    } else if (source === 'atomcode') {
      note = '当前生效 ' + effective + '（AtomCode 默认）';
    } else if (source === 'argument') {
      note = '本次调用指定 ' + effective;
    }
  }
  // The loopback warning is a DIFFERENT kind of sentence from `note`, so it
  // gets its own field: it is about what the pick DEPENDS ON, not about which
  // layer won. It fires on the SELECTED entry (loopback endpoint = a local
  // sidecar process, which in the only measured working setup is the proxy
  // that converts CodingPlan quota into a standard endpoint on a gateway that
  // does not check signatures). README's risk table said this; the panel now
  // says it at the moment of the click.
  let warning = '';
  if (slotName === 'review') {
    // Read the endpoint map from the SLOT, which is where the host puts it
    // (`provider.review.endpoints`). It used to be read from the branch ROOT
    // (`provider.endpoints`), which no host build has ever written — so this
    // warning was unreachable in practice while both halves' tests stayed green.
    const endpoints = src.endpoints && typeof src.endpoints === 'object' ? src.endpoints : {};
    const target = name(panel) || effective;
    const baseUrl = name((endpoints as Record<string, unknown>)[target]);
    if (baseUrl !== '' && isLoopbackBaseUrl(baseUrl)) {
      warning = '本地端点 ' + baseUrl + '：评审经本机进程转发计费，它一停 review 立刻断（探活会给出具名诊断）';
    }
  }
  return {
    value: panel,
    options,
    disabled,
    reason,
    effective,
    source,
    note,
    warning,
  };
}
