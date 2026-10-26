import {
  CandidatePool,
  parseHeader,
  parseRow,
  passesFilters,
  pickBalanced,
  rowToPuzzle,
  setIdFor,
  validatePuzzle,
  type GeneratorParams,
  type PuzzleSetFile,
} from '@wp/core';

export interface GenerateResult {
  file: PuzzleSetFile;
  scanned: number;
  matched: number;
  invalid: number;
  /** Не хватило задач после фильтров и балансировки. */
  shortBy: number;
}

export interface GenerateOptions {
  name?: string;
  createdAt: Date;
  /** Во сколько раз пул кандидатов больше --count: запас под балансировку тем. */
  poolFactor?: number;
  onProgress?: (scanned: number, matched: number) => void;
}

/**
 * Один проход по CSV: фильтры → пул кандидатов с наименьшим hash(seed:id) → балансировка тем.
 * Память ограничена размером пула; порядок строк в файле не влияет на результат.
 */
export async function generate(
  lines: AsyncIterable<string>,
  params: GeneratorParams,
  opts: GenerateOptions,
): Promise<GenerateResult> {
  const pool = new CandidatePool(params.seed, Math.max(params.count, params.count * (opts.poolFactor ?? 25)));
  let header: ReturnType<typeof parseHeader> | null = null;
  let scanned = 0;
  let matched = 0;

  for await (const line of lines) {
    if (!line) continue;
    if (!header) {
      header = parseHeader(line);
      continue;
    }
    scanned++;
    const row = parseRow(line, header);
    if (row && passesFilters(row, params)) {
      matched++;
      pool.offer(rowToPuzzle(row));
    }
    if (opts.onProgress && scanned % 250_000 === 0) opts.onProgress(scanned, matched);
  }
  if (!header) throw new Error('Пустой вход: нет заголовка CSV');

  // Проверка по правилам — только для принятых кандидатов, это дёшево.
  const { puzzles, rejected } = pickBalanced(
    pool.sorted(),
    params.count,
    params.maxThemeShare,
    (p) => validatePuzzle(p) === null,
  );
  const name = opts.name ?? `Тактика ${params.minRating}–${params.maxRating} · ${puzzles.length}`;
  return {
    scanned,
    matched,
    invalid: rejected,
    shortBy: Math.max(0, params.count - puzzles.length),
    file: {
      id: setIdFor(params, puzzles),
      name,
      createdAt: opts.createdAt.toISOString(),
      params: { ...params },
      puzzles,
    },
  };
}
