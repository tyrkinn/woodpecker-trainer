import { describe, expect, it } from 'vitest';
import {
  ActiveTimer,
  activeCycle,
  createErrorsRun,
  createFullCycle,
  cyclePuzzleIds,
  daysSince,
  nextTargetMs,
  planNextCycle,
  recordResult,
  resumePoint,
  DEFAULT_SETTINGS,
  type Attempt,
  type Cycle,
  type StoredSet,
} from '../src/index.ts';

const SET: StoredSet = {
  id: 's1',
  name: 'test',
  params: {},
  puzzleIds: ['p1', 'p2', 'p3', 'p4'],
  createdAt: '2026-01-01',
  importedAt: 0,
  settings: { ...DEFAULT_SETTINGS },
};

function cycle(over: Partial<Cycle>): Cycle {
  return {
    id: 'c' + (over.number ?? 1),
    setId: 's1',
    number: 1,
    mode: 'full',
    targetMs: null,
    activeMs: 0,
    cursor: 0,
    startedAt: 0,
    finishedAt: null,
    ...over,
  };
}

describe('расчёт цели', () => {
  it('цель = время × коэффициент', () => {
    expect(nextTargetMs(600_000, 0.5)).toBe(300_000);
    expect(nextTargetMs(600_000, 0.7)).toBe(420_000);
  });
  it('коэффициент не меньше 0.3', () => {
    expect(nextTargetMs(1000, 0.1)).toBe(300);
  });

  it('цикл 1 без цели, цикл 2 с целью от активного времени цикла 1', () => {
    expect(planNextCycle([], DEFAULT_SETTINGS)).toEqual({ kind: 'start', number: 1, targetMs: null });
    const c1 = cycle({ number: 1, activeMs: 40 * 60_000, finishedAt: 10, cursor: 4 });
    expect(planNextCycle([c1], DEFAULT_SETTINGS)).toEqual({ kind: 'start', number: 2, targetMs: 20 * 60_000 });
  });

  it('новый цикл нельзя начать, пока текущий не завершён', () => {
    const c1 = cycle({ number: 1 });
    const plan = planNextCycle([c1], DEFAULT_SETTINGS);
    expect(plan.kind).toBe('busy');
  });

  it('после максимума циклов — done', () => {
    const cs = Array.from({ length: 7 }, (_, i) => cycle({ id: 'c' + i, number: i + 1, finishedAt: 1, activeMs: 1000 }));
    expect(planNextCycle(cs, DEFAULT_SETTINGS)).toEqual({ kind: 'done', completed: 7 });
    expect(planNextCycle(cs.slice(0, 3), { coef: 0.5, maxCycles: 3 }).kind).toBe('done');
  });

  it('прогон ошибок не влияет на цель', () => {
    const c1 = cycle({ id: 'c1', number: 1, activeMs: 1000, finishedAt: 1 });
    const err = cycle({ id: 'e1', number: 1, mode: 'errors', activeMs: 99_999, finishedAt: 2, startedAt: 2 });
    expect(planNextCycle([c1, err], DEFAULT_SETTINGS)).toEqual({ kind: 'start', number: 2, targetMs: 500 });
  });
});

describe('ActiveTimer: пауза и активное время', () => {
  it('считает только время между start и pause', () => {
    const t = new ActiveTimer();
    t.start(1000);
    expect(t.elapsed(1500)).toBe(500);
    t.pause(2000);
    expect(t.elapsed(3_600_000)).toBe(1000); // свернул на час — время не идёт
    t.start(3_600_000);
    t.pause(3_600_250);
    expect(t.elapsed(9_999_999)).toBe(1250);
  });

  it('повторный start и pause идемпотентны', () => {
    const t = new ActiveTimer(100);
    t.start(0);
    t.start(50);
    t.pause(100);
    t.pause(200);
    expect(t.elapsed(1000)).toBe(200);
    expect(t.running).toBe(false);
  });

  it('продолжает с базового времени после перезапуска', () => {
    const t = new ActiveTimer(5000);
    t.start(0);
    expect(t.elapsed(100)).toBe(5100);
  });
});

describe('recordResult и восстановление с cursor', () => {
  it('двигает cursor, копит activeMs и завершает цикл на последней задаче', () => {
    let c = createFullCycle('s1', { kind: 'start', number: 1, targetMs: null }, 0);
    const attempts: Attempt[] = [];
    for (let i = 0; i < SET.puzzleIds.length; i++) {
      const r = recordResult(
        c,
        SET.puzzleIds.length,
        { puzzleId: SET.puzzleIds[i]!, correct: i !== 1, timeMs: 1000, wrongMove: i === 1 ? 'a2a3' : null },
        (i + 1) * 1200,
        100 + i,
      );
      c = r.cycle;
      attempts.push(r.attempt);
      if (i < 3) expect(c.finishedAt).toBeNull();
    }
    expect(c.cursor).toBe(4);
    expect(c.activeMs).toBe(4800);
    expect(c.finishedAt).toBe(103);
    expect(attempts[1]).toMatchObject({ correct: false, wrongMove: 'a2a3' });
  });

  it('resumePoint возвращает задачу по cursor', () => {
    const c = cycle({ cursor: 2 });
    expect(resumePoint(SET, c)).toEqual({ index: 2, puzzleId: 'p3', total: 4 });
    expect(resumePoint(SET, cycle({ cursor: 4 }))).toEqual({ index: 4, puzzleId: null, total: 4 });
  });

  it('activeCycle находит незавершённый цикл', () => {
    const done = cycle({ id: 'a', finishedAt: 5 });
    const open = cycle({ id: 'b', number: 2, startedAt: 6 });
    expect(activeCycle([done, open])?.id).toBe('b');
    expect(activeCycle([done])).toBeUndefined();
  });
});

describe('режим «только ошибки»', () => {
  const c1 = cycle({ id: 'c1', number: 1, finishedAt: 10, cursor: 4 });
  const attempts: Attempt[] = [
    { cycleId: 'c1', puzzleId: 'p1', correct: true, timeMs: 1, wrongMove: null, at: 1 },
    { cycleId: 'c1', puzzleId: 'p4', correct: false, timeMs: 1, wrongMove: 'x', at: 2 },
    { cycleId: 'c1', puzzleId: 'p2', correct: false, timeMs: 1, wrongMove: 'y', at: 3 },
    { cycleId: 'old', puzzleId: 'p3', correct: false, timeMs: 1, wrongMove: 'z', at: 0 },
  ];

  it('берёт проваленные в последнем цикле задачи в порядке набора', () => {
    const run = createErrorsRun(SET, [c1], attempts, 50)!;
    expect(run.mode).toBe('errors');
    expect(run.targetMs).toBeNull();
    expect(run.number).toBe(1);
    expect(cyclePuzzleIds(SET, run)).toEqual(['p2', 'p4']);
  });

  it('null, если ошибок нет или цикл не завершён', () => {
    expect(createErrorsRun(SET, [c1], attempts.slice(0, 1), 50)).toBeNull();
    expect(createErrorsRun(SET, [cycle({ id: 'c1' })], attempts, 50)).toBeNull();
  });
});

describe('daysSince', () => {
  it('считает календарные дни', () => {
    const a = new Date(2026, 9, 20, 23, 0).getTime();
    const b = new Date(2026, 9, 22, 1, 0).getTime();
    expect(daysSince(a, b)).toBe(2);
    expect(daysSince(b, b)).toBe(0);
  });
});
