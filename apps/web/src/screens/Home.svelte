<script lang="ts">
  import {
    activeCycle,
    attemptsToday,
    cyclePuzzleIds,
    daysSince,
    lastFinishedFull,
    planNextCycle,
    summarizeCycle,
    type StoredSet,
  } from '@wp/core';
  import Tally from '../components/Tally.svelte';
  import { BUILTIN_SETS, DEMO_SET, type BuiltinSet } from '../lib/demo.ts';
  import { downloadJson, pickJson } from '../lib/files.ts';
  import { clock, daysAgo, pct, plural } from '../lib/format.ts';
  import {
    abandonErrorsRun,
    currentSetId,
    deleteSet,
    exportAll,
    importAll,
    importSet,
    listSets,
    loadBundle,
    rememberCurrentSet,
    startNextCycle,
    updateSettings,
    type SetBundle,
  } from '../lib/repo.ts';
  import { router } from '../lib/router.svelte.ts';

  let sets = $state<StoredSet[]>([]);
  let bundle = $state<SetBundle | null>(null);
  let loaded = $state(false);
  let busy = $state(false);
  let toast = $state<string | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function say(msg: string) {
    toast = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), 4000);
  }

  async function refresh() {
    sets = await listSets();
    const id = await currentSetId();
    bundle = id ? await loadBundle(id) : null;
    loaded = true;
  }
  refresh();

  const now = Date.now();
  const active = $derived(bundle ? activeCycle(bundle.cycles) : undefined);
  const plan = $derived(bundle ? planNextCycle(bundle.cycles, bundle.set.settings) : null);
  const lastFull = $derived(bundle ? lastFinishedFull(bundle.cycles) : undefined);
  const lastSummary = $derived(bundle && lastFull ? summarizeCycle(lastFull, bundle.attempts) : null);
  const today = $derived(bundle ? attemptsToday(bundle.attempts, now) : 0);
  const lastActivity = $derived.by(() => {
    if (!bundle) return null;
    const ts = Math.max(0, ...bundle.attempts.map((a) => a.at));
    return ts > 0 ? daysSince(ts, now) : null;
  });

  const activeIds = $derived(bundle && active ? cyclePuzzleIds(bundle.set, active) : []);
  const activeResults = $derived.by(() => {
    if (!bundle || !active) return [];
    const byPuzzle = new Map(bundle.attempts.filter((a) => a.cycleId === active.id).map((a) => [a.puzzleId, a.correct]));
    return activeIds.map((id) => byPuzzle.get(id));
  });

  const fullCount = $derived(bundle ? bundle.cycles.filter((c) => c.mode === 'full').length : 0);

  async function go() {
    if (!bundle || busy) return;
    if (active) return router.go({ name: 'solve', cycleId: active.id });
    if (plan?.kind !== 'start') return;
    busy = true;
    try {
      const c = await startNextCycle(bundle.set.id);
      router.go({ name: 'solve', cycleId: c.id });
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    } finally {
      busy = false;
    }
  }

  async function doImport() {
    try {
      const raw = await pickJson();
      if (raw === null) return;
      const rep = await importSet(raw);
      const extra = rep.skipped.length ? `, пропущено ${rep.skipped.length}` : '';
      say(`${rep.replaced ? 'Обновлён' : 'Импортирован'} «${rep.set.name}»: ${rep.added} задач${extra}`);
      await refresh();
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    }
  }

  async function loadDemo() {
    await importSet(DEMO_SET);
    await refresh();
  }

  let loadingBase = $state<string | null>(null);
  async function loadBase(b: BuiltinSet) {
    if (loadingBase) return;
    loadingBase = b.id;
    try {
      const res = await fetch(b.url);
      if (!res.ok) throw new Error(`Набор не загрузился: HTTP ${res.status}`);
      const rep = await importSet(await res.json());
      say(`Загружен «${rep.set.name}»`);
      await refresh();
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    } finally {
      loadingBase = null;
    }
  }

  async function choose(id: string) {
    rememberCurrentSet(id);
    await refresh();
  }

  /** Подтверждение вторым тапом: первый тап «взводит» кнопку на 4 секунды. */
  let armed = $state<string | null>(null);
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  function arm(key: string): boolean {
    if (armed === key) {
      armed = null;
      clearTimeout(armTimer);
      return true;
    }
    armed = key;
    clearTimeout(armTimer);
    armTimer = setTimeout(() => (armed = null), 4000);
    return false;
  }

  async function remove(s: StoredSet) {
    if (!arm(`del:${s.id}`)) return;
    await deleteSet(s.id);
    await refresh();
  }

  async function backup() {
    const data = await exportAll();
    downloadJson(`woodpecker-backup-${new Date().toISOString().slice(0, 10)}.json`, data);
  }

  let pendingRestore = $state<unknown | null>(null);

  async function restore() {
    try {
      const raw = await pickJson();
      if (raw === null) return;
      if (sets.length === 0) return applyRestore(raw);
      pendingRestore = raw;
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    }
  }

  async function applyRestore(raw: unknown) {
    pendingRestore = null;
    try {
      const r = await importAll(raw);
      say(`Восстановлено: ${r.sets} ${plural(r.sets, 'набор', 'набора', 'наборов')}, ${r.attempts} попыток`);
      await refresh();
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    }
  }

  async function setCoef(v: number) {
    if (!bundle) return;
    await updateSettings(bundle.set.id, { coef: v });
    await refresh();
  }

  async function setMax(v: number) {
    if (!bundle) return;
    await updateSettings(bundle.set.id, { maxCycles: v });
    await refresh();
  }

  async function dropErrors() {
    if (!active) return;
    await abandonErrorsRun(active.id);
    await refresh();
  }

  function onKey(e: KeyboardEvent) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === document.body) {
      e.preventDefault();
      go();
    }
  }

  const nextRange = $derived.by(() => {
    const p = bundle?.set.params as { minRating?: number; maxRating?: number } | undefined;
    const min = (p?.minRating ?? 1300) + 150;
    const max = (p?.maxRating ?? 1700) + 150;
    return { min, max };
  });
