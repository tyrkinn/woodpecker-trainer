<script lang="ts">
  import type { CycleSummary } from '@wp/core';
  import { clock, pct } from '../lib/format.ts';

  /** Время (столбцы) и точность (линия) по полным циклам. */
  let { cycles }: { cycles: CycleSummary[] } = $props();

  const W = 340;
  const H = 180;
  const pad = { l: 8, r: 8, t: 22, b: 34 };
  const maxMs = $derived(Math.max(1, ...cycles.map((c) => Math.max(c.activeMs, c.targetMs ?? 0))));
  const slot = $derived((W - pad.l - pad.r) / Math.max(cycles.length, 1));
  const bw = $derived(Math.min(44, slot * 0.6));
  const y = (ms: number) => pad.t + (H - pad.t - pad.b) * (1 - ms / maxMs);
  const ya = (a: number) => pad.t + (H - pad.t - pad.b) * (1 - a);
  const cx = (i: number) => pad.l + slot * i + slot / 2;
  const line = $derived(cycles.map((c, i) => `${i ? 'L' : 'M'}${cx(i).toFixed(1)},${ya(c.accuracy).toFixed(1)}`).join(' '));
</script>

<figure>
  <svg viewBox="0 0 {W} {H}" role="img" aria-label="Время и точность по циклам">
    {#each cycles as c, i (c.cycleId)}
      <rect class="bar" x={cx(i) - bw / 2} y={y(c.activeMs)} width={bw} height={H - pad.b - y(c.activeMs)} rx="3" />
      {#if c.targetMs !== null}
        <line class="goal" x1={cx(i) - bw / 2 - 4} x2={cx(i) + bw / 2 + 4} y1={y(c.targetMs)} y2={y(c.targetMs)} />
      {/if}
      <text class="lbl num" x={cx(i)} y={H - pad.b + 14} text-anchor="middle">Ц{c.number}</text>
      <text class="val num" x={cx(i)} y={H - pad.b + 28} text-anchor="middle">{clock(c.activeMs)}</text>
    {/each}
    <path class="acc" d={line} />
    {#each cycles as c, i (c.cycleId)}
      <circle class="dot" cx={cx(i)} cy={ya(c.accuracy)} r="4" />
      <text class="accv num" x={cx(i)} y={ya(c.accuracy) - 8} text-anchor="middle">{pct(c.accuracy)}</text>
    {/each}
  </svg>
  <figcaption class="muted">
    <span class="key bar-key"></span>время цикла <span class="key goal-key"></span>цель <span class="key acc-key"></span>точность
  </figcaption>
</figure>

<style>
  figure {
    margin: 0;
  }
  svg {
    width: 100%;
    height: auto;
    display: block;
  }
  .bar {
    fill: color-mix(in srgb, var(--pine) 70%, var(--bg));
  }
  .goal {
    stroke: var(--crest);
    stroke-width: 2;
    stroke-dasharray: 4 3;
  }
  .acc {
    fill: none;
    stroke: var(--ink);
    stroke-width: 2;
  }
  .dot {
    fill: var(--bg);
    stroke: var(--ink);
    stroke-width: 2;
  }
  .lbl,
  .val,
  .accv {
    font-size: 11px;
    fill: var(--muted);
  }
  .lbl {
    fill: var(--ink);
    font-weight: 600;
  }
  .accv {
    fill: var(--ink);
  }
  figcaption {
    font-size: 0.82rem;
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .key {
    display: inline-block;
    width: 14px;
    height: 4px;
    margin-left: 8px;
  }
  .key:first-child {
    margin-left: 0;
  }
  .bar-key {
    height: 10px;
    background: color-mix(in srgb, var(--pine) 70%, var(--bg));
  }
  .goal-key {
    border-top: 2px dashed var(--crest);
    height: 0;
  }
  .acc-key {
    background: var(--ink);
    height: 2px;
  }
</style>
