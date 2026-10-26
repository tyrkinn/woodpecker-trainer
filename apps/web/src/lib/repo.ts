import {
  activeCycle,
  clampCoef,
  createErrorsRun,
  createFullCycle,
  makeBackup,
  parseBackup,
  parseSetFile,
  planNextCycle,
  recordResult,
  cyclePuzzleIds,
  type Attempt,
  type Backup,
  type Cycle,
  type Puzzle,
  type SetSettings,
  type StoredSet,
} from '@wp/core';
import { db } from './db.ts';

export interface SetBundle {
  set: StoredSet;
  puzzles: Map<string, Puzzle>;
  cycles: Cycle[];
  attempts: Attempt[];
}

const CURRENT_KEY = 'wp.currentSet';

export function rememberCurrentSet(id: string): void {
  try {
    localStorage.setItem(CURRENT_KEY, id);
  } catch {
    /* приватный режим — не страшно */
  }
}

function rememberedSet(): string | null {
  try {
    return localStorage.getItem(CURRENT_KEY);
  } catch {
    return null;
  }
}

export async function listSets(): Promise<StoredSet[]> {
  const sets = await db().sets.toArray();
  return sets.sort((a, b) => b.importedAt - a.importedAt);
}

/** Текущий набор: запомненный, иначе тот, где была последняя активность, иначе последний импортированный. */
export async function currentSetId(): Promise<string | null> {
  const remembered = rememberedSet();
  if (remembered && (await db().sets.get(remembered))) return remembered;
  const cycles = await db().cycles.toArray();
  const latest = cycles.sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt))[0];
  if (latest) return latest.setId;
  return (await listSets())[0]?.id ?? null;
}

export async function loadBundle(setId: string): Promise<SetBundle | null> {
  const d = db();
  const set = await d.sets.get(setId);
  if (!set) return null;
  const [puzzles, cycles] = await Promise.all([d.puzzles.bulkGet(set.puzzleIds), d.cycles.where('setId').equals(setId).toArray()]);
  const ids = cycles.map((c) => c.id);
  const attempts = ids.length ? await d.attempts.where('cycleId').anyOf(ids).toArray() : [];
  const map = new Map<string, Puzzle>();
  for (const p of puzzles) if (p) map.set(p.id, p);
  return { set, puzzles: map, cycles, attempts };
}

export interface ImportReport {
  set: StoredSet;
  added: number;
  skipped: { id: string; reason: string }[];
  replaced: boolean;
}

/** Импорт набора из JSON генератора. Повторный импорт того же id обновляет задачи, но не трогает циклы. */
export async function importSet(raw: unknown, now = Date.now()): Promise<ImportReport> {
  const parsed = parseSetFile(raw, now);
  const d = db();
  let replaced = false;
  await d.transaction('rw', d.puzzles, d.sets, async () => {
    const existing = await d.sets.get(parsed.set.id);
    replaced = !!existing;
    await d.puzzles.bulkPut(parsed.puzzles);
    await d.sets.put(existing ? { ...parsed.set, settings: existing.settings, importedAt: existing.importedAt } : parsed.set);
  });
  rememberCurrentSet(parsed.set.id);
  return { set: parsed.set, added: parsed.puzzles.length, skipped: parsed.skipped, replaced };
}

export async function updateSettings(setId: string, s: Partial<SetSettings>): Promise<void> {
  const d = db();
  await d.transaction('rw', d.sets, async () => {
    const set = await d.sets.get(setId);
    if (!set) return;
    const next: SetSettings = { ...set.settings, ...s };
    next.coef = clampCoef(next.coef);
    next.maxCycles = Math.max(1, Math.min(20, Math.round(next.maxCycles)));
    await d.sets.put({ ...set, settings: next });
  });
}

/** Начать следующий полный цикл. Бросает, если текущий не завершён или лимит циклов исчерпан. */
export async function startNextCycle(setId: string, now = Date.now()): Promise<Cycle> {
  const d = db();
  return d.transaction('rw', d.sets, d.cycles, async () => {
    const set = await d.sets.get(setId);
    if (!set) throw new Error('Набор не найден');
    const cycles = await d.cycles.where('setId').equals(setId).toArray();
    const plan = planNextCycle(cycles, set.settings);
    if (plan.kind === 'busy') return plan.cycle;
    if (plan.kind === 'done') throw new Error(`Все ${plan.completed} циклов пройдены`);
    const c = createFullCycle(setId, plan, now);
    await d.cycles.add(c);
    return c;
  });
}

