/**
 * The model-dropdown model, one entry per namespace.
 *
 * Moved verbatim from the pre-TypeScript `client.js`; the only edits are the de-indent,
 * the `export` keyword, and parameter type annotations.
 *
 * `providerRows` owns the WORDING and the two slots; `providerSelectModel` owns what is
 * selectable right now. They are separate because the two namespaces are separate (红线 8).
 */

import type {
  ConfigBranch,
  ProviderBranch,
  ProviderRow,
  ProviderSelectModel,
  ProviderSlotName,
} from './types.ts';

/**
 * The model rows, derived from ONE stats snapshot.
 *
 * Two entries, always both, never collapsed into one: they are TWO DIFFERENT
 * namespaces (ask = daemon model profile, review = CLI direct entry), and one
 * merged row would read as "same knob, two names" — the exact confusion
 * 红线 8 exists to prevent. The renderer may lay them out side by side
 * (one line, two cells); it may NOT merge them into one control.
 *
 * The fallbacks name the BEHAVIOR, not the absence: "未插手" tells the user
 * AtomCode's own default is authoritative, which is what they would otherwise
 * have to infer from an empty field. They stay short on purpose — the long
 * provenance ("ask takes daemon /models, review takes config.toml entries")
 * lives in the hover `title`, because it is an explanation of the control,
 * not a state of the system, and printing it in the card body was noise.
 *
 * @param {object|undefined} cfg  the snapshot's config branch (may predate
 *   these fields entirely — an older host build, or the desktop install copy)
 * @returns {Array<{slotName:string,label:string,value:string,fallback:string,pinned:boolean,title:string}>}
 */
export function providerRows(cfg: ConfigBranch | null | undefined): ProviderRow[] {
  const src: ConfigBranch = cfg && typeof cfg === 'object' ? cfg : {};
  const name = (v: unknown): string => (typeof v === 'string' && v.trim() !== '' ? v.trim() : '');
  const ask = name(src.defaultProvider);
  const review = name(src.reviewDefaultProvider);
  return [
    {
      slotName: 'ask',
      // The labels carry the PATH, not just the field: the two namespaces are
      // the single most confusing thing on this card. The user saw
      // `atomcode-local` and read it as "a config FILE" — because nothing on
      // screen said which route it belongs to. Each label now names its tool.
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
 *  - the selected value is the PANEL pick, NOT the effective one: the control
 *    shows what the user chose, while `effective`/`source` are compared against
 *    it to answer "did my click actually take?" (`note`, below);
 *  - a panel pick missing from the catalogue is APPENDED, never dropped — a
 *    daemon that restarted with a different config would otherwise render a
 *    real setting as "nothing chosen", which is a lie by omission;
 *  - an unusable slot renders a REASON, never a bare empty dropdown
 *    (红线 3: nothing here may fail silently).
 *
 * `note` exists only when the effective value DIFFERS from what this control
 * shows — a panel pick that lost to a per-call argument or to the config field.
 * When they agree there is nothing to say: every value on this panel came from
 * the panel, so narrating that fact was pure decoration (and it printed next to
 * a dropdown the user had just used themselves).
 *
 * @param {object|undefined} provider  the snapshot's `provider` branch
 * @param {'ask'|'review'} slotName    which namespace (they are NOT one knob)
 * @param {string} fallbackLabel       what "no pick" means for this slot
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
    };
  }
  const name = (v: unknown): string => (typeof v === 'string' && v.trim() !== '' ? v.trim() : '');
  const panel = name(src.panel);
  // The two slots do NOT agree on the catalogue element shape, because the two
  // endpoints do not: /models answers with OBJECTS ({provider, model, isDefault,
  // effortLevels}) while the review CLI's direct entries are plain STRINGS. Both
  // go through here, so both are flattened to the option VALUE — and a shape the
  // host did not send is null (unavailable), never [] (empty), which would read
  // as "your machine has no models".
  const optionValue = (v: string | { provider?: string }): string => {
    if (typeof v === 'string') return name(v);
    if (v && typeof v === 'object') {
      // `provider` is the model PROFILE (what /chat's `provider` takes);
      // `model` is the bare id and is NOT a valid value on either path (红线 8).
      return name(v.provider);
    }
    return '';
  };
  const catalog = Array.isArray(src.catalog) ? src.catalog.map(optionValue).filter(Boolean) : null;
  // A pinned name the catalogue no longer offers stays visible.
  const list = catalog === null ? [] : catalog.indexOf(panel) === -1 && panel ? [panel].concat(catalog) : catalog;
  const options = [{ value: '', label: fallbackLabel }].concat(list.map((n) => ({ value: n, label: n })));
  const effective = name(src.effective);
  const source = name(src.source);
  // `src` being an object is what proves `provider` is one too, but TypeScript cannot
  // see that link through the index access above; bind it once so the reads below are
  // checked against a non-null type instead of being wrapped in assertions.
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
    // Per slot, because the two empty states have different CAUSES and the
    // same sentence for both read as a bug (it pointed ask at the review
    // source). Each names only its own endpoint.
    reason =
      slotName === 'ask'
        ? 'daemon 未列出档位'
        : 'config.toml 里没有直连条目';
  }
  return {
    value: panel,
    options,
    disabled,
    reason,
    effective,
    source,
    note: !disabled && effective !== '' && effective !== panel ? effective : '',
  };
}
