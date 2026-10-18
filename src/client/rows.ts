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
  // A rejected spelling is NOT the plugin default, even though the value the
  // host resolved happens to equal it: the user authored something, it was
  // refused, and the panel must not answer "you never touched this knob".
  // `authored` cannot carry that fact — the host derives it from the RESOLVED
  // value, so by the time it reaches here the rejection is invisible.
  const modeRejected =
    typeof src.approvalModeRejected === 'string' && src.approvalModeRejected !== ''
      ? src.approvalModeRejected
      : '';
  const dir = typeof src.defaultWorkingDir === 'string' ? src.defaultWorkingDir : '';
  const rounds = Number.isInteger(src.askMaxRounds) ? (src.askMaxRounds as number) : null;
  const briefMode = typeof src.reviewBriefMode === 'string' ? src.reviewBriefMode : '';
  const briefRejected =
    typeof src.reviewBriefModeRejected === 'string' && src.reviewBriefModeRejected !== ''
      ? src.reviewBriefModeRejected
      : '';
  const briefDefault = typeof defaults.reviewBriefMode === 'string' ? defaults.reviewBriefMode : '';
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
    key: 'approvalMode' | 'workingDir' | 'askMaxRounds' | 'reviewBriefMode',
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
      label: 'AtomCode 自动执行权限',
      text:
        mode === ''
          ? '—'
          : modeRejected !== ''
            ? `${mode}（已回落：你填的是 ${modeRejected}）`
            : mode + tag(verdict('approvalMode', mode, approvalDefault)),
      title:
        '决定 AtomCode 在帮你跑工具（执行命令、改文件）时受多大限制。bypass = 全程自动执行、无需你逐次确认（出厂默认，且当前 daemon 对后台调用一律自动放行，所以切换这里实际不改变行为）；build / accept_edits / plan 是更保守的档位。' +
        (modeRejected !== ''
          ? `你填的「${modeRejected}」不是合法档位（只能是 build / accept_edits / bypass / plan），已回落到 ${mode}——照原样传过去每个回合都会被 daemon 以 422 拒绝。`
          : ''),
    },
    {
      label: 'AtomCode 干活的文件夹',
      text: dir === '' ? '（跟随本次会话的工作目录）' : dir + tag(verdict('workingDir', dir, null)),
      title: dir === '' ? '没单独指定 = AtomCode 在你这次会话所在的工作目录里干活' : 'AtomCode 干活所在的文件夹',
    },
    {
      label: '单次咨询最多轮数',
      text:
        rounds === null
          ? '—'
          : rounds > 0
            ? String(rounds) + tag(verdict('askMaxRounds', rounds, askDefault))
            : '不限',
      title:
        '一次「问 AtomCode」最多让它自己循环多少轮（每轮可能调用工具、读文件）。到上限就停止等待结果（不是强行中止：daemon 那边可能还在后台跑完）。',
    },
    {
      label: '评审时自动补提示词',
      text:
        briefMode === ''
          ? '—'
          : briefRejected !== ''
            ? `${briefMode}（已回落：你填的是 ${briefRejected}）`
            : briefMode + tag(verdict('reviewBriefMode', briefMode, briefDefault)),
      title:
        '用「代码评审」时，如果你没写要评什么，是否自动附一段内置评审提示词。always = 总是附上（你写了也加在后面）；' +
        'when-empty = 只有你没写时才补（你写了就原样发）；never = 从不补（你没写就直接拒绝）。' +
        (briefRejected !== ''
          ? `你填的「${briefRejected}」不是合法取值（只能是 always / when-empty / never），已回落到 ${briefMode}。`
          : ''),
    },
  ];
}

// ── 运行环境（模型档位） ──────────────────────────────────────────────────

/**
 * Is this base_url a loopback endpoint — i.e. a process on THIS machine?
 *
 * This IS the host's predicate (`isLoopbackBaseUrl`), imported from
 * `src/shared/loopback.ts` under the renderer's name for it. It used to back
 * the review dropdown's "this pick bills through a local sidecar" warning: the
 * host probed that endpoint before spawning the CLI and the renderer worded the
 * consequence, and two halves needing one fact is exactly the case a shared
 * module exists for.
 *
 * That warning died with the CLI (the daemon — itself loopback-only — answers
 * `/models` with profile NAMES, not base_urls, so there is no endpoint left to
 * test). The predicate is kept and still exported because it is a pure,
 * documented fact about this plugin's transport, and because deleting a shared
 * module is a separate decision from deleting a consumer.
 */
