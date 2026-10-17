/**
 * Host runtime — everything the plugin accumulates while it is mounted.
 *
 * Extracted from `src/host/index.ts` (apply() split). One object holds the live
 * stats bag, the two state stores, daemon liveness + spawning, the quota cache
 * and the panel-facing provider state; `apply()` hands this object to the two
 * tool mounters and the route mounter so none of them re-declare closures.
 *
 * This block used to be declared inline in `apply()`, ~420 lines of closures.
 * Length was the lesser problem:
 *
 *  - A closure is an INVISIBLE dependency. Several of these functions write the
 *    same `stats` bag, and the rest of `apply()` could read any of them with no
 *    parameter in sight. The BAG half of that is now closed — `StatsBag`
 *    (stats.ts) types all forty-five field names, so the writes below are
 *    checked — while the closure half is raised, not solved, by this file
 *    existing: the readers are still implicit, they are simply now visible in
 *    one screen instead of scattered across `apply()`.
 *  - The declaration ORDER encoding a real constraint was recorded only in a
 *    comment: the session store's error observer writes `stats.sessionsError`,
 *    so the store must not fire it before the bag exists. That constraint is now
 *    STRUCTURAL — `sessions` is constructed after `createStatsBag`, so no
 *    rearrangement can reopen the window in which the observer runs before its
 *    target exists. See the note at the store.
 *
 * Nothing here is a behaviour change: same code, same order, moved. Whether the
 * observer should keep leaning on that ordering is a separate question, and a
 * separate commit.
 *
 * @param {{ config: HostConfig, log: (message: any) => void }} deps
 * @returns {Runtime} the mounted runtime.
 * @module dsh-connect-atomcode/host/runtime
 */
import {
  healthInfo,
  listModels,
  listSessions,
  readDaemonIdentity,
  runCommand,
  setReasoningEffort,
  spawnDaemon,
} from './daemon.ts';
import { createSessionStore } from './sessions.ts';
import { createProviderStore } from './provider-store.ts';
import { createPanelSettingsStore } from './panel-settings-store.ts';
import { buildQuotaReport } from './quota.ts';
import {
  APPROVAL_MODES_TEXT,
  DAEMON_COMMAND_TIMEOUT_MS,
  DAEMON_PROBE_TIMEOUT_MS,
  DEFAULT_APPROVAL_MODE,
  DEFAULT_ASK_MAX_ROUNDS,
  DEFAULT_REVIEW_BRIEF_MODE,
  REVIEW_BRIEF_MODES,
} from './config.ts';
import type { HostConfig } from './config.ts';
import { describeDaemonDown, createStatsBag } from './stats.ts';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Everything the plugin accumulates while it is mounted, in one object.
 *
 * @param {{ config: HostConfig, log: (message: any) => void, pluginVersion: string }} deps
 *   `pluginVersion` is the hand-edited literal from the assembly point, passed
 *   IN rather than written onto the bag afterwards (which is how it used to
 *   arrive). A bag field that only exists once a caller remembers to graft it on
 *   is the exact "invisible dependency" this file's header complains about, and
 *   the type cannot require what the constructor does not ask for.
 * @returns {Runtime}
 */
