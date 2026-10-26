/** Задача в формате набора. `moves[0]` — ход соперника, дальше чередуются ход пользователя и ответ. */
export interface Puzzle {
  id: string;
  /** Позиция ДО хода соперника (`moves[0]`). */
  fen: string;
  /** Ходы в UCI. */
  moves: string[];
  rating: number;
  themes: string[];
  gameUrl: string;
}

export interface GeneratorParams {
  minRating: number;
  maxRating: number;
  count: number;
  minPopularity: number;
  minPlays: number;
  maxRd: number;
  maxUserMoves: number;
  themes: string[];
  excludeThemes: string[];
  maxThemeShare: number;
  seed: string;
}

/** JSON-файл набора, который выдаёт генератор и импортирует тренажёр. */
export interface PuzzleSetFile {
  id: string;
  name: string;
  createdAt: string;
  params: Partial<GeneratorParams> & Record<string, unknown>;
  puzzles: Puzzle[];
}

export interface SetSettings {
  /** Множитель цели следующего цикла. По умолчанию 0.5, минимум 0.3. */
  coef: number;
  /** Максимум полных циклов. По умолчанию 7. */
  maxCycles: number;
}

export interface StoredSet {
  id: string;
  name: string;
  params: PuzzleSetFile['params'];
  /** Порядок прохождения — по рейтингу. */
  puzzleIds: string[];
  createdAt: string;
  importedAt: number;
  settings: SetSettings;
}

export type CycleMode = 'full' | 'errors';

export interface Cycle {
  id: string;
  setId: string;
  /** Номер полного цикла. Для прогона ошибок — номер цикла, ошибки которого прогоняются. */
  number: number;
  mode: CycleMode;
  /** Цель по активному времени. null — без цели (цикл 1 и прогон ошибок). */
  targetMs: number | null;
  activeMs: number;
  /** Индекс текущей (ещё не решённой) задачи. */
  cursor: number;
  /** Снимок списка задач для прогона ошибок. Для full — берётся из набора. */
  puzzleIds?: string[];
  startedAt: number;
  finishedAt: number | null;
}

export interface Attempt {
  id?: number;
  cycleId: string;
  puzzleId: string;
  correct: boolean;
  timeMs: number;
  wrongMove: string | null;
  at: number;
}

export const DEFAULT_SETTINGS: SetSettings = { coef: 0.5, maxCycles: 7 };
export const MIN_COEF = 0.3;