export { isLoopbackBaseUrl as isLoopbackEndpoint };

/**
 * The model row, derived from ONE stats snapshot.
 *
 * There is exactly ONE row because there is exactly ONE ladder now
 * (per-call `provider` > panel pick > `default_provider` > AtomCode's own
 * default). It used to be two rows for two namespaces — the review row asked
 * for a `[providers.<name>]` direct entry and fed a spawned CLI — and that
 * second namespace died with the CLI (红线 8's "two namespaces" is retired).
 */
export function providerRows(cfg: ConfigBranch | null | undefined): ProviderRow[] {
  const src: ConfigBranch = cfg && typeof cfg === 'object' ? cfg : {};
  const name = (v: unknown): string => (typeof v === 'string' && v.trim() !== '' ? v.trim() : '');
  const ask = name(src.defaultProvider);
  return [
    {
      label: '默认对话模型',
      fallback: '未插手',
      value: ask || '未插手',
      pinned: ask !== '',
      title:
        '「问 AtomCode」和「代码评审」都用这一个下拉选择的对话模型（形如 AtomGit-glm5.3-flash）。' +
        '没选 = 不指定，用 AtomCode 自己的默认模型。只影响你没单独点名模型的那些调用。',
    },
  ];
}

/**
 * Read one finished assistant message's prose out of the chat snapshot.
 *
 * WHY THIS IS POSSIBLE AT ALL (the P2 verdict says it should not be): the
 * plugin cannot INJECT anything into the session, and it cannot call back into
 * the host's conversation services. But the seat the chat's own action row uses
 * — `conversation.chat.assistant-actions` — is handed `{ messageId }` as
 * OWNER props and `useChat` as a standard prop. `useChat` is the rendered
 * projection of the conversation: it is the same data the host's own 「复制」
 * button reads (`assistantText(closing.blocks)`). So the text is not fetched,
 * not intercepted, not scraped from the DOM — it is passed to us by the owner,
 * exactly as the reply's own 复制 button gets it. The human still reads it
 * before anything is sent, so this stays "a paste slot with the paste done".
 *
 * The lookup mirrors the host's own two halves, because the id and the text are
 * built in DIFFERENT places:
 *
 *   · the id comes from the `turn-tail` node — the footer of a completed turn,
 *     whose `data.closing` is the last assistant step carrying prose
 *     (`turnTailDefinition.buildViewNode` publishes `tailData` verbatim, and
 *     `TurnTailNodeView` reads `data.closing.finalNode.messageId`);
 *   · the text comes from that closing step's own blocks.
 *
 * The first version of this function looked for `data.finalNode` on the
 * `assistant-step` node instead and never matched — the assistant node carries
 * `finalNode` under `data`, but the id the owner hands us belongs to the
 * turn-tail's `closing`, so the search walked right past it. The fix is to read
 * the same node the host reads, and to fall back to the assistant-step shape so
 * a projection that publishes both keeps working.
 *
 * Text blocks only, concatenated with no separator: the host's own 复制 button
 * does exactly this (`assistantText`). Returns null when the message is not
 * there at all, '' when it is there but carries no prose (a tool-only step), so
 * the two cases stay distinguishable.
 */
