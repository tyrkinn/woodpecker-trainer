<script lang="ts">
  /**
   * Полоса «простукивания»: по клетке на задачу цикла.
   * Зелёный — решена, красный — ошибка, пусто — впереди, рамка — текущая.
   */
  let {
    results,
    total,
    cursor = -1,
    height = 14,
  }: { results: (boolean | undefined)[]; total: number; cursor?: number; height?: number } = $props();

  const cells = $derived(Array.from({ length: total }, (_, i) => results[i]));
</script>

<svg
  class="tally"
  viewBox="0 0 {Math.max(total, 1)} 1"
  preserveAspectRatio="none"
  style:height="{height}px"
  role="img"
  aria-label="Решено {results.filter((r) => r === true).length}, ошибок {results.filter((r) => r === false).length}, всего {total}"
>
  <rect class="bed" x="0" y="0" width={Math.max(total, 1)} height="1" />
  {#each cells as r, i (i)}
    {#if r !== undefined}
      <rect x={i} y="0" width="1.02" height="1" class={r ? 'ok' : 'bad'} />
    {/if}
  {/each}
  {#if cursor >= 0 && cursor < total}
    <rect x={cursor} y="0" width={Math.max(1, total / 120)} height="1" class="cur" />
  {/if}
</svg>

<style>
  .tally {
    display: block;
    width: 100%;
    border-radius: 3px;
    overflow: hidden;
  }
  .bed {
    fill: var(--sunk);
  }
  .ok {
    fill: var(--ok);
  }
  .bad {
    fill: var(--crest);
  }
  .cur {
    fill: var(--ink);
  }
</style>
