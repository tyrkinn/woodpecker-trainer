<script lang="ts">
  import { untrack } from 'svelte';
  import {
    chronicErrors,
    slowestPuzzles,
    summarizeCycle,
    themeLabel,
    themeStats,
    weakestMotifs,
    isMotif,
    type Cycle,
  } from '@wp/core';
  import CycleChart from '../components/CycleChart.svelte';
  import { pct, secs } from '../lib/format.ts';
  import { loadBundle, type SetBundle } from '../lib/repo.ts';
  import { href, type Route } from '../lib/router.svelte.ts';

  let { route }: { route: Route } = $props();
  const r0: Route = untrack(() => route);
  const setId = r0.name === 'stats' ? r0.setId : '';

  let bundle = $state<SetBundle | null>(null);
  let loaded = $state(false);
  let showMeta = $state(false);

  loadBundle(setId).then((b) => {
    bundle = b;
    loaded = true;
  });

  const full = $derived<Cycle[]>(bundle ? bundle.cycles.filter((c) => c.mode === 'full').sort((a, b) => a.number - b.number) : []);
  const summaries = $derived(bundle ? full.map((c) => summarizeCycle(c, bundle!.attempts)).filter((s) => s.total > 0) : []);
  const rows = $derived(
    bundle ? themeStats(bundle.puzzles, bundle.set.puzzleIds, full, bundle.attempts, { includeMeta: showMeta }) : [],
  );
  const weakest = $derived(weakestMotifs(rows.filter((r) => isMotif(r.theme))));
  const slow = $derived(bundle ? slowestPuzzles(full, bundle.attempts, 20) : []);
  const chronic = $derived(bundle ? chronicErrors(full, bundle.attempts) : []);
  const cycleNumbers = $derived(full.filter((c) => summaries.some((s) => s.cycleId === c.id)).map((c) => c.number));

  const puzzleLabel = (id: string) => {
    const p = bundle?.puzzles.get(id);
    if (!p) return id;
    const m = p.themes.filter(isMotif).slice(0, 2).map(themeLabel).join(', ');
    return `${p.rating} · ${m || 'без мотива'}`;
  };
  const practice = (puzzleId: string) => href({ name: 'practice', setId, puzzleId });
  const tone = (a: number) => (a < 0.7 ? 'low' : a < 0.85 ? 'mid' : 'high');
</script>

