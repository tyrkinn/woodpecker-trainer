import { isMotif } from './themes.ts';
import type { Attempt, Cycle, Puzzle } from './types.ts';

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export interface CycleSummary {
  cycleId: string;
  number: number;
  mode: Cycle['mode'];
  total: number;
  correct: number;
  accuracy: number;
  activeMs: number;
  medianMs: number;
  targetMs: number | null;
  hitTarget: boolean | null;
}

export function summarizeCycle(cycle: Cycle, attempts: Attempt[]): CycleSummary {
  const own = attempts.filter((a) => a.cycleId === cycle.id);
  const correct = own.filter((a) => a.correct).length;
  return {
    cycleId: cycle.id,
    number: cycle.number,
    mode: cycle.mode,
    total: own.length,
    correct,
    accuracy: own.length ? correct / own.length : 0,
    activeMs: cycle.activeMs,
    medianMs: median(own.map((a) => a.timeMs)),
    targetMs: cycle.targetMs,
    hitTarget: cycle.targetMs === null ? null : cycle.activeMs <= cycle.targetMs,
  };
}

export interface CycleComparison {
  current: CycleSummary;
  previous: CycleSummary | null;
  /** Отношение времени к прошлому циклу: 0.6 = на 40% быстрее. */
  timeRatio: number | null;
  /** Разница точности в долях: +0.05 = на 5 п.п. лучше. */
  accuracyDelta: number | null;
}

export function compareWithPrevious(cycle: Cycle, cycles: Cycle[], attempts: Attempt[]): CycleComparison {
  const current = summarizeCycle(cycle, attempts);
  const prevCycle =
    cycle.mode === 'full'
      ? cycles.find((c) => c.mode === 'full' && c.number === cycle.number - 1 && c.finishedAt !== null)
      : undefined;
  if (!prevCycle) return { current, previous: null, timeRatio: null, accuracyDelta: null };
  const previous = summarizeCycle(prevCycle, attempts);
  return {
    current,
    previous,
    timeRatio: previous.activeMs > 0 ? current.activeMs / previous.activeMs : null,
    accuracyDelta: current.accuracy - previous.accuracy,
  };
}

export interface ThemeCycleCell {
  cycleNumber: number;
  n: number;
  accuracy: number;
  medianMs: number;
}

export interface ThemeRow {
  theme: string;
  /** Задач с этой темой в наборе. */
  puzzles: number;
  /** Ячейки по полным циклам, в порядке номеров. */
  cycles: ThemeCycleCell[];
  /** Точность в последнем цикле, где тема встречалась. Ключ сортировки. */
  latestAccuracy: number;
  /** Точность за все полные циклы. */
  overallAccuracy: number;
  attempts: number;
}

export interface ThemeStatsOptions {
  /** Учитывать мета-теги (длина, фаза, оценка). По умолчанию нет. */
  includeMeta?: boolean;
  /** Минимум попыток, чтобы тема попала в таблицу. */
  minAttempts?: number;
}

/**
 * Таблица по темам. Считается только по полным циклам: прогон ошибок смещал бы точность.
 * Сортировка: худшая точность в последнем цикле — наверху; при равенстве — больше попыток выше.
 */
