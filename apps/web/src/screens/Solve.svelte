<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import { Chessground } from '@lichess-org/chessground';
  import type { Api } from '@lichess-org/chessground/api';
  import type { Key } from '@lichess-org/chessground/types';
  import '@lichess-org/chessground/assets/chessground.base.css';
  import '@lichess-org/chessground/assets/chessground.cburnett.css';
  import { Chess } from 'chess.js';
  import {
    ActiveTimer,
    PuzzleSession,
    cyclePuzzleIds,
    needsPromotion,
    parseUci,
    themeLabel,
    isMotif,
    type Cycle,
    type PlayedMove,
    type Puzzle,
  } from '@wp/core';
  import Promotion from '../components/Promotion.svelte';
  import Tally from '../components/Tally.svelte';
  import { clock } from '../lib/format.ts';
  import { flushActiveMs, loadBundle, saveResult, type SetBundle } from '../lib/repo.ts';
  import { router, type Route } from '../lib/router.svelte.ts';
  import { db } from '../lib/db.ts';

  let { route }: { route: Route } = $props();
  // Экран создаётся заново на каждый маршрут (#key в App), поэтому режим фиксируем один раз.
  const r0: Route = untrack(() => route);
  const practice = r0.name === 'practice';

  type Phase = 'loading' | 'setup' | 'thinking' | 'reply' | 'promotion' | 'solved' | 'failed' | 'practice-done' | 'error';
  let phase = $state<Phase>('loading');
  let errorText = $state('');

  let boardEl: HTMLDivElement;
  let cg: Api | null = null;

  let bundle: SetBundle | null = null;
  let cycle = $state<Cycle | null>(null);
  let ids = $state<string[]>([]);
  let index = $state(0);
  let puzzle = $state<Puzzle | null>(null);
  let session: PuzzleSession | null = null;
  let results = $state<(boolean | undefined)[]>([]);

  let flash = $state<'ok' | 'bad' | null>(null);
  let paused = $state(false);
  let hidden = false;
  let pendingPromo: { orig: string; dest: string } | null = null;
  let userColor = $state<'white' | 'black'>('white');

  /** Что показать про задачу после ответа. */
  interface Reveal {
    puzzle: Puzzle;
    correct: boolean;
    wrongSan: string | null;
    solutionSan: string[];
    altMate: boolean;
    timeMs: number;
  }
  let reveal = $state<Reveal | null>(null);
  /** Строка о предыдущей задаче (после верного ответа и автоперехода). */
  let previous = $state<Reveal | null>(null);

  const cycleTimer = new ActiveTimer();
  const puzzleTimer = new ActiveTimer();
  let now = $state(Date.now());
  let ticker: ReturnType<typeof setInterval> | undefined;
  const timeouts = new Set<ReturnType<typeof setTimeout>>();

  function later(fn: () => void, ms: number) {
    const t = setTimeout(() => {
      timeouts.delete(t);
      fn();
    }, ms);
    timeouts.add(t);
  }
  function clearLater() {
    for (const t of timeouts) clearTimeout(t);
    timeouts.clear();
  }

  const elapsed = $derived(cycleTimer.elapsed(now));
  const target = $derived(cycle?.targetMs ?? null);
  /** Отставание от графика цели: + — медленнее, − — быстрее. */
  const pace = $derived.by(() => {
    if (target === null || ids.length === 0) return null;
    const expected = (target * index) / ids.length;
    return elapsed - expected;
  });

  // ---------- доска ----------

  const colorOf = (fen: string) => (fen.split(' ')[1] === 'w' ? 'white' : 'black') as 'white' | 'black';

  function show(fen: string, lastMove?: [string, string], interactive = false) {
    if (!cg || !session) return;
    const turn = colorOf(fen);
    const inCheck = new Chess(fen).inCheck();
    cg.set({
      fen,
      turnColor: turn,
      lastMove: lastMove as Key[] | undefined,
      check: inCheck ? turn : false,
      movable: {
        color: interactive ? userColor : undefined,
        dests: (interactive ? session.dests() : new Map()) as Map<Key, Key[]>,
      },
    });
  }

  function playMove(m: PlayedMove, interactive = false) {
    show(m.fenAfter, [m.from, m.to], interactive);
  }

  // ---------- жизненный цикл задачи ----------

  function loadPuzzle(i: number) {
    clearLater();
    const id = ids[i];
    const p = id ? bundle?.puzzles.get(id) : undefined;
    if (!p) {
      phase = 'error';
      errorText = `Задача ${id ?? i} не найдена в базе. Переимпортируй набор.`;
      return;
    }
    index = i;
    puzzle = p;
    reveal = null;
    session = new PuzzleSession(p);
    userColor = session.userColor;
    phase = 'setup';
    cg?.cancelMove();
    cg?.selectSquare(null);
    cg?.set({ orientation: userColor });
    show(p.fen);
    later(() => {
      if (!session) return;
      const m = session.playSetup();
      playMove(m, true);
      phase = 'thinking';
      puzzleTimer.reset();
      if (!paused && !hidden) puzzleTimer.start(Date.now());
    }, 420);
  }

  function onBoardMove(orig: string, dest: string) {
    if (phase !== 'thinking' || !session) return;
    if (needsPromotion(session.fen, orig, dest)) {
      pendingPromo = { orig, dest };
      phase = 'promotion';
      return;
    }
    submit(orig + dest);
  }

  function pickPromotion(piece: 'q' | 'r' | 'b' | 'n') {
    if (!pendingPromo) return;
    const { orig, dest } = pendingPromo;
    pendingPromo = null;
    phase = 'thinking';
    submit(orig + dest + piece);
  }

  function cancelPromotion() {
    pendingPromo = null;
    phase = 'thinking';
    if (session) show(session.fen, undefined, true);
  }

  function submit(uci: string) {
    if (!session) return;
    const before = session.fen;
    const r = session.tryMove(uci);
    switch (r.kind) {
      case 'illegal':
        show(session.fen, undefined, true);
        return;
      case 'continue':
        playMove(r.move);
        phase = 'reply';
        later(() => {
          playMove(r.reply, true);
          phase = 'thinking';
        }, 380);
        return;
      case 'solved':
        playMove(r.move);
        void finish(true, null, { altMate: r.altMate });
        return;
      case 'wrong': {
        const probe = new Chess(before);
        let wrongSan: string | null = null;
        try {
          const m = probe.move(parseUci(r.uci));
          wrongSan = m.san;
          show(probe.fen(), [m.from, m.to]);
        } catch {
          /* ход уже проверен как легальный */
        }
        void finish(false, r.uci, { wrongSan, before });
        return;
      }
    }
  }

  function giveUp() {
    if (phase !== 'thinking' || !session) return;
    void finish(false, null, { before: session.fen, wrongSan: null });
  }

  async function finish(
    correct: boolean,
    wrongUci: string | null,
    extra: { altMate?: boolean; wrongSan?: string | null; before?: string },
  ) {
    if (!session || !puzzle) return;
    const t = Date.now();
    puzzleTimer.pause(t);
    const timeMs = puzzleTimer.elapsed(t);
    const p = puzzle;
    const rest = correct ? [] : session.remainingSolution();
    session.giveUp();
    phase = correct ? 'solved' : 'failed';
    flash = correct ? 'ok' : 'bad';
    later(() => (flash = null), correct ? 380 : 650);

    const info: Reveal = {
      puzzle: p,
      correct,
      wrongSan: extra.wrongSan ?? null,
      solutionSan: correct ? [] : rest.map((m) => m.san),
      altMate: extra.altMate ?? false,
      timeMs,
    };

    if (!practice && cycle) {
      results[index] = correct;
      try {
        cycle = await saveResult(cycle.id, { puzzleId: p.id, correct, timeMs, wrongMove: wrongUci }, cycleTimer.elapsed(Date.now()));
      } catch (e) {
        phase = 'error';
        errorText = `Не удалось сохранить результат: ${e instanceof Error ? e.message : String(e)}`;
        return;
      }
    }

    if (correct) {
      previous = info;
      later(next, 520);
    } else {
      reveal = info;
      // Показываем ошибочный ход, откатываем и проигрываем решение.
      later(() => {
        if (extra.before) show(extra.before);
        rest.forEach((m, i) => later(() => playMove(m), 420 + i * 650));
      }, wrongUci ? 600 : 50);
    }
  }

  function next() {
    if (practice) {
      phase = 'practice-done';
      return;
    }
    if (!cycle) return;
    if (cycle.finishedAt !== null) {
      router.go({ name: 'summary', cycleId: cycle.id }, true);
      return;
    }
    previous = reveal ?? previous;
    loadPuzzle(cycle.cursor);
  }

  function retryPractice() {
    previous = null;
    loadPuzzle(0);
  }

  // ---------- пауза и активное время ----------

  function pauseTimers() {
    const t = Date.now();
    cycleTimer.pause(t);
    puzzleTimer.pause(t);
    if (cycle && !practice) void flushActiveMs(cycle.id, cycleTimer.elapsed(t));
  }

  function resumeTimers() {
    if (paused || hidden) return;
    const t = Date.now();
    if (!practice) cycleTimer.start(t);
    if (phase === 'thinking' || phase === 'promotion') puzzleTimer.start(t);
  }

  function togglePause() {
    if (phase === 'loading' || phase === 'error') return;
    paused = !paused;
    if (paused) pauseTimers();
    else resumeTimers();
  }

  function onVisibility() {
    hidden = document.visibilityState === 'hidden';
    if (hidden) pauseTimers();
    else resumeTimers();
  }

  function onPageHide() {
    pauseTimers();
  }

  function onKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'Escape') {
      if (phase === 'promotion') cancelPromotion();
      else togglePause();
      e.preventDefault();
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (paused) togglePause();
      else if (phase === 'failed') practice ? retryPractice() : next();
      else if (phase === 'practice-done') retryPractice();
    } else if (e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А') {
      cg?.toggleOrientation();
    }
  }

  // ---------- старт ----------

  onMount(() => {
    cg = Chessground(boardEl, {
      coordinates: true,
      animation: { enabled: true, duration: 220 },
      highlight: { lastMove: true, check: true },
      movable: { free: false, showDests: true, rookCastle: true, events: { after: (o, d) => onBoardMove(o, d) } },
      draggable: { enabled: true, showGhost: true },
      selectable: { enabled: true },
      premovable: { enabled: false },
      drawable: { enabled: true },
      blockTouchScroll: true,
      disableContextMenu: true,
    });

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    hidden = document.visibilityState === 'hidden';
    ticker = setInterval(() => (now = Date.now()), 250);

    void (async () => {
      try {
        if (r0.name === 'practice') {
          bundle = await loadBundle(r0.setId);
          if (!bundle) throw new Error('Набор не найден');
          ids = [r0.puzzleId];
          loadPuzzle(0);
          return;
        }
        if (r0.name !== 'solve') throw new Error('Неизвестный маршрут');
        const c = await db().cycles.get(r0.cycleId);
        if (!c) throw new Error('Цикл не найден');
        if (c.finishedAt !== null) {
          router.go({ name: 'summary', cycleId: c.id }, true);
          return;
        }
        bundle = await loadBundle(c.setId);
        if (!bundle) throw new Error('Набор не найден');
        cycle = c;
        ids = cyclePuzzleIds(bundle.set, c);
        const byPuzzle = new Map(bundle.attempts.filter((a) => a.cycleId === c.id).map((a) => [a.puzzleId, a.correct]));
        results = ids.map((id) => byPuzzle.get(id));
        cycleTimer.reset(c.activeMs);
        resumeTimers();
        loadPuzzle(c.cursor);
      } catch (e) {
        phase = 'error';
        errorText = e instanceof Error ? e.message : String(e);
      }
    })();
  });

  onDestroy(() => {
    clearLater();
    clearInterval(ticker);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
    pauseTimers();
    cg?.destroy();
  });

  const lichessLink = (p: Puzzle) => p.gameUrl || (p.id.startsWith('demo-') ? '' : `https://lichess.org/training/${p.id}`);
  const motifs = (p: Puzzle) => p.themes.filter(isMotif).map(themeLabel);
