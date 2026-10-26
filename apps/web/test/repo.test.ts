import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { PuzzleSession, validatePuzzle } from '@wp/core';
import { WoodpeckerDB, useDb } from '../src/lib/db.ts';
import {
  exportAll,
  flushActiveMs,
  importAll,
  importSet,
  loadBundle,
  saveResult,
  startErrorsRun,
  startNextCycle,
  updateSettings,
} from '../src/lib/repo.ts';
import { BUILTIN_SETS, DEMO_SET } from '../src/lib/demo.ts';
import { readFileSync } from 'node:fs';
import { parseSetFile } from '@wp/core';

let n = 0;
beforeEach(() => {
  useDb(new WoodpeckerDB(`test-${n++}`));
});

describe('демо-набор', () => {
  it('все задачи корректны и решаются ходами из базы, последний ход — мат или выигрыш', () => {
    for (const p of DEMO_SET.puzzles) {
      expect(validatePuzzle(p), p.id).toBeNull();
      const s = new PuzzleSession(p);
      s.playSetup();
      for (let i = 1; i < p.moves.length; i += 2) {
        const r = s.tryMove(p.moves[i]!);
        expect(r.kind, `${p.id} ход ${i}`).toBe(i === p.moves.length - 1 ? 'solved' : 'continue');
      }
      if (p.themes.some((t) => t.startsWith('mateIn'))) expect(new Chess(s.fen).isCheckmate(), p.id).toBe(true);
    }
  });
});

describe('встроенные наборы Lichess', () => {
  it.each(BUILTIN_SETS.map((b) => [b.label, b] as const))('%s: id совпадает с файлом, все 400 задач решаются ходами базы', (_l, b) => {
    const raw = JSON.parse(readFileSync(new URL(b.url.replace('./', '../public/'), import.meta.url), 'utf8'));
    expect(raw.id).toBe(b.id);
    const parsed = parseSetFile(raw, 0);
    expect(parsed.puzzles).toHaveLength(400);
    expect(parsed.skipped).toEqual([]);
    for (const p of parsed.puzzles) {
      const s = new PuzzleSession(p);
      s.playSetup();
      for (let i = 1; i < p.moves.length; i += 2) expect(s.tryMove(p.moves[i]!).kind, p.id).not.toMatch(/wrong|illegal/);
      expect(s.isFinished, p.id).toBe(true);
    }
  });
});

describe('repo: циклы и восстановление', () => {
  it('импорт → цикл → сохранение после каждой задачи → возобновление с cursor', async () => {
    const rep = await importSet(DEMO_SET, 1000);
    expect(rep.added).toBe(8);
    const setId = rep.set.id;

    const c1 = await startNextCycle(setId, 2000);
    expect(c1).toMatchObject({ number: 1, targetMs: null, cursor: 0 });
    // Повторный старт при незавершённом цикле возвращает тот же цикл.
    expect((await startNextCycle(setId, 2001)).id).toBe(c1.id);

    const ids = rep.set.puzzleIds;
    await saveResult(c1.id, { puzzleId: ids[0]!, correct: true, timeMs: 4000, wrongMove: null }, 5000, 3000);
    await saveResult(c1.id, { puzzleId: ids[1]!, correct: false, timeMs: 9000, wrongMove: 'h2h3' }, 15000, 4000);
    // Двойная запись той же задачи игнорируется.
    await saveResult(c1.id, { puzzleId: ids[1]!, correct: true, timeMs: 1, wrongMove: null }, 16000, 4001);

    // «Закрыли приложение»: новый экземпляр БД с тем же именем.
    const b = (await loadBundle(setId))!;
    const cyc = b.cycles.find((c) => c.id === c1.id)!;
    expect(cyc.cursor).toBe(2);
    expect(cyc.activeMs).toBe(15000);
    expect(b.attempts).toHaveLength(2);

    await flushActiveMs(c1.id, 20000);
    await flushActiveMs(c1.id, 10); // не уменьшает
    expect((await loadBundle(setId))!.cycles[0]!.activeMs).toBe(20000);

    let last = cyc;
    for (let i = 2; i < ids.length; i++) {
      last = await saveResult(c1.id, { puzzleId: ids[i]!, correct: i !== 5, timeMs: 1000, wrongMove: i === 5 ? 'a1a2' : null }, 20000 + i * 1000, 5000 + i);
    }
    expect(last.finishedAt).not.toBeNull();

    // Цикл 2: цель = половина активного времени цикла 1.
    const c2 = await startNextCycle(setId, 9000);
    expect(c2).toMatchObject({ number: 2, targetMs: Math.round(last.activeMs * 0.5) });
  });

  it('прогон ошибок берёт провалы последнего завершённого цикла и не меняет цель', async () => {
    const { set } = await importSet(DEMO_SET, 1);
    await updateSettings(set.id, { coef: 0.1 }); // зажмётся до 0.3
    const c1 = await startNextCycle(set.id, 2);
    for (const [i, id] of set.puzzleIds.entries()) {
      await saveResult(c1.id, { puzzleId: id, correct: i % 3 !== 0, timeMs: 1000, wrongMove: null }, (i + 1) * 1000, 10 + i);
    }
    const run = (await startErrorsRun(set.id, 100))!;
    expect(run.mode).toBe('errors');
    expect(run.puzzleIds).toEqual([set.puzzleIds[0], set.puzzleIds[3], set.puzzleIds[6]]);
    for (const id of run.puzzleIds!) await saveResult(run.id, { puzzleId: id, correct: true, timeMs: 1, wrongMove: null }, 99_999, 200);
    const c2 = await startNextCycle(set.id, 300);
    expect(c2.targetMs).toBe(Math.round(8000 * 0.3));
  });

  it('бэкап: экспорт и полное восстановление', async () => {
    const { set } = await importSet(DEMO_SET, 1);
    const c = await startNextCycle(set.id, 2);
    await saveResult(c.id, { puzzleId: set.puzzleIds[0]!, correct: true, timeMs: 1, wrongMove: null }, 10, 3);
    const backup = JSON.parse(JSON.stringify(await exportAll(4)));

    useDb(new WoodpeckerDB(`restore-${n++}`));
    const res = await importAll(backup);
    expect(res).toEqual({ sets: 1, attempts: 1 });
    const b = (await loadBundle(set.id))!;
    expect(b.cycles[0]!.cursor).toBe(1);
    expect(b.puzzles.size).toBe(8);
    await expect(importAll({ kind: 'nope' })).rejects.toThrow();
  });
});
