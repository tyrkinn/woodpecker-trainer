import { isMotif } from './themes.ts';
import type { GeneratorParams, Puzzle } from './types.ts';

/** Строка базы Lichess после разбора. */
export interface LichessRow {
  id: string;
  fen: string;
  moves: string[];
  rating: number;
  ratingDeviation: number;
  popularity: number;
  nbPlays: number;
  themes: string[];
  gameUrl: string;
  openingTags: string[];
}

export const DEFAULT_PARAMS: Omit<GeneratorParams, 'seed'> = {
  minRating: 1300,
  maxRating: 1700,
  count: 400,
  minPopularity: 80,
  minPlays: 500,
  maxRd: 80,
  maxUserMoves: 4,
  themes: [],
  excludeThemes: [],
  maxThemeShare: 0.15,
};

export const REQUIRED_COLUMNS = [
  'PuzzleId',
  'FEN',
  'Moves',
  'Rating',
  'RatingDeviation',
  'Popularity',
  'NbPlays',
  'Themes',
  'GameUrl',
] as const;

/** Разбор строки CSV с поддержкой кавычек (в базе Lichess их нет, но лишним не будет). */
export function splitCsvLine(line: string): string[] {
  if (!line.includes('"')) return line.split(',');
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export type ColumnIndex = Record<(typeof REQUIRED_COLUMNS)[number] | 'OpeningTags', number>;

/** Сверяет заголовок CSV с ожидаемым. Бросает понятную ошибку, если колонок не хватает. */
export function parseHeader(line: string): ColumnIndex {
  const cols = splitCsvLine(line.replace(/^﻿/, '').trim());
  const idx = (name: string) => cols.indexOf(name);
  const missing = REQUIRED_COLUMNS.filter((c) => idx(c) < 0);
  if (missing.length) {
    throw new Error(`CSV header mismatch. Missing: ${missing.join(', ')}. Got: ${cols.join(', ')}`);
  }
  const res = {} as ColumnIndex;
  for (const c of REQUIRED_COLUMNS) res[c] = idx(c);
  res.OpeningTags = idx('OpeningTags');
  return res;
}

const splitSpaces = (s: string | undefined) => (s ? s.trim().split(/\s+/).filter(Boolean) : []);

export function parseRow(line: string, ix: ColumnIndex): LichessRow | null {
  const f = splitCsvLine(line);
  if (f.length < REQUIRED_COLUMNS.length) return null;
  const num = (i: number) => Number(f[i]);
  const row: LichessRow = {
    id: f[ix.PuzzleId] ?? '',
    fen: f[ix.FEN] ?? '',
    moves: splitSpaces(f[ix.Moves]),
    rating: num(ix.Rating),
    ratingDeviation: num(ix.RatingDeviation),
    popularity: num(ix.Popularity),
    nbPlays: num(ix.NbPlays),
    themes: splitSpaces(f[ix.Themes]),
    gameUrl: f[ix.GameUrl] ?? '',
    openingTags: ix.OpeningTags >= 0 ? splitSpaces(f[ix.OpeningTags]) : [],
  };
  if (!row.id || !row.fen || row.moves.length < 2 || !Number.isFinite(row.rating)) return null;
  return row;
}

/** Ходов пользователя в задаче: moves[0] — соперник, дальше пары «пользователь — ответ». */
export function userMoves(moves: string[]): number {
  return Math.floor(moves.length / 2);
}

export function passesFilters(r: LichessRow, p: Omit<GeneratorParams, 'seed' | 'count' | 'maxThemeShare'>): boolean {
  if (r.rating < p.minRating || r.rating > p.maxRating) return false;
  if (r.popularity < p.minPopularity) return false;
  if (r.nbPlays < p.minPlays) return false;
  if (r.ratingDeviation > p.maxRd) return false;
  if (userMoves(r.moves) > p.maxUserMoves) return false;
  if (p.themes.length && !p.themes.some((t) => r.themes.includes(t))) return false;
  if (p.excludeThemes.length && p.excludeThemes.some((t) => r.themes.includes(t))) return false;
  return true;
}

/** cyrb53 — быстрый 53-битный хеш строки. */
export function hash53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export interface Candidate {
  key: number;
  puzzle: Puzzle;
}

/**
 * Пул кандидатов ограниченного размера: держит `capacity` задач с наименьшим ключом hash(seed:id).
 * Ключ не зависит от порядка строк в файле, поэтому выбор детерминирован, а память ограничена.
 */
export class CandidatePool {
  private heap: Candidate[] = []; // max-heap по key
  seen = 0;

  constructor(
    private readonly seed: string,
    readonly capacity: number,
  ) {}

  offer(p: Puzzle): void {
    this.seen++;
    const key = hash53(`${this.seed}:${p.id}`);
    const h = this.heap;
    if (h.length < this.capacity) {
      h.push({ key, puzzle: p });
      this.up(h.length - 1);
    } else if (h.length > 0 && key < h[0]!.key) {
      h[0] = { key, puzzle: p };
      this.down(0);
    }
  }

  /** Кандидаты по возрастанию ключа. */
  sorted(): Candidate[] {
    return [...this.heap].sort((a, b) => a.key - b.key || a.puzzle.id.localeCompare(b.puzzle.id));
  }

  get size(): number {
    return this.heap.length;
  }

  private up(i: number) {
    const h = this.heap;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p]!.key >= h[i]!.key) break;
      [h[p], h[i]] = [h[i]!, h[p]!];
      i = p;
    }
  }

  private down(i: number) {
    const h = this.heap;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < h.length && h[l]!.key > h[m]!.key) m = l;
      if (r < h.length && h[r]!.key > h[m]!.key) m = r;
      if (m === i) break;
      [h[m], h[i]] = [h[i]!, h[m]!];
      i = m;
    }
  }
}