<main class="screen stats">
  <header class="topbar">
    <a class="btn quiet" href="#/">← Главная</a>
  </header>

  {#if !loaded}
    <p class="muted">Загрузка…</p>
  {:else if !bundle}
    <p>Набор не найден.</p>
  {:else if summaries.length === 0}
    <h1>Статистика</h1>
    <p class="muted">Реши хотя бы одну задачу в цикле — здесь появятся темы, время и ошибки.</p>
  {:else}
    <h1>Статистика</h1>
    <p class="muted">{bundle.set.name}</p>

    {#if weakest.length}
      <section>
        <h2>Слабые мотивы</h2>
        <ol class="weak">
          {#each weakest as w (w.theme)}
            <li>
              <span class="w-name">{themeLabel(w.theme)}</span>
              <span class="num w-acc {tone(w.latestAccuracy)}">{pct(w.latestAccuracy)}</span>
              <span class="muted num">{w.attempts} попыток</span>
            </li>
          {/each}
        </ol>
      </section>
    {/if}

    <section>
      <h2>По циклам</h2>
      <CycleChart cycles={summaries} />
    </section>

    <section>
      <div class="h-row">
        <h2>По темам</h2>
        <label class="toggle"><input type="checkbox" bind:checked={showMeta} /> фаза и длина</label>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Тема</th>
              <th scope="col" class="r">Задач</th>
              {#each cycleNumbers as n (n)}
                <th scope="col" class="r">Ц{n}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each rows as r (r.theme)}
              <tr>
                <th scope="row">{themeLabel(r.theme)}</th>
                <td class="r num">{r.puzzles}</td>
                {#each cycleNumbers as n (n)}
                  {@const cell = r.cycles.find((c) => c.cycleNumber === n)}
                  <td class="r num">
                    {#if cell}
                      <span class={tone(cell.accuracy)}>{pct(cell.accuracy)}</span>
                      <small>{secs(cell.medianMs)}</small>
                    {:else}
                      <span class="muted">—</span>
                    {/if}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="hint muted">Точность и медианное время. Темы с худшей точностью в последнем цикле — наверху.</p>
    </section>

    <section>
      <h2>Хронические ошибки</h2>
      {#if chronic.length === 0}
        <p class="muted">Нет задач, проваленных в двух и более циклах.</p>
      {:else}
        <ul class="plist">
          {#each chronic as c (c.puzzleId)}
            <li>
              <a href={practice(c.puzzleId)}>
                <span>{puzzleLabel(c.puzzleId)}</span>
                <span class="num bad">провалена в {c.failedCycles} циклах</span>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section>
      <h2>Самые медленные</h2>
      <ul class="plist">
        {#each slow as s (s.puzzleId)}
          <li>
            <a href={practice(s.puzzleId)}>
              <span>{puzzleLabel(s.puzzleId)}</span>
              <span class="num">{secs(s.medianMs)}{s.fails ? ` · ${s.fails}✗` : ''}</span>
            </a>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</main>

<style>
  .stats {
    max-width: 760px;
    margin: 0 auto;
  }
  h1 {
    font-size: 1.5rem;
    margin-top: 8px;
  }
  h1 + .muted {
    margin: 4px 0 0;
  }
  section {
    margin-top: 26px;
  }
  h2 {
    font-size: 1.05rem;
    margin-bottom: 10px;
  }
  .h-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }
  .toggle {
    font-size: 0.88rem;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 44px;
  }
  .weak {
    list-style: none;
    padding: 0;
    margin: 0;
    counter-reset: weak;
    border-top: 1px solid var(--line);
  }
  .weak li {
    display: grid;
    grid-template-columns: 1fr auto;
    grid-template-rows: auto auto;
    padding: 10px 0;
    border-bottom: 1px solid var(--line);
    counter-increment: weak;
  }
  .w-name {
    font-weight: 600;
    font-size: 1.1rem;
  }
  .w-name::before {
    content: counter(weak) '. ';
    color: var(--muted);
    font-weight: 400;
  }
  .w-acc {
    grid-row: span 2;
    font-size: 1.6rem;
    font-weight: 650;
    align-self: center;
  }
  .table-wrap {
    overflow-x: auto;
    margin: 0 calc(-1 * var(--gutter));
    padding: 0 var(--gutter);
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.9rem;
  }
  th,
  td {
    padding: 8px 6px;
    border-bottom: 1px solid var(--line);
    text-align: left;
    white-space: nowrap;
    vertical-align: top;
  }
  thead th {
    color: var(--muted);
    font-weight: 560;
  }
  tbody th {
    font-weight: 560;
    white-space: normal;
    min-width: 8em;
  }
  .r {
    text-align: right;
  }
  td small {
    display: block;
    color: var(--muted);
    font-size: 0.78rem;
  }
  .low,
  .bad {
    color: var(--crest);
  }
  .mid {
    color: color-mix(in srgb, var(--crest) 45%, var(--ink));
  }
  .high {
    color: var(--ok);
  }
  .hint {
    font-size: 0.82rem;
    margin: 8px 0 0;
  }
  .plist {
    list-style: none;
    margin: 0;
    padding: 0;
    border-top: 1px solid var(--line);
  }
  .plist a {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    min-height: 48px;
    align-items: center;
    padding: 6px 0;
    border-bottom: 1px solid var(--line);
    color: var(--ink);
    text-decoration: none;
  }
  .plist a:active {
    background: var(--sunk);
  }
</style>
