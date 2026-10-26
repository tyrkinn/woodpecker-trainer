import Dexie, { type EntityTable } from 'dexie';
import type { Attempt, Cycle, Puzzle, StoredSet } from '@wp/core';

/**
 * Схема IndexedDB. Каждое изменение схемы — новая версия с миграцией, старые версии не трогаем:
 *
 *   this.version(2).stores({ ... }).upgrade(async (tx) => { ... });
 */
export class WoodpeckerDB extends Dexie {
  puzzles!: EntityTable<Puzzle, 'id'>;
  sets!: EntityTable<StoredSet, 'id'>;
  cycles!: EntityTable<Cycle, 'id'>;
  attempts!: EntityTable<Attempt, 'id'>;

  constructor(name = 'woodpecker') {
    super(name);
    this.version(1).stores({
      puzzles: 'id',
      sets: 'id',
      cycles: 'id, setId, [setId+number]',
      attempts: '++id, cycleId, puzzleId',
    });
  }
}

let instance: WoodpeckerDB | null = null;

export function db(): WoodpeckerDB {
  return (instance ??= new WoodpeckerDB());
}

/** Для тестов. */
export function useDb(d: WoodpeckerDB): void {
  instance = d;
}
