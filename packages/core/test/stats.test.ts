import { describe, expect, it } from 'vitest';
import {
  attemptsToday,
  chronicErrors,
  compareWithPrevious,
  median,
  slowestPuzzles,
  summarizeCycle,
  themeStats,
  weakestMotifs,
  type Attempt,
  type Cycle,
  type Puzzle,
} from '../src/index.ts';

// Синтетика: 30 задач, три мотива. fork решается плохо, pin средне, skewer хорошо.
const THEMES = ['fork', 'pin', 'skewer'] as const;
const puzzles: Puzzle[] = Array.from({ length: 30 }, (_, i) => ({
  id: `p${i}`,
  fen: '8/8/8/8/8/8/8/8 w - - 0 1',
  moves: ['a1a2', 'a2a3'],
  rating: 1300 + i * 10,
  themes: [THEMES[i % 3]!, i % 2 ? 'middlegame' : 'endgame', 'short'],
  gameUrl: '',
}));
const pmap = new Map(puzzles.map((p) => [p.id, p]));
const order = puzzles.map((p) => p.id);

const failRate: Record<string, number[]> = {
  // по циклам: доля провалов
  fork: [0.6, 0.5, 0.4],
  pin: [0.3, 0.2, 0.1],
  skewer: [0.1, 0, 0],
};

const cycles: Cycle[] = [1, 2, 3].map((n) => ({
  id: `c${n}`,
  setId: 's',
  number: n,
  mode: 'full',
  targetMs: n === 1 ? null : 1000 * (4 - n),
  activeMs: 3000 / n,
  cursor: 30,
  startedAt: n * 100,
  finishedAt: n * 100 + 50,
}));
const errorsRun: Cycle = { ...cycles[0]!, id: 'e1', mode: 'errors', number: 1 };

const attempts: Attempt[] = [];
for (const c of cycles) {
  const byTheme = new Map<string, number>();
  for (const p of puzzles) {
    const t = p.themes[0]!;
    const k = byTheme.get(t) ?? 0;
    byTheme.set(t, k + 1);
    const failsHere = Math.round(failRate[t]![c.number - 1]! * 10);
    const correct = k >= failsHere;
    attempts.push({
      cycleId: c.id,
      puzzleId: p.id,
      correct,
      timeMs: (t === 'fork' ? 20_000 : 5_000) / c.number + Number(p.id.slice(1)),
      wrongMove: correct ? null : 'h2h3',
      at: c.startedAt + Number(p.id.slice(1)),
    });
  }
}
// Прогон ошибок с «идеальной» точностью не должен портить статистику.
attempts.push({ cycleId: 'e1', puzzleId: 'p0', correct: true, timeMs: 1, wrongMove: null, at: 999 });

describe('median', () => {
  it('нечётная, чётная, пустая выборка', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(3);
    expect(median([])).toBe(0);
  });
});

describe('themeStats', () => {
  const rows = themeStats(pmap, order, [...cycles, errorsRun], attempts);

  it('мета-теги не попадают в таблицу', () => {
    expect(rows.map((r) => r.theme).sort()).toEqual(['fork', 'pin', 'skewer']);
    const withMeta = themeStats(pmap, order, cycles, attempts, { includeMeta: true });
    expect(withMeta.map((r) => r.theme)).toContain('endgame');
  });

  it('худшая тема наверху, точность и медиана по каждому циклу', () => {
    expect(rows.map((r) => r.theme)).toEqual(['fork', 'pin', 'skewer']);
    const fork = rows[0]!;
    expect(fork.puzzles).toBe(10);
    expect(fork.cycles.map((c) => c.cycleNumber)).toEqual([1, 2, 3]);
    expect(fork.cycles.map((c) => c.accuracy)).toEqual([0.4, 0.5, 0.6]);
    expect(fork.cycles.every((c) => c.n === 10)).toBe(true);
    expect(fork.cycles[0]!.medianMs).toBeGreaterThan(fork.cycles[2]!.medianMs);
    expect(fork.latestAccuracy).toBeCloseTo(0.6);
    expect(fork.overallAccuracy).toBeCloseTo(0.5);
    expect(fork.attempts).toBe(30); // прогон ошибок не учтён
  });

  it('weakestMotifs возвращает топ слабых с достаточной выборкой', () => {
    expect(weakestMotifs(rows, 2).map((r) => r.theme)).toEqual(['fork', 'pin']);
    expect(weakestMotifs(rows, 3, 100)).toEqual([]);
  });
});

describe('summarizeCycle / compareWithPrevious', () => {
  it('точность, медиана, цель', () => {
    const s = summarizeCycle(cycles[1]!, attempts);
    expect(s.total).toBe(30);
    expect(s.correct).toBe(30 - 5 - 2 - 0);
    expect(s.hitTarget).toBe(true); // 1500 <= 2000
    expect(summarizeCycle(cycles[0]!, attempts).hitTarget).toBeNull();
  });

  it('сравнение с прошлым циклом', () => {
    const cmp = compareWithPrevious(cycles[2]!, cycles, attempts);
    expect(cmp.previous?.number).toBe(2);
    expect(cmp.timeRatio).toBeCloseTo(1000 / 1500);
    expect(cmp.accuracyDelta).toBeCloseTo((25 - 23) / 30);
    expect(compareWithPrevious(cycles[0]!, cycles, attempts).previous).toBeNull();
  });
});

describe('slowestPuzzles и chronicErrors', () => {
  it('медленные — задачи на вилку с большими id', () => {
    const slow = slowestPuzzles(cycles, attempts, 3);
    expect(slow).toHaveLength(3);
    expect(slow.every((s) => pmap.get(s.puzzleId)!.themes[0] === 'fork')).toBe(true);
    expect(slow[0]!.medianMs).toBeGreaterThanOrEqual(slow[1]!.medianMs);
  });

  it('хронические ошибки — провалены в 2+ циклах', () => {
    const chronic = chronicErrors(cycles, attempts);
    const ids = new Set(chronic.map((c) => c.puzzleId));
    // fork: первые 4 задачи темы провалены во всех трёх циклах; pin: первая — в двух.
    expect(ids).toEqual(new Set(['p0', 'p3', 'p6', 'p9', 'p12', 'p1', 'p4']));
    expect(chronic[0]!.failedCycles).toBe(3);
    expect(chronic.find((c) => c.puzzleId === 'p4')!.failedCycles).toBe(2);
  });
});

describe('attemptsToday', () => {
  it('считает попытки с начала суток', () => {
    const now = new Date(2026, 9, 26, 15).getTime();
    const yesterday = new Date(2026, 9, 25, 23).getTime();
    const list: Attempt[] = [now - 1000, now - 2000, yesterday].map((at) => ({
      cycleId: 'x',
      puzzleId: 'p',
      correct: true,
      timeMs: 1,
      wrongMove: null,
      at,
    }));
    expect(attemptsToday(list, now)).toBe(2);
  });
});
