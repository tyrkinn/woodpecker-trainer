import { MIN_COEF, type Attempt, type Cycle, type SetSettings, type StoredSet } from './types.ts';

/** Цель цикла N+1 = активное время цикла N × коэффициент (не меньше 0.3). */
export function nextTargetMs(prevActiveMs: number, coef: number): number {
  const k = Math.max(MIN_COEF, Math.min(1, coef));
  return Math.round(prevActiveMs * k);
}

export function clampCoef(coef: number): number {
  if (!Number.isFinite(coef)) return 0.5;
  return Math.max(MIN_COEF, Math.min(1, coef));
}

/**
 * Таймер активного времени. Время приходит снаружи (`now`), поэтому таймер детерминирован и тестируем.
 * Пауза — сворачивание вкладки, блокировка телефона, кнопка.
 */
export class ActiveTimer {
  private base: number;
  private startedAt: number | null = null;

  constructor(baseMs = 0) {
    this.base = baseMs;
  }

  get running(): boolean {
    return this.startedAt !== null;
  }

  start(now: number): void {
    if (this.startedAt === null) this.startedAt = now;
  }

  pause(now: number): void {
    if (this.startedAt !== null) {
      this.base += Math.max(0, now - this.startedAt);
      this.startedAt = null;
    }
  }

  elapsed(now: number): number {
    return this.base + (this.startedAt === null ? 0 : Math.max(0, now - this.startedAt));
  }

  reset(baseMs = 0): void {
    this.base = baseMs;
    this.startedAt = null;
  }
}

/** Список задач цикла в порядке прохождения. */
export function cyclePuzzleIds(set: Pick<StoredSet, 'puzzleIds'>, cycle: Pick<Cycle, 'mode' | 'puzzleIds'>): string[] {
  return cycle.mode === 'errors' ? (cycle.puzzleIds ?? []) : set.puzzleIds;
}

export function fullCycles(cycles: Cycle[]): Cycle[] {
  return cycles.filter((c) => c.mode === 'full').sort((a, b) => a.number - b.number);
}

/** Незавершённый цикл (полный или прогон ошибок). Такой может быть максимум один. */
export function activeCycle(cycles: Cycle[]): Cycle | undefined {
  return cycles
    .filter((c) => c.finishedAt === null)
    .sort((a, b) => b.startedAt - a.startedAt)[0];
}

export function lastFinishedFull(cycles: Cycle[]): Cycle | undefined {
  return fullCycles(cycles)
    .filter((c) => c.finishedAt !== null)
    .at(-1);
}

export type NextCyclePlan =
  | { kind: 'start'; number: number; targetMs: number | null }
  | { kind: 'busy'; cycle: Cycle }
  | { kind: 'done'; completed: number };

/** Можно ли начать следующий полный цикл, и с какой целью. */
export function planNextCycle(cycles: Cycle[], settings: SetSettings): NextCyclePlan {
  const busy = activeCycle(cycles);
  if (busy) return { kind: 'busy', cycle: busy };
  const full = fullCycles(cycles);
  const completed = full.length;
  if (completed >= settings.maxCycles) return { kind: 'done', completed };
  const prev = full.at(-1);
  return {
    kind: 'start',
    number: completed + 1,
    targetMs: prev ? nextTargetMs(prev.activeMs, settings.coef) : null,
  };
}

/** Задачи, проваленные в цикле, в порядке набора. */
export function failedPuzzleIds(order: string[], attempts: Attempt[], cycleId: string): string[] {
  const failed = new Set(attempts.filter((a) => a.cycleId === cycleId && !a.correct).map((a) => a.puzzleId));
  return order.filter((id) => failed.has(id));
}

let idCounter = 0;
export function newId(now: number = Date.now()): string {
  idCounter = (idCounter + 1) % 1e6;
  return `${now.toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createFullCycle(setId: string, plan: Extract<NextCyclePlan, { kind: 'start' }>, now: number): Cycle {
  return {
    id: newId(now),
    setId,
    number: plan.number,
    mode: 'full',
    targetMs: plan.targetMs,
    activeMs: 0,
    cursor: 0,
    startedAt: now,
    finishedAt: null,
  };
}

/**
 * Прогон ошибок последнего завершённого полного цикла. Не считается циклом и не влияет на цель.
 * Возвращает null, если ошибок нет.
 */
export function createErrorsRun(set: StoredSet, cycles: Cycle[], attempts: Attempt[], now: number): Cycle | null {
  const last = lastFinishedFull(cycles);
  if (!last) return null;
  const ids = failedPuzzleIds(set.puzzleIds, attempts, last.id);
  if (ids.length === 0) return null;
  return {
    id: newId(now),
    setId: set.id,
    number: last.number,
    mode: 'errors',
    targetMs: null,
    activeMs: 0,
    cursor: 0,
    puzzleIds: ids,
    startedAt: now,
    finishedAt: null,
  };
}

/**
 * Результат задачи: новая попытка и обновлённый цикл. Пишутся в базу одной транзакцией.
 * `activeMs` — общее активное время цикла на момент ответа.
 */
export function recordResult(
  cycle: Cycle,
  totalPuzzles: number,
  r: { puzzleId: string; correct: boolean; timeMs: number; wrongMove: string | null },
  activeMs: number,
  now: number,
): { cycle: Cycle; attempt: Attempt } {
  const cursor = Math.min(cycle.cursor + 1, totalPuzzles);
  return {
    attempt: {
      cycleId: cycle.id,
      puzzleId: r.puzzleId,
      correct: r.correct,
      timeMs: Math.max(0, Math.round(r.timeMs)),
      wrongMove: r.wrongMove,
      at: now,
    },
    cycle: {
      ...cycle,
      cursor,
      activeMs: Math.max(cycle.activeMs, Math.round(activeMs)),
      finishedAt: cursor >= totalPuzzles ? now : null,
    },
  };
}

/** Куда возвращаться после закрытия приложения. */
export function resumePoint(set: StoredSet, cycle: Cycle): { index: number; puzzleId: string | null; total: number } {
  const ids = cyclePuzzleIds(set, cycle);
  const index = Math.min(cycle.cursor, ids.length);
  return { index, puzzleId: ids[index] ?? null, total: ids.length };
}

/** Сколько полных дней прошло с последней активности. */
export function daysSince(ts: number, now: number): number {
  const day = 24 * 60 * 60 * 1000;
  const a = new Date(ts);
  const b = new Date(now);
  const da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.max(0, Math.round((db - da) / day));
}