export async function startErrorsRun(setId: string, now = Date.now()): Promise<Cycle | null> {
  const d = db();
  return d.transaction('rw', d.sets, d.cycles, d.attempts, async () => {
    const set = await d.sets.get(setId);
    if (!set) return null;
    const cycles = await d.cycles.where('setId').equals(setId).toArray();
    const busy = activeCycle(cycles);
    if (busy) return busy.mode === 'errors' ? busy : null;
    const attempts = await d.attempts.where('cycleId').anyOf(cycles.map((c) => c.id)).toArray();
    const run = createErrorsRun(set, cycles, attempts, now);
    if (run) await d.cycles.add(run);
    return run;
  });
}

/** Бросить прогон ошибок: он не влияет на цели, поэтому просто закрываем его. */
export async function abandonErrorsRun(cycleId: string, now = Date.now()): Promise<void> {
  const d = db();
  await d.transaction('rw', d.cycles, async () => {
    const c = await d.cycles.get(cycleId);
    if (c && c.mode === 'errors' && c.finishedAt === null) await d.cycles.put({ ...c, finishedAt: now });
  });
}

/**
 * Результат задачи: попытка и обновлённые cursor/activeMs пишутся одной транзакцией.
 * Обрыв в любой момент теряет максимум текущую задачу.
 */
export async function saveResult(
  cycleId: string,
  r: { puzzleId: string; correct: boolean; timeMs: number; wrongMove: string | null },
  activeMs: number,
  now = Date.now(),
): Promise<Cycle> {
  const d = db();
  return d.transaction('rw', d.cycles, d.attempts, d.sets, async () => {
    const cycle = await d.cycles.get(cycleId);
    if (!cycle) throw new Error('Цикл не найден');
    if (cycle.finishedAt !== null) return cycle;
    const set = await d.sets.get(cycle.setId);
    if (!set) throw new Error('Набор не найден');
    const ids = cyclePuzzleIds(set, cycle);
    if (ids[cycle.cursor] !== r.puzzleId) {
      // Повторная запись той же задачи (двойной тап, гонка) — игнорируем.
      return cycle;
    }
    const res = recordResult(cycle, ids.length, r, activeMs, now);
    await d.attempts.add(res.attempt);
    await d.cycles.put(res.cycle);
    return res.cycle;
  });
}

/** Сохранить накопленное активное время без продвижения (при паузе/сворачивании). */
export async function flushActiveMs(cycleId: string, activeMs: number): Promise<void> {
  const d = db();
  await d.transaction('rw', d.cycles, async () => {
    const c = await d.cycles.get(cycleId);
    if (c && c.finishedAt === null && activeMs > c.activeMs) await d.cycles.put({ ...c, activeMs: Math.round(activeMs) });
  });
}

export async function deleteSet(setId: string): Promise<void> {
  const d = db();
  await d.transaction('rw', d.sets, d.cycles, d.attempts, d.puzzles, async () => {
    const set = await d.sets.get(setId);
    if (!set) return;
    const cycles = await d.cycles.where('setId').equals(setId).primaryKeys();
    await d.attempts.where('cycleId').anyOf(cycles).delete();
    await d.cycles.bulkDelete(cycles);
    await d.sets.delete(setId);
    // Задачи удаляем, только если они не нужны другим наборам.
    const others = await d.sets.toArray();
    const keep = new Set(others.flatMap((s) => s.puzzleIds));
    await d.puzzles.bulkDelete(set.puzzleIds.filter((id) => !keep.has(id)));
  });
}

export async function exportAll(now = Date.now()): Promise<Backup> {
  const d = db();
  const [puzzles, sets, cycles, attempts] = await Promise.all([
    d.puzzles.toArray(),
    d.sets.toArray(),
    d.cycles.toArray(),
    d.attempts.toArray(),
  ]);
  return makeBackup({ puzzles, sets, cycles, attempts }, now);
}

/** Полная замена базы содержимым бэкапа. */
export async function importAll(raw: unknown): Promise<{ sets: number; attempts: number }> {
  const b = parseBackup(raw);
  const d = db();
  await d.transaction('rw', d.puzzles, d.sets, d.cycles, d.attempts, async () => {
    await Promise.all([d.puzzles.clear(), d.sets.clear(), d.cycles.clear(), d.attempts.clear()]);
    await d.puzzles.bulkPut(b.puzzles);
    await d.sets.bulkPut(b.sets);
    await d.cycles.bulkPut(b.cycles);
    await d.attempts.bulkPut(b.attempts);
  });
  return { sets: b.sets.length, attempts: b.attempts.length };
}
