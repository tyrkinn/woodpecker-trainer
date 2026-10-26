<script lang="ts">
  import type { Component } from 'svelte';
  import Home from './screens/Home.svelte';
  import { href, router, type Route } from './lib/router.svelte.ts';

  type Screen = { default: Component<{ route: Route }> };
  // Экраны кроме «Главной» грузятся лениво: доска и шахматная логика не нужны для первой отрисовки.
  const load = (r: Route): Promise<Screen> => {
    switch (r.name) {
      case 'solve':
      case 'practice':
        return import('./screens/Solve.svelte') as Promise<Screen>;
      case 'summary':
        return import('./screens/Summary.svelte') as Promise<Screen>;
      case 'stats':
        return import('./screens/Stats.svelte') as Promise<Screen>;
      default:
        return Promise.reject(new Error('unknown route'));
    }
  };

  // Прогреваем экран решения в простое, чтобы первый тап по «Продолжить» был мгновенным.
  if (typeof window !== 'undefined') {
    const warm = () => void import('./screens/Solve.svelte');
    if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 3000 });
    else setTimeout(warm, 1500);
  }
</script>

{#key href(router.current)}
  {#if router.current.name === 'home'}
    <Home />
  {:else}
    {#await load(router.current) then screen}
      <screen.default route={router.current} />
    {:catch err}
      <div class="screen">
        <p>Не удалось открыть экран: {err instanceof Error ? err.message : String(err)}</p>
        <a class="btn" href="#/">На главную</a>
      </div>
    {/await}
  {/if}
{/key}