export function themeCap(count: number, share: number): number {
  return Math.max(1, Math.floor(count * share));
}

/**
 * Финальный выбор: идём по кандидатам в порядке ключа и берём задачу, только если ни один
 * тактический мотив не превысит долю `maxThemeShare`. Мета-теги не балансируются.
 * Результат отсортирован по рейтингу, от простого к сложному.
 */
export function pickBalanced(
  candidates: Candidate[],
  count: number,
  maxThemeShare: number,
  isValid: (p: Puzzle) => boolean = () => true,
): { puzzles: Puzzle[]; rejected: number } {
  const cap = themeCap(count, maxThemeShare);
  const used = new Map<string, number>();
  const out: Puzzle[] = [];
  let rejected = 0;
  for (const { puzzle } of candidates) {
    if (out.length >= count) break;
    const motifs = puzzle.themes.filter(isMotif);
    if (motifs.some((t) => (used.get(t) ?? 0) + 1 > cap)) continue;
    if (!isValid(puzzle)) {
      rejected++;
      continue;
    }
    for (const t of motifs) used.set(t, (used.get(t) ?? 0) + 1);
    out.push(puzzle);
  }
  return { puzzles: sortByRating(out), rejected };
}

export function sortByRating(ps: Puzzle[]): Puzzle[] {
  return [...ps].sort((a, b) => a.rating - b.rating || a.id.localeCompare(b.id));
}

export function rowToPuzzle(r: LichessRow): Puzzle {
  return { id: r.id, fen: r.fen, moves: r.moves, rating: r.rating, themes: r.themes, gameUrl: r.gameUrl };
}

/** Выбор набора из уже разобранных строк (используется в тестах и для маленьких входов). */
export function selectSet(rows: Iterable<LichessRow>, params: GeneratorParams, poolFactor = 25): Puzzle[] {
  const pool = new CandidatePool(params.seed, Math.max(params.count * poolFactor, params.count));
  for (const r of rows) if (passesFilters(r, params)) pool.offer(rowToPuzzle(r));
  return pickBalanced(pool.sorted(), params.count, params.maxThemeShare).puzzles;
}

export interface SetSummary {
  count: number;
  minRating: number;
  maxRating: number;
  histogram: { from: number; to: number; n: number }[];
  topThemes: { theme: string; n: number; share: number }[];
}

export function summarizeSet(ps: Puzzle[], bucket = 100, top = 10): SetSummary {
  const ratings = ps.map((p) => p.rating);
  const minR = ratings.length ? Math.min(...ratings) : 0;
  const maxR = ratings.length ? Math.max(...ratings) : 0;
  const hist = new Map<number, number>();
  for (const r of ratings) {
    const b = Math.floor(r / bucket) * bucket;
    hist.set(b, (hist.get(b) ?? 0) + 1);
  }
  const themes = new Map<string, number>();
  for (const p of ps) for (const t of p.themes) if (isMotif(t)) themes.set(t, (themes.get(t) ?? 0) + 1);
  return {
    count: ps.length,
    minRating: minR,
    maxRating: maxR,
    histogram: [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([from, n]) => ({ from, to: from + bucket - 1, n })),
    topThemes: [...themes.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, top)
      .map(([theme, n]) => ({ theme, n, share: ps.length ? n / ps.length : 0 })),
  };
}

/** Детерминированный id набора по параметрам и составу. */
export function setIdFor(params: GeneratorParams, puzzles: Puzzle[]): string {
  const sig = JSON.stringify(params) + '|' + puzzles.map((p) => p.id).join(',');
  return 'set-' + hash53(sig).toString(36);
}