export function createRuntime({
  config,
  log,
  pluginVersion,
}: {
  config: HostConfig;
  log: (message: any) => void;
  pluginVersion: string;
}) {
  const {
    port,
    autoStart,
    binary,
    approvalMode,
    approvalModeRejected,
    reviewBriefMode,
    reviewBriefModeRejected,
    defaultWorkingDir,
    defaultProvider,
    askMaxRounds,
    authoredApprovalMode,
    authoredWorkingDir,
    authoredAskMaxRounds,
    authoredReviewBriefMode,
    sessionKeyPrefix,
    statePath,
    quotaRefreshSecs,
    daemonStartAttempts,
    daemonRetrySecs,
    binaryEnv,
  } = config;

  // The panel's brief-mode and working-dir overrides, in the SAME directory so
  // one `state_path` knob governs all three files. Read PER CALL so a pick made
  // in the panel applies to the very next turn — no host restart.
  const panelSettingsStore = createPanelSettingsStore(join(dirname(statePath), 'panel-settings.json'));
  /**
   * The panel settings store is total by design (never throws). A throw means the
   * state dir was swapped mid-run; it degrades to "no panel override" AND names
   * itself in the log (红线 3: silence reads as "the user never chose anything").
   */
  const readPanelSettings = () => {
    try {
      return panelSettingsStore.read();
    } catch (error: any) {
      const reason = String(error && error.message ? error.message : error);
      log(`panel-settings state read failed, ignoring the override: ${reason}`);
      return { briefMode: null, workingDir: null, approvalMode: null, askMaxRounds: null, foreignVersion: false, error: reason };
    }
  };

  /**
   * Resolve the effective review brief mode: panel pick > mount-time patch field.
   * The panel pick is `null` when the user never chose one (or explicitly cleared
   * it), in which case the mount-time value (already defaulted by `readConfig`)
   * applies. This makes the panel a live override without touching the patch.
   */
  const resolveBriefMode = (): { mode: string; source: 'panel' | 'config' } => {
    const settings = readPanelSettings();
    if (settings.briefMode !== null && settings.briefMode !== undefined) {
      return { mode: settings.briefMode, source: 'panel' };
    }
    return { mode: reviewBriefMode, source: 'config' };
  };

  /**
   * Resolve the effective default working directory: panel pick > mount-time
   * patch field. Returns `''` (falsy) when neither names one, so the caller's
   * "no directory → refuse" gate still fires.
   */
  const resolveDefaultWorkingDir = (): string => {
    const settings = readPanelSettings();
    if (typeof settings.workingDir === 'string' && settings.workingDir !== '') {
      return settings.workingDir;
    }
    return defaultWorkingDir || '';
  };

  /**
   * Resolve the effective approval mode: panel pick > mount-time patch field.
   */
  const resolveApprovalMode = (): string => {
    const settings = readPanelSettings();
    if (settings.approvalMode !== null && settings.approvalMode !== undefined) {
      return settings.approvalMode;
    }
    return approvalMode;
  };

  /**
   * Resolve the effective ask max-rounds: panel pick > mount-time patch field.
   */
  const resolveAskMaxRounds = (): number => {
    const settings = readPanelSettings();
    if (settings.askMaxRounds !== null && settings.askMaxRounds !== undefined) {
      return settings.askMaxRounds;
    }
    return askMaxRounds;
  };

  // The panel's model choice, in the SAME directory so one `state_path` knob
  // governs both files. Read PER CALL (like sessions, and like the review probe)
  // so a pick made in the panel applies to the very next turn — no host restart.
  const providerStore = createProviderStore(join(dirname(statePath), 'provider.json'));
  /**
   * The store is total by design (never throws). A throw here means something
   * moved under us (the state dir was swapped mid-run); that must not take a tool
   * call down, so it degrades to "no panel pick" AND names itself in the log —
   * silence would read as "the user never chose anything" (红线 3).
   */
  const readProviderPicks = () => {
    try {
      return providerStore.read();
    } catch (error: any) {
      const reason = String(error && error.message ? error.message : error);
      log(`provider state read failed, ignoring the panel pick: ${reason}`);
      return { ask: null, foreignVersion: false, error: reason };
    }
  };
  /**
   * One place answers "which provider does this call use, and why", for every
   * entry point with the same ladder:
   *
   *   per-call `provider` argument > the panel pick (provider.json) >
   *   the mount-time patch field > AtomCode's own default (send nothing).
   *
   * The panel outranks the patch field deliberately: the patch row is a static
   * default for people who edit files, while the pick is a click the user just
   * made, and a click that silently loses to a line in a config file is the kind
   * of dead control this repo refuses to ship. `source` is reported to the panel
   * so the two can never be confused about which one won.
   *
   * This ladder is the ONLY one: the execute path calls it with the per-call
   * argument, and `refreshPanelState` calls it with none to answer "what will the
   * NEXT call use". They used to be two copies — one four rungs, one three — so
   * the panel could describe a rung (argument) its own snapshot never produced.
   *
   * @param {unknown} argument - the per-call `provider` arg ('' = none).
   * @param {{ask:string|null}} [alreadyRead] - a pick set the caller already
   *   read, so one panel poll does not read the file twice.
   */
  const resolveProvider = (argument: any, alreadyRead?: any) => {
    const arg = typeof argument === 'string' && argument.trim() !== '' ? argument.trim() : '';
    const picks = alreadyRead || readProviderPicks();
    const panel = picks.ask;
    if (arg) return { name: arg, source: 'argument', picks };
    if (panel) return { name: panel, source: 'panel', picks };
    const configured = defaultProvider;
    if (configured) return { name: configured, source: 'config', picks };
    // Nothing picked: send NO provider field and let AtomCode apply its own
    // default profile. This used to be two answers — ask said 'atomcode' and
    // review said 'auto', meaning respectively "the daemon's default" and "the
    // CLI's own auto-selection". The CLI died with the second one (红线 8's two
    // namespaces are now one), so there is one remaining case and it is named
    // for what actually happens.
    return { name: '', source: 'atomcode', picks };
  };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Live status snapshot, mirrored by the plugin detail-page client over the
   * read-only `/api/atomcode-bridge/stats` route. Counters accumulate for the
   * life of the plugin mount; `daemonUp`/`lastHealthAt` are refreshed on each
   * stats poll (5s cache) and on every ask dispatch.
   *
   * The shape lives in `stats.ts` as `StatsBag`, and `createStatsBag` — the one
   * construction site — sits in the SAME file as `buildStatsBody`, its only
   * reader. This used to be a `Record<string, any>` declared right here: eight
   * closures wrote forty-five names into it and the type system had nothing to
   * say about any of those writes, so a renamed field was a silently empty
   * panel card instead of a compile error. See `StatsBag` for the full account;
   * every field this file writes below is now checked against its declaration.
   */
  const stats = createStatsBag({
    pluginVersion,
    port,
    autoStart,
    binaryPath: binary ?? null,
    binaryEnv,
    approvalMode,
    approvalModeRejected,
    reviewBriefMode,
    reviewBriefModeRejected,
    defaultWorkingDir: defaultWorkingDir ?? null,
    defaultProvider: defaultProvider ?? null,
    panelStorePath: providerStore.path(),
    panelSettingsStorePath: panelSettingsStore.path(),
    askRounds: askMaxRounds,
    retrySecs: daemonRetrySecs,
    // Which patch-only knobs the user authored, and our built-in fallbacks. Both
    // are seeded onto the bag (not read from the mount closure) because
    // buildStatsBody is module-level — the panel's "（已改）/（插件默认）" tags must
    // come from the host rather than a client-side guess at what the default is.
    authored: {
      approvalMode: authoredApprovalMode,
      workingDir: authoredWorkingDir,
      askMaxRounds: authoredAskMaxRounds,
      reviewBriefMode: authoredReviewBriefMode,
    },
    defaults: {
      approvalMode: DEFAULT_APPROVAL_MODE,
      askMaxRounds: DEFAULT_ASK_MAX_ROUNDS,
      reviewBriefMode: DEFAULT_REVIEW_BRIEF_MODE,
    },
  });

  // `approval_mode` is a closed enum the daemon 422s on, so `readConfig` refuses
  // an unknown spelling and hands the value it refused up here. Say so ONCE, at
  // mount, in the host log as well as on the panel: silently running a different
  // approval mode than the file asked for is the kind of divergence that only
  // surfaces as "why did this turn behave differently".
  if (approvalModeRejected !== null) {
    log(
      `config.approval_mode「${approvalModeRejected}」不是 AtomCode 接受的取值（${APPROVAL_MODES_TEXT}）；` +
        `已回落到 ${DEFAULT_APPROVAL_MODE}，面板的文件行会标明被拒的值`,
    );
  }

  // Same fail-visible shape for the plugin-side closed enum: a misspelt
  // `review_brief_mode` falls back to the shipped default HERE, and the raw
  // spelling is named in the mount log and on the panel instead of surviving
  // silently as a value nobody chose.
  if (reviewBriefModeRejected !== null) {
    log(
      `config.review_brief_mode「${reviewBriefModeRejected}」不是本插件接受的取值（${REVIEW_BRIEF_MODES.join(' / ')}）；` +
        `已回落到 ${DEFAULT_REVIEW_BRIEF_MODE}，面板的文件行会标明被拒的值`,
    );
  }

  // Session glue degrades rather than throws (sessions.ts), and every
  // degradation is NAMED here instead of swallowed (红线 3): a state file this
  // process cannot write is a fact about the mount, not a reason to hand a
  // finished turn back as an error. `''` means recovered — same channel.
  //
  // DECLARED AFTER `stats` ON PURPOSE. The observer writes `stats.sessionsError`,
  // and `stats` is a `const` binding: a store that fired the observer during
  // construction (an unwritable state path, say) would hit a temporal-dead-zone
  // throw and take the whole mount down. This used to sit above `createStatsBag`
  // with that constraint recorded only in a comment — "nothing between here and
  // the declaration may call the store" — i.e. one rearrangement away from a
  // mount-time crash with no test that could catch it. Ordering it after the bag
  // makes the constraint structural: the window in which the observer could run
  // before its target exists no longer exists, so the comment cannot rot.
  const sessions = createSessionStore(statePath, sessionKeyPrefix, {
    onError: (error) => {
      stats.sessionsError = error;
      if (error) log(`会话续接已降级（本轮回复不受影响）：${error}`);
    },
    // Which daemon is answering now, so a remembered id issued by a daemon
    // that has since exited is judged dead on AGE-INDEPENDENT evidence — a
    // restart or idle exit (~30min) is the dominant way a side conversation
    // dies, and the 24h TTL cannot see it. Read per accessor, not cached: the
    // whole point is noticing a restart that happened minutes ago.
    daemonIdentity: () => readDaemonIdentity(port),
  });

  /** Refresh daemon liveness with a short cache (used by both ask + stats). */
  async function refreshHealth(force = false) {
    if (!force && Date.now() - stats.lastHealthAt < 5000) return stats.daemonUp;
    try {
      const info = await healthInfo(port, AbortSignal.timeout(DAEMON_PROBE_TIMEOUT_MS));
      stats.daemonUp = info.up;
      // Carry the CAUSE alongside the flag. Down is one bit; why it is down is
      // what the error reply and the panel actually need (see describeDaemonDown).
      stats.daemonDownReason = info.reason;
      // Surface which daemon protocol generation we are talking to (the panel
      // shows it; an unknown major is the plugin's earliest drift signal).
      if (info.version && info.version !== stats.daemonVersion) {
        stats.daemonVersion = info.version;
        if (info.version && !/^5\./.test(info.version)) {
          log(`unverified AtomCode daemon version ${info.version} — the bridged protocol was validated against 5.x`);
        }
      }
    } catch {
      // `healthInfo` is contractually non-throwing, so this only fires if that
      // contract breaks. Say so rather than borrowing a cause we did not observe.
      stats.daemonUp = false;
      stats.daemonDownReason = 'unreachable';
    }
    stats.lastHealthAt = Date.now();
    return stats.daemonUp;
  }

  /**
   * Spawn the daemon once and wait for it to answer.
   *
   * Shared and idempotent: the ask path awaits it, while the mount and the panel
   * poll only kick it off. Sharing one promise is what keeps a panel poll from
   * leaving a second daemon spawning behind the first.
   *
   * A FAILED start is not a tombstone: the promise is cleared and `spawnTried`
   * stays set (the panel can say "自动拉起失败"), but after `daemonRetrySecs`
   * the next caller tries again — so installing AtomCode after mount is picked
   * up instead of the auto-start being dead for the mount's lifetime.
   *
   * @returns {Promise<boolean>} whether a daemon answered within the start poll.
   */
  let daemonStartPromise: Promise<boolean> | null = null;
  function ensureDaemonStarted() {
    if (daemonStartPromise !== null) return daemonStartPromise;
    if (!autoStart) return Promise.resolve(false);
    // A previous failure is re-attempted only after the cooldown; otherwise the
    // panel's 5s poll would hammer spawn attempts every poll.
    if (stats.spawnTried && Date.now() - stats.lastSpawnAt < daemonRetrySecs * 1000) {
      return Promise.resolve(false);
    }
    // Mark "starting" up front so the very first panel poll says so instead of
    // reporting a bare "not running" until the health probe resolves.
    stats.daemonStarting = true;
    stats.spawnTried = true;
    stats.spawnAttempts += 1;
    stats.lastSpawnAt = Date.now();
    daemonStartPromise = (async () => {
      // Health first: this is what keeps a host restart — or a second profile —
      // from spawning a duplicate daemon against a port that is already served.
      if (await refreshHealth()) return true;
      await spawnDaemon({
        port,
        ...(binary ? { binary } : {}),
        ...(defaultWorkingDir ? { workingDir: defaultWorkingDir } : {}),
        log,
      });
      let answered = false;
      for (let i = 0; i < daemonStartAttempts; i++) {
        await sleep(1500);
        if (await refreshHealth(true)) {
          answered = true;
          break;
        }
      }
      // A 0s budget (daemonStartAttempts === 0) means "spawn and don't poll",
      // but we must still report whether the daemon actually answered —
      // otherwise the panel shows a phantom "auto-start failed" even though the
      // spawn succeeded and the daemon may already be up. Do exactly one
      // post-spawn probe when there were no poll ticks. (This is why a 0s
      // budget no longer unconditionally fails; see the config comment above.)
      if (!answered && daemonStartAttempts === 0) {
        answered = await refreshHealth(true);
      }
      return answered;
    })()
      .catch(() => false)
      .finally(() => {
        stats.daemonStarting = false;
        if (stats.daemonUp === false) {
          // Do not cache the failure: the next call (after the cooldown) retries.
          daemonStartPromise = null;
          stats.spawnFailures += 1;
        }
      });
    return daemonStartPromise;
  }

  /** Resolves `false` as soon as `signal` aborts, so a caller can stop awaiting. */
  function waitForAbort(signal: AbortSignal) {
    return new Promise((resolve) => {
      if (signal.aborted) resolve(false);
      else signal.addEventListener('abort', () => resolve(false), { once: true });
    });
  }

  /**
   * Daemon liveness, spawning on demand.
   *
   * `auto_start: true` means "the daemon is kept running", not "the first tool
   * call will start it": the mount and the stats route kick the spawn off
   * themselves, so the panel and the quota chip are live without the model
   * having to call a tool first.
   *
   * Do NOT await this from the mount or the stats route — the start poll can run
   * for 30s (20 × 1.5s) and would stall the plugin mount / the 5s panel poll.
   * Use `ensureDaemonStarted()` (fire-and-forget) there instead.
   *
   * @param {AbortSignal} [signal]
   */
  async function ensureDaemon(signal?: AbortSignal) {
    if (signal?.aborted) return false;
    if (await refreshHealth()) return true;
    if (signal?.aborted) return false;
    // The daemon is not answering. A start that is still IN FLIGHT must stay
    // shared: dropping it here would let a second poll spawn a second daemon
    // against the same port — the exact thing the shared promise exists to
    // prevent — and would orphan the first start, whose health poll then keeps
    // running with nobody awaiting it. `stats.daemonStarting` is the honest
    // in-flight signal; it is set synchronously when the start begins and
    // cleared in its `finally`.
    //
    // Only a SETTLED start may be discarded, so that a start which succeeded
    // before the daemon idle-exited (30min) or was killed is re-evaluated
    // instead of being trusted forever.
    if (daemonStartPromise !== null && !stats.daemonStarting) daemonStartPromise = null;
    const started = signal
      ? await Promise.race([ensureDaemonStarted(), waitForAbort(signal)])
      : await ensureDaemonStarted();
    if (signal?.aborted) return false;
    return started === true ? true : refreshHealth(true);
  }

  /**
   * CodingPlan quota, read through the daemon's `status` command.
   *
   * Cached for `quota_refresh_secs` so the panel's 5s poll does not become a 5s
   * daemon call. The daemon requires a `working_dir` for ANY command, but the
   * CodingPlan/usage lines are account-level, so the configured default is used
   * and the home directory is the fallback (any existing directory will do).
   *
   * @returns {Promise<object>} the `quota` branch of the stats snapshot.
   */
  let quotaCache: { at: number; value: any } = { at: 0, value: null };
  async function readQuota() {
    if (quotaRefreshSecs === 0) {
      return {
        available: false,
        reason: '额度显示已关闭（quota_refresh_secs = 0）',
        fetchedAt: Date.now(),
      };
    }
    const now = Date.now();
    if (quotaCache.value !== null && now - quotaCache.at < quotaRefreshSecs * 1000) {
      return quotaCache.value;
    }
    // Type-only: the early return above means only the `buildQuotaReport` shape
    // survives to the `drift` read below, but the JS reuses one binding.
    let value: any;
    if (!(await refreshHealth())) {
      // While a spawn is in flight, say so and do NOT cache the negative answer —
      // otherwise the panel would keep showing "not running" for a whole TTL
      // after the daemon has already come up.
      value = {
        available: false,
        // The quota branch used to say a blanket 'daemon 未运行' for every
        // daemon-down shape — the same collapse the daemon branch just grew out
        // of. Name it from the same function so a "额度不可用" red line tells the
        // user whether the port is empty, held by a stranger, or just silent.
        reason: stats.daemonStarting ? '正在拉起 daemon…' : describeDaemonDown(stats.daemonDownReason),
        fetchedAt: now,
      };
      if (!stats.daemonStarting) quotaCache = { at: now, value };
      return value;
    }
    // A named budget, and it is DELIBERATELY under the panel's client deadline
    // (`POLL_MS - 1000` in src/client/index.ts): the client aborts its fetch at
    // 4s and reports its own timeout string, so a server budget above that
    // guarantees the host's answer is never read AND leaves a handler running
    // for the rest of the 15s default. Answer first and the panel gets the
    // HOST's named reason, which the quota chip and the detail page share.
    const result = await runCommand({
      port,
      command: 'status',
      workingDir: defaultWorkingDir || homedir(),
      timeoutMs: DAEMON_COMMAND_TIMEOUT_MS,
    });
    // `runCommand` maps a transport abort to a DOMException string ("The
    // operation was aborted due to timeout"), which as a panel reason is true
    // but useless. The only transport shape THIS call can hit on a healthy
    // socket is our own budget, so say that instead of quoting Node.
    const outcome =
      result.ok === true || result.kind !== 'transport' || !/abort|timeout/i.test(result.message || '')
        ? result
        : { ...result, kind: 'timeout', message: `daemon 未在 ${DAEMON_COMMAND_TIMEOUT_MS}ms 内应答 /command status（daemon 可能卡住）` };
    value = buildQuotaReport(outcome, Date.now());
    if (value.drift === true) {
      if (!stats.quotaDriftSeen) {
        stats.quotaDriftSeen = true;
        log('the daemon status text no longer matches any known quota shape (AtomCode may have been upgraded) — the panel will show the raw text');
      }
    } else {
      stats.quotaDriftSeen = false;
    }
    // A timeout or transport failure is a fact about ONE ATTEMPT, not about the
    // daemon: the next panel poll (5s later) may well succeed. Caching it for
    // the whole TTL froze the panel on "daemon 卡住" for a full minute over a
    // 3.5s hiccup, and once cached the negative is indistinguishable from a
    // genuinely unusable quota. Only a settled answer is worth keeping — same
    // rule the daemon-down branch above already applies to a spawn in flight.
    const transient = outcome.kind === 'timeout' || outcome.kind === 'transport';
    if (!transient) quotaCache = { at: now, value };
    return value;
  }

  /**
   * Refresh the panel-facing provider state: the stored pick, and what the NEXT
   * call will actually use (and who decided that). One small JSON read — no
   * subprocess.
   *
   * The `[providers.X]` advisory used to be re-read here too, so a direct entry
   * added after mount would show up in a second dropdown. That dropdown is gone
   * along with the CLI that needed those entries, so nothing here reads
   * `~/.atomcode/config.toml` any more.
   */
  function refreshPanelState() {
    const picks = readProviderPicks();
    stats.panelProvider = picks.ask;
    stats.panelStoreError = picks.error;
    stats.panelStoreForeign = picks.foreignVersion;
    // The SAME ladder the execute path runs, asked with no per-call argument:
    // "what will the NEXT call use, and who decided". Duplicating this here is
    // how the two answers drifted apart (the copy had no `argument` rung, and
    // the panel-side wording for a rung its own snapshot never produces).
    const ask = resolveProvider('', picks);
    stats.effectiveAsk = ask.name || null;
    stats.effectiveAskSource = ask.source;
    // Panel settings (briefMode + workingDir + approvalMode + askMaxRounds overrides):
    // read per poll so the detail page shows the current picks and the source label.
    const panelSettings = readPanelSettings();
    stats.panelBriefMode = panelSettings.briefMode;
    stats.panelWorkingDir = panelSettings.workingDir;
    stats.panelApprovalMode = panelSettings.approvalMode;
    stats.panelAskMaxRounds = panelSettings.askMaxRounds;
    stats.panelSettingsError = panelSettings.error;
  }

  /**
   * The daemon's model catalogue, feeding the ask dropdown.
   *
   * `GET /models` is metadata — no tokens, no quota — but the panel polls every
   * 5s, so it is cached for `MODEL_CATALOG_TTL_MS`. A FAILED fetch leaves the
   * catalogue null WITH a named reason, so the dropdown can say why there is
   * nothing to pick instead of rendering an empty select that reads as a broken
   * plugin (红线 3). The negative is deliberately NOT cached for the full TTL:
   * the moment the daemon answers, the next poll should show the list.
   */
  const MODEL_CATALOG_TTL_MS = 30_000;
  async function refreshModelCatalog() {
    const now = Date.now();
    if (stats.modelCatalog !== null && now - stats.modelCatalogAt < MODEL_CATALOG_TTL_MS) return;
    if (!stats.daemonUp) {
      stats.modelCatalog = null;
      stats.modelCatalogAt = 0;
      stats.modelCatalogError = `daemon 未在线（127.0.0.1:${port}：${describeDaemonDown(stats.daemonDownReason)}），列不出档位`;
      return;
    }
    try {
      const list = await listModels(port, AbortSignal.timeout(DAEMON_PROBE_TIMEOUT_MS));
      stats.modelCatalog = Array.isArray(list)
        ? list
            .filter((m) => m && typeof m.provider === 'string' && m.provider !== '')
            // ONLY what the panel consumes: the profile name the dropdown sends,
            // whether AtomCode treats it as the default, the effort levels the
            // model supports, and the daemon's current persistent effort for it.
            .map((m) => ({
              provider: m.provider,
              isDefault: m.is_default === true,
              effortLevels: Array.isArray(m.effort_levels) ? m.effort_levels : undefined,
              currentEffort: typeof m.reasoning_effort === 'string' ? m.reasoning_effort : null,
            }))
        : [];
      stats.modelCatalogAt = Date.now();
      stats.modelCatalogError = '';
    } catch (error: any) {
      const reason = String(error && error.message ? error.message : error);
      stats.modelCatalog = null;
      stats.modelCatalogAt = 0;
      stats.modelCatalogError = reason;
      log(`model catalog fetch failed: ${reason}`);
    }
  }

  return {
    stats,
    sessions,
    providerStore,
    panelSettingsStore,
    readPanelSettings,
    resolveBriefMode,
    resolveDefaultWorkingDir,
    resolveApprovalMode,
    resolveAskMaxRounds,
    resolveProvider,
    refreshHealth,
    ensureDaemonStarted,
    ensureDaemon,
    readQuota,
    refreshPanelState,
    refreshModelCatalog,
    setReasoningEffort: (effort: string) => setReasoningEffort({ port, effort }),
    listSessions: () => listSessions(port),
  };
}

/** The runtime object `createRuntime` returns. */
export type Runtime = ReturnType<typeof createRuntime>;