export function themeStats(
  puzzles: Map<string, Puzzle>,
  setPuzzleIds: string[],
  cycles: Cycle[],
  attempts: Attempt[],
  opts: ThemeStatsOptions = {},
): ThemeRow[] {
  const includeMeta = opts.includeMeta ?? false;
  const minAttempts = opts.minAttempts ?? 1;
  const full = cycles.filter((c) => c.mode === 'full').sort((a, b) => a.number - b.number);
  const cycleNo = new Map(full.map((c) => [c.id, c.number]));

  const puzzleCount = new Map<string, number>();
  for (const id of setPuzzleIds) {
    const p = puzzles.get(id);
    if (!p) continue;
    for (const t of p.themes) {
      if (!includeMeta && !isMotif(t)) continue;
      puzzleCount.set(t, (puzzleCount.get(t) ?? 0) + 1);
    }
  }

  // theme -> cycleNumber -> attempts
  const buckets = new Map<string, Map<number, Attempt[]>>();
  for (const a of attempts) {
    const no = cycleNo.get(a.cycleId);
    if (no === undefined) continue;
    const p = puzzles.get(a.puzzleId);
    if (!p) continue;
    for (const t of p.themes) {
      if (!includeMeta && !isMotif(t)) continue;
      let byCycle = buckets.get(t);
      if (!byCycle) buckets.set(t, (byCycle = new Map()));
      const list = byCycle.get(no) ?? [];
      list.push(a);
      byCycle.set(no, list);
    }
  }

  const rows: ThemeRow[] = [];
  for (const [theme, byCycle] of buckets) {
    const cells: ThemeCycleCell[] = [...byCycle.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([cycleNumber, list]) => ({
        cycleNumber,
        n: list.length,
        accuracy: list.filter((a) => a.correct).length / list.length,
        medianMs: median(list.map((a) => a.timeMs)),
      }));
    const all = [...byCycle.values()].flat();
    if (all.length < minAttempts) continue;
    rows.push({
      theme,
      puzzles: puzzleCount.get(theme) ?? 0,
      cycles: cells,
      latestAccuracy: cells.at(-1)!.accuracy,
      overallAccuracy: all.filter((a) => a.correct).length / all.length,
      attempts: all.length,
    });
  }

  rows.sort(
    (a, b) =>
      a.latestAccuracy - b.latestAccuracy ||
      a.overallAccuracy - b.overallAccuracy ||
      b.attempts - a.attempts ||
      a.theme.localeCompare(b.theme),
  );
  return rows;
}

/** Три самых слабых мотива. Темы с маленькой выборкой отсекаются, чтобы не было шума. */
export function weakestMotifs(rows: ThemeRow[], n = 3, minAttempts = 5): ThemeRow[] {
  return rows.filter((r) => r.attempts >= minAttempts).slice(0, n);
}

export interface PuzzleTiming {
  puzzleId: string;
  medianMs: number;
  lastMs: number;
  attempts: number;
  fails: number;
}

function perPuzzle(cycles: Cycle[], attempts: Attempt[]): Map<string, Attempt[]> {
  const fullIds = new Set(cycles.filter((c) => c.mode === 'full').map((c) => c.id));
  const by = new Map<string, Attempt[]>();
  for (const a of attempts) {
    if (!fullIds.has(a.cycleId)) continue;
    const list = by.get(a.puzzleId) ?? [];
    list.push(a);
    by.set(a.puzzleId, list);
  }
  return by;
}

/** Самые медленные задачи по медиане времени за полные циклы. */
export function slowestPuzzles(cycles: Cycle[], attempts: Attempt[], n = 20): PuzzleTiming[] {
  return [...perPuzzle(cycles, attempts).entries()]
    .map(([puzzleId, list]) => {
      const sorted = [...list].sort((a, b) => a.at - b.at);
      return {
        puzzleId,
        medianMs: median(list.map((a) => a.timeMs)),
        lastMs: sorted.at(-1)!.timeMs,
        attempts: list.length,
        fails: list.filter((a) => !a.correct).length,
      };
    })
    .sort((a, b) => b.medianMs - a.medianMs || a.puzzleId.localeCompare(b.puzzleId))
    .slice(0, n);
}

export interface ChronicError {
  puzzleId: string;
  /** В скольких разных полных циклах задача провалена. */
  failedCycles: number;
  attempts: number;
  lastWrongMove: string | null;
}

/** Хронические ошибки: задача провалена в двух и более полных циклах. */
export function chronicErrors(cycles: Cycle[], attempts: Attempt[], minCycles = 2): ChronicError[] {
  const out: ChronicError[] = [];
  for (const [puzzleId, list] of perPuzzle(cycles, attempts)) {
    const fails = list.filter((a) => !a.correct);
    const failedCycles = new Set(fails.map((a) => a.cycleId)).size;
    if (failedCycles >= minCycles) {
      const last = [...fails].sort((a, b) => b.at - a.at)[0]!;
      out.push({ puzzleId, failedCycles, attempts: list.length, lastWrongMove: last.wrongMove });
    }
  }
  return out.sort((a, b) => b.failedCycles - a.failedCycles || a.puzzleId.localeCompare(b.puzzleId));
}

/** Сколько задач решено (попыток сделано) с начала текущих суток. */
export function attemptsToday(attempts: Attempt[], now: number): number {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return attempts.filter((a) => a.at >= start).length;
}
