<script lang="ts">
  let { color, onpick, oncancel }: { color: 'white' | 'black'; onpick: (p: 'q' | 'r' | 'b' | 'n') => void; oncancel: () => void } =
    $props();
  const pieces = [
    { k: 'q', role: 'queen', label: 'Ферзь' },
    { k: 'n', role: 'knight', label: 'Конь' },
    { k: 'r', role: 'rook', label: 'Ладья' },
    { k: 'b', role: 'bishop', label: 'Слон' },
  ] as const;
</script>

<div class="scrim" role="presentation" onclick={oncancel}>
  <div class="dialog cg-wrap" role="dialog" aria-label="Превращение пешки" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && oncancel()}>
    {#each pieces as p (p.k)}
      <button class="choice" aria-label={p.label} onclick={() => onpick(p.k)}>
        <piece class="{p.role} {color}"></piece>
      </button>
    {/each}
  </div>
</div>

<style>
  .scrim {
    position: absolute;
    inset: 0;
    z-index: 20;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--bg) 55%, transparent);
  }
  .dialog {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
    width: min(88%, 380px);
    padding: 8px;
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
  }
  .choice {
    position: relative;
    aspect-ratio: 1;
    min-width: 44px;
    border: 0;
    border-radius: var(--radius-sm);
    background: var(--sunk);
    cursor: pointer;
  }
  .choice:active {
    background: var(--line);
  }
  .choice :global(piece) {
    position: absolute;
    inset: 6%;
    width: 88%;
    height: 88%;
  }
</style>
