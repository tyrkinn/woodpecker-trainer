<script lang="ts">
  import { untrack } from 'svelte';
  import {
    compareWithPrevious,
    cyclePuzzleIds,
    failedPuzzleIds,
    nextTargetMs,
    planNextCycle,
    type CycleComparison,
    type Cycle,
  } from '@wp/core';
  import Tally from '../components/Tally.svelte';
  import { db } from '../lib/db.ts';
  import { clock, pct, plural, secs } from '../lib/format.ts';
  import { loadBundle, startErrorsRun, startNextCycle, type SetBundle } from '../lib/repo.ts';
  import { router, type Route } from '../lib/router.svelte.ts';

  let { route }: { route: Route } = $props();
  const r0: Route = untrack(() => route);
  const cycleId = r0.name === 'summary' ? r0.cycleId : '';

  let bundle = $state<SetBundle | null>(null);
  let cycle = $state<Cycle | null>(null);
  let cmp = $state<CycleComparison | null>(null);
  let error = $state('');

  (async () => {
    const c = await db().cycles.get(cycleId);
    if (!c) return (error = 'Цикл не найден');
    const b = await loadBundle(c.setId);
    if (!b) return (error = 'Набор не найден');
    bundle = b;
    cycle = c;
    cmp = compareWithPrevious(c, b.cycles, b.attempts);
  })();

  const ids = $derived(bundle && cycle ? cyclePuzzleIds(bundle.set, cycle) : []);
  const results = $derived.by(() => {
    if (!bundle || !cycle) return [];
    const m = new Map(bundle.attempts.filter((a) => a.cycleId === cycle!.id).map((a) => [a.puzzleId, a.correct]));
    return ids.map((id) => m.get(id));
  });
  const errors = $derived(bundle && cycle ? failedPuzzleIds(ids, bundle.attempts, cycle.id).length : 0);
  const plan = $derived(bundle ? planNextCycle(bundle.cycles, bundle.set.settings) : null);
  const nextTarget = $derived(bundle && cycle?.mode === 'full' ? nextTargetMs(cycle.activeMs, bundle.set.settings.coef) : null);
  const isLatestFull = $derived(
    !!bundle && !!cycle && cycle.mode === 'full' && !bundle.cycles.some((c) => c.mode === 'full' && c.number > cycle!.number),
  );

  async function runErrors() {
    if (!bundle) return;
    const run = await startErrorsRun(bundle.set.id);
    if (run) router.go({ name: 'solve', cycleId: run.id });
  }

  async function nextCycle() {
    if (!bundle) return;
    try {
      const c = await startNextCycle(bundle.set.id);
      router.go({ name: 'solve', cycleId: c.id });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  function onKey(e: KeyboardEvent) {
    if ((e.key === 'Enter' || e.key === ' ') && plan?.kind === 'start' && e.target === document.body) {
      e.preventDefault();
      nextCycle();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<main class="screen summary">
  <header class="topbar">
    <a class="btn quiet" href="#/">← Главная</a>
    {#if bundle}<a class="btn quiet" href="#/stats/{encodeURIComponent(bundle.set.id)}">Статистика</a>{/if}
  </header>

  {#if error}
    <p>{error}</p>
  {:else if cycle && cmp && bundle}
    {@const s = cmp.current}
    <h1>{cycle.mode === 'errors' ? `Ошибки цикла ${cycle.number}` : `Цикл ${cycle.number}`}{cycle.finishedAt === null ? ' — в процессе' : ' пройден'}</h1>
    <p class="muted">{bundle.set.name}</p>

    <div class="big num" class:hit={s.hitTarget === true} class:miss={s.hitTarget === false}>{clock(s.activeMs)}</div>
    {#if s.targetMs !== null}
      <p class="target num">
        цель {clock(s.targetMs)} — {s.hitTarget ? 'уложился' : `не уложился на ${clock(s.activeMs - s.targetMs)}`}
      </p>
    {/if}

    <Tally {results} total={ids.length} height={18} />

    <dl class="grid">
      <div>
        <dt>Точность</dt>
        <dd class="num">{pct(s.accuracy)}</dd>
        <span class="muted num">{s.correct} из {s.total}</span>
      </div>
      <div>
        <dt>Медиана на задачу</dt>
        <dd class="num">{secs(s.medianMs)}</dd>
      </div>
      {#if cmp.previous}
        <div>
          <dt>Против цикла {cmp.previous.number}</dt>
          <dd class="num">
            {cmp.timeRatio !== null ? (cmp.timeRatio <= 1 ? `−${pct(1 - cmp.timeRatio)}` : `+${pct(cmp.timeRatio - 1)}`) : '—'}
          </dd>
          <span class="muted num">время {clock(cmp.previous.activeMs)} → {clock(s.activeMs)}</span>
        </div>
        <div>
          <dt>Точность к прошлому</dt>
          <dd class="num">{(cmp.accuracyDelta ?? 0) >= 0 ? '+' : '−'}{Math.abs(Math.round((cmp.accuracyDelta ?? 0) * 100))} п.п.</dd>
          <span class="muted num">{pct(cmp.previous.accuracy)} → {pct(s.accuracy)}</span>
        </div>
      {/if}
    </dl>

    {#if isLatestFull && cycle.finishedAt !== null}
      <section class="next">
        {#if plan?.kind === 'start' && nextTarget !== null}
          <p>
            Цель цикла {plan.number}: <b class="num">{clock(nextTarget)}</b>
            <span class="muted">(× {bundle.set.settings.coef.toFixed(2)})</span>
          </p>
        {:else if plan?.kind === 'done'}
          <p>Это был последний цикл набора. Пора собирать новый набор на 100–200 пунктов сложнее.</p>
        {/if}
        <div class="row">
          {#if errors > 0 && plan?.kind !== 'busy'}
            <button class="btn" onclick={runErrors}>Прогнать только ошибки · {errors}</button>
          {/if}
          {#if plan?.kind === 'start'}
            <button class="btn primary" onclick={nextCycle}>Начать цикл {plan.number}</button>
          {/if}
        </div>
        {#if plan?.kind === 'busy' && plan.cycle.mode === 'errors'}
          <a class="btn primary" href="#/solve/{encodeURIComponent(plan.cycle.id)}">Продолжить работу над ошибками</a>
        {/if}
      </section>
    {:else if cycle.mode === 'errors' && cycle.finishedAt !== null}
      <section class="next">
        <p class="muted">
          Прогон ошибок не считается циклом и не меняет цель. Осталось {errors} {plural(errors, 'нерешённая', 'нерешённые', 'нерешённых')}.
        </p>
        <div class="row">
          {#if plan?.kind === 'start'}
            <button class="btn primary" onclick={nextCycle}>Начать цикл {plan.number}</button>
          {/if}
          <a class="btn" href="#/">На главную</a>
        </div>
      </section>
    {/if}
  {/if}
</main>

<style>
  .summary {
    max-width: 640px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  h1 {
    font-size: 1.5rem;
    margin-top: 8px;
  }
  .muted {
    margin: 0;
  }
  .big {
    font-size: clamp(3.4rem, 18vw, 5.6rem);
    font-weight: 650;
    line-height: 1;
    letter-spacing: -0.02em;
    font-stretch: condensed;
  }
  .big.hit {
    color: var(--ok);
  }
  .target {
    margin: 0;
    color: var(--muted);
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px 12px;
    margin: 8px 0;
  }
  .grid div {
    display: flex;
    flex-direction: column;
  }
  dt {
    font-size: 0.85rem;
    color: var(--muted);
  }
  dd {
    margin: 0;
    font-size: 1.6rem;
    font-weight: 620;
  }
  .grid span {
    font-size: 0.85rem;
  }
  .next {
    border-top: 1px solid var(--line);
    padding-top: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .next p {
    margin: 0;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
</style>