</script>

<svelte:window onkeydown={onKey} />

<main class="solve" class:flash-ok={flash === 'ok'} class:flash-bad={flash === 'bad'}>
  <div class="board-col">
    <div class="board-frame">
      <div class="board" bind:this={boardEl} class:veiled={paused}></div>
      {#if phase === 'promotion'}
        <Promotion color={userColor} onpick={pickPromotion} oncancel={cancelPromotion} />
      {/if}
      {#if paused}
        <button class="pause-veil" onclick={togglePause}>
          <span class="pause-title">Пауза</span>
          <span>Время стоит. Тап, пробел или Esc — продолжить</span>
        </button>
      {/if}
    </div>
  </div>

  <div class="side">
    <div class="status">
      {#if practice}
        <span class="num">Повтор задачи{puzzle ? ` · ${puzzle.rating}` : ''}</span>
      {:else}
        <span class="num pos">{Math.min(index + 1, ids.length)}<small>/{ids.length}</small></span>
        <span class="num clock">{clock(elapsed)}</span>
        {#if target !== null}
          <span class="num goal">
            цель {clock(target)}
            {#if pace !== null && index > 0}
              <b class:behind={pace > 0} class:ahead={pace <= 0}>{pace > 0 ? '+' : '−'}{clock(Math.abs(pace))}</b>
            {/if}
          </span>
        {:else}
          <span class="goal muted">{cycle?.mode === 'errors' ? 'ошибки, без цели' : 'на точность'}</span>
        {/if}
      {/if}
    </div>

    {#if !practice && ids.length > 1}
      <Tally {results} total={ids.length} cursor={index} height={6} />
    {/if}

    <div class="turn-line" aria-live="polite">
      {#if phase === 'thinking' || phase === 'promotion'}
        Ход {userColor === 'white' ? 'белых' : 'чёрных'}
      {:else if phase === 'setup' || phase === 'reply'}
        <span class="muted">Ход соперника…</span>
      {:else if phase === 'solved'}
        <span class="ok-text">Верно{previous?.altMate ? ' — другой мат тоже засчитан' : ''}</span>
      {:else if phase === 'failed'}
        <span class="bad-text">{reveal?.wrongSan ? `${reveal.wrongSan} — ошибка` : 'Не решено'}</span>
      {:else if phase === 'practice-done'}
        Готово
      {:else if phase === 'loading'}
        <span class="muted">Загрузка…</span>
      {/if}
    </div>

    {#if phase === 'error'}
      <div class="card">
        <p>{errorText}</p>
        <a class="btn" href="#/">На главную</a>
      </div>
    {:else if reveal}
      <div class="card reveal">
        <p class="solution">
          <span class="muted">Решение:</span>
          <span class="num">{reveal.solutionSan.join(' ')}</span>
        </p>
        <p class="themes">
          {motifs(reveal.puzzle).join(', ') || 'без мотива'} · <span class="num">{reveal.puzzle.rating}</span>
          {#if lichessLink(reveal.puzzle)}
            · <a href={lichessLink(reveal.puzzle)} target="_blank" rel="noopener">партия</a>
          {/if}
        </p>
        {#if practice}
          <div class="row">
            <button class="btn primary" onclick={retryPractice} disabled={phase !== 'failed'}>Ещё раз</button>
            <button class="btn" onclick={() => history.back()}>Назад</button>
          </div>
        {:else}
          <button class="btn primary wide" onclick={next} disabled={phase !== 'failed'}>Дальше</button>
        {/if}
      </div>
    {:else if phase === 'practice-done'}
      <div class="card">
        <div class="row">
          <button class="btn primary" onclick={retryPractice}>Ещё раз</button>
          <button class="btn" onclick={() => history.back()}>Назад</button>
        </div>
      </div>
    {:else if previous && !practice}
      <p class="prev muted">
        Прошлая: {motifs(previous.puzzle).join(', ') || 'без мотива'}
        {#if lichessLink(previous.puzzle)}
          · <a href={lichessLink(previous.puzzle)} target="_blank" rel="noopener">партия</a>
        {/if}
      </p>
    {/if}

    <nav class="actions">
      <button class="btn" onclick={giveUp} disabled={phase !== 'thinking'}>Не знаю</button>
      <button class="btn" onclick={togglePause} aria-pressed={paused}>{paused ? 'Продолжить' : 'Пауза'}</button>
      <button class="btn quiet" onclick={() => cg?.toggleOrientation()} aria-label="Перевернуть доску">Перевернуть</button>
      <a class="btn quiet" href={practice ? `#/stats/${encodeURIComponent(r0.name === 'practice' ? r0.setId : '')}` : '#/'}>Выйти</a>
    </nav>
    <p class="keys muted">Пробел — дальше · F — перевернуть · Esc — пауза</p>
  </div>
</main>

<style>
  .solve {
    display: flex;
    flex-direction: column;
    min-height: 100dvh;
    --flash: transparent;
  }
  .board-col {
    width: 100%;
  }
  .board-frame {
    position: relative;
    width: 100%;
    aspect-ratio: 1;
    box-shadow: 0 0 0 0 var(--flash);
    transition: box-shadow 120ms ease-out;
  }
  .flash-ok {
    --flash: var(--ok);
  }
  .flash-bad {
    --flash: var(--crest);
  }
  .flash-ok .board-frame,
  .flash-bad .board-frame {
    box-shadow: 0 0 0 5px var(--flash);
  }
  .board {
    width: 100%;
    height: 100%;
    touch-action: none;
  }
  .board.veiled {
    visibility: hidden;
  }
  .pause-veil {
    position: absolute;
    inset: 0;
    border: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    background: var(--sunk);
    color: var(--ink);
    cursor: pointer;
    padding: 24px;
    text-align: center;
  }
  .pause-title {
    font-size: 2rem;
    font-weight: 700;
  }

  .side {
    padding: 10px var(--gutter) 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .status {
    display: flex;
    align-items: baseline;
    gap: 14px;
    font-size: 1.05rem;
  }
  .pos {
    font-size: 1.5rem;
    font-weight: 620;
  }
  .pos small {
    font-size: 0.65em;
    color: var(--muted);
  }
  .clock {
    font-size: 1.5rem;
    font-weight: 620;
  }
  .goal {
    margin-left: auto;
    color: var(--muted);
  }
  .goal b {
    font-weight: 600;
    margin-left: 6px;
  }
  .behind {
    color: var(--crest);
  }
  .ahead {
    color: var(--ok);
  }
  .turn-line {
    min-height: 1.5em;
    font-weight: 560;
  }
  .ok-text {
    color: var(--ok);
  }
  .bad-text {
    color: var(--crest);
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .card p {
    margin: 0;
  }
  .solution .num {
    font-size: 1.1rem;
    font-weight: 600;
  }
  .themes {
    font-size: 0.92rem;
  }
  .wide {
    width: 100%;
    min-height: 52px;
    font-size: 1.05rem;
  }
  .prev {
    margin: 0;
    font-size: 0.9rem;
  }
  .actions {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(78px, 1fr));
    gap: 6px;
    margin-top: auto;
  }
  .actions .btn {
    padding: 8px 6px;
    font-size: 0.92rem;
  }
  .row {
    display: flex;
    gap: 8px;
  }
  .keys {
    display: none;
    font-size: 0.8rem;
    margin: 0;
  }

  /* Доска: свои цвета клеток вместо картинки темы */
  .board :global(cg-board) {
    background-color: var(--sq-light);
    background-image: conic-gradient(
      var(--sq-dark) 0deg 90deg,
      transparent 90deg 180deg,
      var(--sq-dark) 180deg 270deg,
      transparent 270deg 360deg
    );
    background-size: 25% 25%;
  }
  .board :global(cg-board square.last-move) {
    background-color: var(--hl-last);
  }
  .board :global(cg-board square.selected) {
    background-color: var(--hl-sel);
  }
  .board :global(cg-board square.move-dest) {
    background: radial-gradient(var(--dot) 19%, transparent 20%);
  }
  .board :global(cg-board square.oc.move-dest) {
    background: radial-gradient(transparent 0%, transparent 79%, var(--dot) 80%);
  }
  .board :global(cg-board square.check) {
    background: radial-gradient(ellipse at center, rgba(230, 30, 20, 0.95) 0%, rgba(200, 20, 10, 0.6) 35%, transparent 75%);
  }
  .board :global(coords) {
    font-size: 10px;
    font-weight: 600;
  }
  .board :global(.orientation-white .ranks :nth-child(odd)),
  .board :global(.orientation-white .files :nth-child(even)),
  .board :global(.orientation-black .ranks :nth-child(even)),
  .board :global(.orientation-black .files :nth-child(odd)) {
    color: var(--sq-light);
  }
  .board :global(.orientation-white .ranks :nth-child(even)),
  .board :global(.orientation-white .files :nth-child(odd)),
  .board :global(.orientation-black .ranks :nth-child(odd)),
  .board :global(.orientation-black .files :nth-child(even)) {
    color: var(--sq-dark);
  }

  /* Ландшафт и десктоп: доска слева по высоте экрана, панель справа */
  @media (orientation: landscape) and (min-width: 600px) {
    .solve {
      flex-direction: row;
      align-items: flex-start;
      gap: 8px;
      padding: 8px;
    }
    .board-col {
      width: min(calc(100dvh - 16px), calc(100% - 320px));
      flex: none;
    }
    .side {
      flex: 1;
      min-width: 300px;
      min-height: calc(100dvh - 16px);
      padding: 4px 8px;
    }
  }
  @media (hover: hover) and (pointer: fine) {
    .keys {
      display: block;
    }
  }
</style>