</script>

<svelte:window onkeydown={onKey} />

<main class="screen home">
  <header class="topbar">
    <h1 class="brand">Woodpecker</h1>
    {#if bundle}
      <a class="btn quiet" href="#/stats/{encodeURIComponent(bundle.set.id)}">Статистика</a>
    {/if}
  </header>

  {#if !loaded}
    <div class="hero skeleton" aria-busy="true"></div>
  {:else if !bundle}
    <section class="empty">
      <h2>Один набор задач, каждый круг быстрее</h2>
      <p>
        Возьми готовый набор из 400 задач Lichess, они идут от простых к сложным. Набор под другой рейтинг или темы
        собирается командой ниже и импортируется JSON-файлом.
      </p>
      <div class="builtins">
        {#each BUILTIN_SETS as b, i (b.id)}
          <button class="btn builtin" class:primary={i === 0} onclick={() => loadBase(b)} disabled={loadingBase !== null}>
            <span>{loadingBase === b.id ? 'Загружаю…' : b.label}</span>
            <small>{b.hint}</small>
          </button>
        {/each}
      </div>
      <div class="row">
        <button class="btn" onclick={doImport}>Импортировать набор</button>
        <button class="btn quiet" onclick={loadDemo}>Пробный на 8 задач</button>
      </div>
      <pre class="cmd">pnpm gen --seed 42 --min-rating 1500 --max-rating 1900 --count 400</pre>
      <button class="btn quiet" onclick={restore}>Восстановить из бэкапа</button>
    </section>
  {:else}
    <!-- Главное действие: один тап до задачи -->
    {#if active}
      <button class="hero" onclick={go} disabled={busy}>
        <span class="hero-kicker">
          {active.mode === 'errors' ? `Работа над ошибками цикла ${active.number}` : `Цикл ${active.number}`} · {bundle.set.name}
        </span>
        <span class="hero-main">
          <span class="hero-verb">Продолжить</span>
          <span class="hero-count num">{Math.min(active.cursor + 1, activeIds.length)}<small>/{activeIds.length}</small></span>
        </span>
        <Tally results={activeResults} total={activeIds.length} cursor={active.cursor} />
        <span class="hero-time num">
          {clock(active.activeMs)}
          {#if active.targetMs !== null}
            <span class:over={active.activeMs > active.targetMs}> из {clock(active.targetMs)}</span>
          {:else}
            <span class="muted"> · {active.mode === 'errors' ? 'без цели' : 'на точность, без цели'}</span>
          {/if}
        </span>
      </button>
      {#if active.mode === 'errors'}
        <button class="btn quiet small" onclick={dropErrors}>Закончить работу над ошибками</button>
      {/if}
    {:else if plan?.kind === 'start'}
      <button class="hero" onclick={go} disabled={busy}>
        <span class="hero-kicker">{bundle.set.name}</span>
        <span class="hero-main">
          <span class="hero-verb">Начать цикл {plan.number}</span>
          <span class="hero-count num">{bundle.set.puzzleIds.length}<small> задач</small></span>
        </span>
        <span class="hero-time num">
          {#if plan.targetMs !== null}
            цель {clock(plan.targetMs)}
          {:else}
            на точность, без цели по времени
          {/if}
        </span>
      </button>
    {:else if plan?.kind === 'done'}
      <section class="done">
        <h2>Все {plan.completed} циклов пройдены</h2>
        <p>Набор отработан. Следующий шаг — новый набор на 100–200 пунктов сложнее:</p>
        <pre class="cmd">pnpm gen --seed {Date.now() % 1000} --min-rating {nextRange.min} --max-rating {nextRange.max} --out sets/base-{nextRange.min}.json</pre>
        <button class="btn primary" onclick={doImport}>Импортировать новый набор</button>
      </section>
    {/if}

    <section class="facts">
      {#if lastSummary}
        <a class="fact" href="#/summary/{encodeURIComponent(lastSummary.cycleId)}">
          <span class="muted">Цикл {lastSummary.number}</span>
          <strong class="num">{clock(lastSummary.activeMs)}</strong>
          <span class="num">{pct(lastSummary.accuracy)} точность</span>
        </a>
      {/if}
      <div class="fact">
        <span class="muted">Сегодня</span>
        <strong class="num">{today}</strong>
        <span>{plural(today, 'задача', 'задачи', 'задач')}</span>
      </div>
      {#if lastActivity !== null}
        <div class="fact">
          <span class="muted">Последняя тренировка</span>
          <strong>{daysAgo(lastActivity)}</strong>
          <span class="num">{fullCount} {plural(fullCount, 'цикл', 'цикла', 'циклов')} начато</span>
        </div>
      {/if}
    </section>

    <details class="panel">
      <summary>Настройки набора</summary>
      <label class="field">
        <span>Цель следующего цикла: время × <b class="num">{bundle.set.settings.coef.toFixed(2)}</b></span>
        <input
          type="range"
          min="0.3"
          max="0.9"
          step="0.05"
          value={bundle.set.settings.coef}
          onchange={(e) => setCoef(Number(e.currentTarget.value))}
        />
      </label>
      <label class="field">
        <span>Максимум циклов: <b class="num">{bundle.set.settings.maxCycles}</b></span>
        <input
          type="range"
          min="3"
          max="10"
          step="1"
          value={bundle.set.settings.maxCycles}
          onchange={(e) => setMax(Number(e.currentTarget.value))}
        />
      </label>
    </details>

    <section class="sets">
      <h2>Наборы</h2>
      <ul>
        {#each sets as s (s.id)}
          <li class:current={s.id === bundle.set.id}>
            <button class="set-pick" onclick={() => choose(s.id)} aria-pressed={s.id === bundle.set.id}>
              <span>{s.name}</span>
              <span class="muted num">{s.puzzleIds.length} задач</span>
            </button>
            <button class="btn quiet" class:danger={armed === `del:${s.id}`} aria-label="Удалить {s.name}" onclick={() => remove(s)}>
              {armed === `del:${s.id}` ? 'Точно удалить?' : 'Удалить'}
            </button>
          </li>
        {/each}
      </ul>
      <div class="row">
        <button class="btn" onclick={doImport}>Импортировать набор</button>
        {#each BUILTIN_SETS.filter((b) => !sets.some((s) => s.id === b.id)) as b (b.id)}
          <button class="btn" onclick={() => loadBase(b)} disabled={loadingBase !== null}>
            {loadingBase === b.id ? 'Загружаю…' : b.label}
          </button>
        {/each}
        {#if !sets.some((s) => s.id === DEMO_SET.id)}
          <button class="btn quiet" onclick={loadDemo}>Пробный набор</button>
        {/if}
      </div>
    </section>

    <section class="backup">
      <h2>Бэкап</h2>
      <p class="muted">Вся история хранится только на этом устройстве. Файл бэкапа переносит её на другое.</p>
      <div class="row">
        <button class="btn" onclick={backup}>Сохранить бэкап</button>
        <button class="btn quiet" onclick={restore}>Восстановить</button>
      </div>
      {#if pendingRestore !== null}
        <div class="confirm" role="alert">
          <p>Восстановление заменит все наборы и историю на этом устройстве.</p>
          <div class="row">
            <button class="btn primary" onclick={() => applyRestore(pendingRestore)}>Заменить данные</button>
            <button class="btn quiet" onclick={() => (pendingRestore = null)}>Отмена</button>
          </div>
        </div>
      {/if}
    </section>
  {/if}

  {#if toast}
    <div class="toast" role="status">{toast}</div>
  {/if}
</main>

<style>
  .brand {
    font-size: 1.15rem;
    letter-spacing: -0.01em;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .brand::before {
    content: '';
    width: 10px;
    height: 22px;
    border-radius: 5px 5px 2px 2px;
    background: var(--crest);
  }

  .hero {
    display: flex;
    flex-direction: column;
    gap: 14px;
    width: 100%;
    text-align: left;
    padding: 22px 20px 20px;
    margin: 8px 0 6px;
    border: 0;
    border-radius: var(--radius-lg);
    background: var(--pine);
    color: var(--pine-ink);
    cursor: pointer;
    touch-action: manipulation;
    --sunk: color-mix(in srgb, var(--pine-ink) 22%, transparent);
    --ink: var(--pine-ink);
  }
  .hero:active {
    filter: brightness(1.08);
  }
  .hero.skeleton {
    height: 196px;
    opacity: 0.35;
  }
  .hero-kicker {
    font-size: 0.9rem;
    opacity: 0.8;
  }
  .hero-main {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }
  .hero-verb {
    font-size: clamp(1.7rem, 7vw, 2.4rem);
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.05;
  }
  .hero-count {
    font-size: clamp(2.2rem, 10vw, 3.4rem);
    font-weight: 600;
    line-height: 1;
    font-stretch: condensed;
  }
  .hero-count small {
    font-size: 0.45em;
    opacity: 0.7;
  }
  .hero-time {
    font-size: 1.05rem;
  }
  .hero-time .over {
    color: color-mix(in srgb, var(--crest) 55%, var(--pine-ink));
  }
  .hero .muted {
    color: inherit;
    opacity: 0.75;
  }
  .small {
    min-height: 36px;
    font-size: 0.9rem;
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 1px;
    margin: 18px 0;
    background: var(--line);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .fact {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 12px 14px;
    background: var(--surface);
    color: var(--ink);
    text-decoration: none;
    font-size: 0.9rem;
  }
  .fact strong {
    font-size: 1.35rem;
    font-weight: 620;
  }
  a.fact:active {
    background: var(--sunk);
  }

  .panel {
    border-top: 1px solid var(--line);
    padding: 6px 0;
  }
  .panel summary {
    min-height: 44px;
    display: flex;
    align-items: center;
    cursor: pointer;
    font-weight: 560;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 8px 0 14px;
  }
  .field input {
    width: 100%;
    min-height: 32px;
    accent-color: var(--pine);
  }

  section h2 {
    font-size: 1rem;
    margin: 22px 0 8px;
  }
  .sets ul {
    list-style: none;
    margin: 0 0 10px;
    padding: 0;
    border-top: 1px solid var(--line);
  }
  .sets li {
    display: flex;
    align-items: center;
    border-bottom: 1px solid var(--line);
  }
  .set-pick {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    min-height: 56px;
    padding: 8px 0 8px 12px;
    border: 0;
    border-left: 3px solid transparent;
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .sets li.current .set-pick {
    border-left-color: var(--crest);
    font-weight: 600;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .empty,
  .done {
    padding: 24px 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
    align-items: flex-start;
  }
  .empty h2,
  .done h2 {
    font-size: clamp(1.5rem, 6vw, 2rem);
    letter-spacing: -0.02em;
    margin: 0;
    max-width: 18ch;
  }
  .empty p,
  .done p {
    margin: 0;
    max-width: 60ch;
  }
  .cmd {
    width: 100%;
    margin: 0;
    padding: 12px;
    border-radius: var(--radius-sm);
    background: var(--sunk);
    font-size: 0.82rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .builtins {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 8px;
    width: 100%;
  }
  .builtin {
    flex-direction: column;
    align-items: flex-start;
    min-height: 64px;
    text-align: left;
  }
  .builtin small {
    font-weight: 400;
    opacity: 0.8;
  }
  .danger {
    color: var(--crest);
    font-weight: 650;
  }
  .confirm {
    margin-top: 12px;
    padding: 12px 14px;
    border: 1px solid var(--crest);
    border-radius: var(--radius-sm);
    background: var(--surface);
  }
  .confirm p {
    margin: 0 0 10px;
  }
  .backup p {
    margin: 0 0 10px;
    font-size: 0.9rem;
  }

  @media (min-width: 760px) {
    .home {
      max-width: 640px;
      margin: 0 auto;
    }
  }
</style>