export function messageTextOf(snapshot: any, messageId: string | null | undefined): string | null {
  if (!snapshot || typeof snapshot !== 'object' || messageId == null) return null;
  const nodes = snapshot.nodes;
  if (!nodes || typeof nodes.values !== 'function') return null;
  const textOf = (settled: any): string => {
    const blocks = Array.isArray(settled.blocks) ? settled.blocks : [];
    return blocks
      .filter((block: any) => block && block.kind === 'text' && typeof block.text === 'string')
      .map((block: any) => block.text)
      .join('');
  };
  try {
    // Pass 1: the turn-tail footer — where the owner's messageId actually lives.
    for (const node of nodes.values()) {
      const closing = node && node.data && node.data.closing;
      if (!closing || !closing.finalNode || closing.finalNode.messageId !== messageId) continue;
      return textOf(closing);
    }
    // Pass 2: an assistant-step node that carries the settled message itself.
    for (const node of nodes.values()) {
      const data = node && node.data;
      const settled = data && data.finalNode;
      if (!settled || settled.messageId !== messageId) continue;
      return textOf(settled);
    }
  } catch {
    return null;
  }
  return null;
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
  fallbackLabel: string,
): ProviderSelectModel {
  const src = provider && typeof provider === 'object' ? provider : null;
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
  // One catalogue shape now: /models answers with OBJECTS ({provider,
  // isDefault}). It used to be a union with the review CLI's plain-string
  // direct entries, which is why this flattened both — objects only today, and
  // a shape the host did not send is null (unavailable), never [] (empty),
  // which would read as "your machine has no models".
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
  const optionEntry = (v: string | { provider?: string; isDefault?: boolean; effortLevels?: string[]; currentEffort?: string | null }): { value: string; label: string; effortLevels?: string[]; currentEffort?: string | null } | null => {
    const value = optionValue(v);
    if (value === '') return null;
    const isDefault = !!(v && typeof v === 'object' && v.isDefault === true);
    const label = isDefault ? `${value}（默认）` : value;
    const effortLevels = (v && typeof v === 'object' && Array.isArray(v.effortLevels) && v.effortLevels.length > 0) ? v.effortLevels : undefined;
    const currentEffort = (v && typeof v === 'object' && typeof v.currentEffort === 'string') ? v.currentEffort : null;
    return { value, label, ...(effortLevels ? { effortLevels } : {}), ...(currentEffort ? { currentEffort } : {}) };
  };
  const catalog = Array.isArray(src.catalog)
    ? src.catalog.map(optionEntry).filter((e): e is { value: string; label: string; effortLevels?: string[]; currentEffort?: string | null } => e !== null)
    : null;
  // A pinned name the catalogue can't vouch for (unfetchable, or a shape the
  // host never sent) still stays VISIBLE — a disabled select whose value has
  // no matching <option> renders as "nothing selected", which reads as a lie
  // when a pick is actually on disk.
  type OptionEntry = { value: string; label: string; effortLevels?: string[]; currentEffort?: string | null };
  const pinned: OptionEntry[] = panel ? [{ value: panel, label: panel }] : [];
  const list: OptionEntry[] =
    catalog === null
      ? pinned
      : catalog.some((e) => e.value === panel)
        ? (catalog as OptionEntry[])
        : pinned.concat(catalog as OptionEntry[]);
  const options: OptionEntry[] = [{ value: '', label: fallbackLabel }].concat(list);
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
    reason = 'daemon 未列出档位';
  }
  // `note` is a human-readable sentence about the effective value, worded by
  // SOURCE. The old shape was a bare `effective` that the caller formatted as
  // "这次调用实际用 X（不是这里选的）" — which is a lie when the user never
  // picked anything (panel === '') and the value came from config or AtomCode's
  // own default. Now:
  //   - source === 'panel'    → "不是这里选的" (the pick lost to a later layer)
  //   - source === 'config'   → "来自配置" (the config field won)
  //   - source === 'atomcode' → "AtomCode 默认" (nothing pinned)
  //   - source === 'argument' → "本次调用指定" (per-call argument overrode)
  // The last one is worth naming: `argument` is the execute path's own rung —
  // a POLL snapshot asks the ladder with no argument, so the panel does not
  // normally produce it, and it is handled anyway because the ladder can, and
  // an unhandled source would render a silently empty note. An empty note means
  // "nothing to say" — the control shows what the user chose, so narrating that
  // fact is decoration.
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
  // `warning` used to carry "this pick depends on a local sidecar process",
  // read from the review namespace's name→base_url map. The CLI is gone, the
  // daemon's `/models` returns profile names rather than endpoints, and the
  // host no longer sends that map — so there is nothing left to warn about and
  // the field stays permanently empty (it is part of the row contract, not
  // part of this function's output surface).
  const warning = '';
  // The effort levels for the SELECTED model (if any). The panel shows them
  // so the user knows which reasoning-effort values are legal for the current
  // pick before firing a turn.
  const selectedOption = panel
    ? list.find((e: any) => e.value === panel)
    : null;
  const effortLevels = selectedOption && Array.isArray(selectedOption.effortLevels) && selectedOption.effortLevels.length > 0
    ? selectedOption.effortLevels
    : undefined;
  const currentEffort = selectedOption && typeof selectedOption.currentEffort === 'string'
    ? selectedOption.currentEffort
    : null;
  return {
    value: panel,
    options,
    disabled,
    reason,
    effective,
    source,
    note,
    warning,
    ...(effortLevels ? { effortLevels } : {}),
    ...(currentEffort ? { currentEffort } : {}),
  };
}
