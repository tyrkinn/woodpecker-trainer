import { validatePuzzle } from './puzzle.ts';
import { sortByRating } from './select.ts';
import type { Attempt, Cycle, Puzzle, PuzzleSetFile, StoredSet } from './types.ts';
import { DEFAULT_SETTINGS } from './types.ts';

export interface ParsedSet {
  set: StoredSet;
  puzzles: Puzzle[];
  skipped: { id: string; reason: string }[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Проверяет JSON набора и готовит его к записи. Битые задачи пропускаются с причиной. */
export function parseSetFile(raw: unknown, now: number): ParsedSet {
  if (!isObj(raw)) throw new Error('Файл набора: ожидается JSON-объект');
  const { id, name, createdAt, params, puzzles } = raw as Partial<PuzzleSetFile>;
  if (typeof id !== 'string' || !id) throw new Error('Файл набора: нет поля id');
  if (!Array.isArray(puzzles) || puzzles.length === 0) throw new Error('Файл набора: пустой список puzzles');

  const ok: Puzzle[] = [];
  const skipped: ParsedSet['skipped'] = [];
  const seen = new Set<string>();
  for (const p of puzzles as unknown[]) {
    if (!isObj(p) || typeof p.id !== 'string' || typeof p.fen !== 'string' || !Array.isArray(p.moves)) {
      skipped.push({ id: isObj(p) ? String(p.id) : '?', reason: 'неверный формат' });
      continue;
    }
    if (seen.has(p.id)) continue;
    const puzzle: Puzzle = {
      id: p.id,
      fen: p.fen,
      moves: (p.moves as unknown[]).map(String),
      rating: Number(p.rating) || 0,
      themes: Array.isArray(p.themes) ? (p.themes as unknown[]).map(String) : [],
      gameUrl: typeof p.gameUrl === 'string' ? p.gameUrl : '',
    };
    const err = validatePuzzle(puzzle);
    if (err) {
      skipped.push({ id: puzzle.id, reason: err });
      continue;
    }
    seen.add(puzzle.id);
    ok.push(puzzle);
  }
  if (ok.length === 0) throw new Error('Файл набора: ни одной корректной задачи');
  const ordered = sortByRating(ok);
  return {
    puzzles: ordered,
    skipped,
    set: {
      id,
      name: typeof name === 'string' && name ? name : id,
      params: isObj(params) ? params : {},
      puzzleIds: ordered.map((p) => p.id),
      createdAt: typeof createdAt === 'string' ? createdAt : new Date(now).toISOString(),
      importedAt: now,
      settings: { ...DEFAULT_SETTINGS },
    },
  };
}

export const BACKUP_KIND = 'woodpecker-backup';
export const BACKUP_VERSION = 1;

export interface Backup {
  kind: typeof BACKUP_KIND;
  version: number;
  exportedAt: string;
  puzzles: Puzzle[];
  sets: StoredSet[];
  cycles: Cycle[];
  attempts: Attempt[];
}

export function makeBackup(data: Omit<Backup, 'kind' | 'version' | 'exportedAt'>, now: number): Backup {
  return { kind: BACKUP_KIND, version: BACKUP_VERSION, exportedAt: new Date(now).toISOString(), ...data };
}

export function parseBackup(raw: unknown): Backup {
  if (!isObj(raw) || raw.kind !== BACKUP_KIND) throw new Error('Это не файл бэкапа Woodpecker');
  if (typeof raw.version !== 'number' || raw.version > BACKUP_VERSION) {
    throw new Error(`Бэкап из более новой версии приложения (v${String(raw.version)})`);
  }
  for (const k of ['puzzles', 'sets', 'cycles', 'attempts'] as const) {
    if (!Array.isArray(raw[k])) throw new Error(`Бэкап повреждён: нет ${k}`);
  }
  return raw as unknown as Backup;
}
