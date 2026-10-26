import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  DEFAULT_PARAMS,
  isMotif,
  parseHeader,
  parseRow,
  passesFilters,
  selectSet,
  themeCap,
  type GeneratorParams,
  type LichessRow,
} from '@wp/core';
import { generate } from '../src/generate.ts';
import { openSource } from '../src/source.ts';
import { parseCli } from '../src/cli.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/puzzles.csv', import.meta.url));
const csv = readFileSync(FIXTURE, 'utf8').trim().split('\n');
const header = parseHeader(csv[0]!);
const rows: LichessRow[] = csv.slice(1).map((l) => parseRow(l, header)!);
const byId = (id: string) => rows.find((r) => r.id === id)!;

const P = (over: Partial<GeneratorParams> = {}): GeneratorParams => ({
  ...DEFAULT_PARAMS,
  count: 10,
  maxThemeShare: 1,
  seed: '42',
  ...over,
});

describe('разбор CSV', () => {
  it('сверяет заголовок и разбирает строки', () => {
    expect(rows).toHaveLength(49);
    const g = byId('G001');
    expect(g.moves).toEqual(['a7a6', 'e2e8', 'c8e8', 'e1e8']);
    expect(g.themes).toEqual(['pin', 'short', 'middlegame']);
    expect(g.nbPlays).toBe(1500);
  });

  it('падает с понятной ошибкой на чужом заголовке', () => {
    expect(() => parseHeader('id,fen,moves')).toThrow(/Missing: PuzzleId/);
  });
});

describe('фильтры', () => {
  const base = P();
  it.each([
    ['LOW', 'рейтинг ниже min'],
    ['HIGH', 'рейтинг выше max'],
    ['UNPOP', 'popularity'],
    ['FEW', 'nbPlays'],
    ['RD', 'rating deviation'],
    ['LONG', 'max-user-moves'],
  ])('%s отсекается (%s)', (id) => {
    expect(passesFilters(byId(id), base)).toBe(false);
  });

  it('нормальная задача проходит', () => {
    expect(passesFilters(byId('G010'), base)).toBe(true);
  });

  it('границы рейтинга включительны', () => {
    expect(passesFilters(byId('G001'), P({ minRating: 1680, maxRating: 1680 }))).toBe(true);
  });

  it('--max-user-moves считает только ходы пользователя', () => {
    expect(passesFilters(byId('G001'), P({ maxUserMoves: 2 }))).toBe(true);
    expect(passesFilters(byId('G001'), P({ maxUserMoves: 1 }))).toBe(false);
    expect(passesFilters(byId('LONG'), P({ maxUserMoves: 5 }))).toBe(true);
  });

  it('--themes и --exclude-themes', () => {
    expect(passesFilters(byId('ZUG'), P({ themes: ['zugzwang', 'pin'] }))).toBe(true);
    expect(passesFilters(byId('G000'), P({ themes: ['zugzwang'] }))).toBe(false);
    expect(passesFilters(byId('ZUG'), P({ excludeThemes: ['endgame'] }))).toBe(false);
  });
});

describe('выбор набора', () => {
  it('детерминизм: тот же seed — тот же набор, другой seed — другой', () => {
    const a = selectSet(rows, P()).map((p) => p.id);
    const b = selectSet([...rows].reverse(), P()).map((p) => p.id);
    const c = selectSet(rows, P({ seed: '43' })).map((p) => p.id);
    expect(a).toHaveLength(10);
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
  });

  it('сортировка по рейтингу по возрастанию', () => {
    const r = selectSet(rows, P({ count: 30 })).map((p) => p.rating);
    expect(r).toEqual([...r].sort((x, y) => x - y));
  });

  it('доля одной темы не больше --max-theme-share; мета-теги не балансируются', () => {
    const count = 20;
    const share = 0.15;
    const set = selectSet(rows, P({ count, maxThemeShare: share }));
    const cap = themeCap(count, share);
    const counts = new Map<string, number>();
    for (const p of set) for (const t of p.themes) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const [t, n] of counts) if (isMotif(t)) expect(n).toBeLessThanOrEqual(cap);
    // мета-тег short встречается чаще лимита — так и должно быть
    expect(counts.get('short') ?? 0).toBeGreaterThan(cap);
    // Лимит реально ограничивает: 5 частых мотивов × 3 + ZUG + BAD + META (без мотивов) = 18 < 20.
    expect(set.length).toBe(18);
  });
});

describe('generate: потоковый проход', () => {
  async function run(input: string, params: GeneratorParams) {
    const src = await openSource(input);
    return generate(src.lines, params, { createdAt: src.sourceDate });
  }

  it('битые задачи отбрасываются после проверки по правилам', async () => {
    const res = await run(FIXTURE, P({ count: 100, themes: ['hangingPiece', 'fork'] }));
    expect(res.file.puzzles.map((p) => p.id)).not.toContain('BAD');
    expect(res.invalid).toBe(1);
    expect(res.scanned).toBe(49);
  });

  it('читает .csv.zst и даёт тот же файл, что и .csv; повторный запуск — тот же JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-'));
    const zst = join(dir, 'puzzles.csv.zst');
    writeFileSync(zst, zlib.zstdCompressSync(readFileSync(FIXTURE)));
    const created = new Date('2026-10-01T00:00:00Z');
    const lines = async (p: string) => (await openSource(p)).lines;
    const a = await generate(await lines(FIXTURE), P(), { createdAt: created });
    const b = await generate(await lines(zst), P(), { createdAt: created });
    const c = await generate(await lines(zst), P(), { createdAt: created });
    expect(JSON.stringify(b.file)).toBe(JSON.stringify(a.file));
    expect(JSON.stringify(c.file)).toBe(JSON.stringify(b.file));
    expect(a.file.puzzles[0]).toEqual({
      id: expect.any(String),
      fen: expect.any(String),
      moves: expect.any(Array),
      rating: expect.any(Number),
      themes: expect.any(Array),
      gameUrl: expect.stringContaining('lichess.org'),
    });
    expect(a.file.createdAt).toBe('2026-10-01T00:00:00.000Z');
  });

  // База Lichess — seekable zstd: каждому кадру предшествует skippable-кадр с его размером.
  function writeSeekable(path: string) {
    const csv = readFileSync(FIXTURE);
    const parts: Buffer[] = [];
    for (let i = 0; i < csv.length; i += 700) {
      const frame = zlib.zstdCompressSync(csv.subarray(i, i + 700));
      const skip = Buffer.alloc(12);
      skip.writeUInt32LE(0x184d2a50, 0);
      skip.writeUInt32LE(4, 4);
      skip.writeUInt32LE(frame.length, 8);
      parts.push(skip, frame);
    }
    writeFileSync(path, Buffer.concat(parts));
  }

  const hasZstdBin = spawnSync('zstd', ['--version'], { stdio: 'ignore' }).status === 0;

  it.each([
    ['js', true],
    ['bin', hasZstdBin],
  ] as const)('читает seekable .zst как у Lichess (распаковщик %s)', async (backend, available) => {
    if (!available) return;
    const dir = mkdtempSync(join(tmpdir(), 'wp-seek-'));
    const file = join(dir, 'lichess_db_puzzle.csv.zst');
    writeSeekable(file);
    const prev = process.env.WP_ZSTD;
    process.env.WP_ZSTD = backend;
    try {
      const created = new Date('2026-10-01T00:00:00Z');
      const plain = await generate((await openSource(FIXTURE)).lines, P(), { createdAt: created });
      const seek = await generate((await openSource(file)).lines, P(), { createdAt: created });
      expect(seek.scanned).toBe(49);
      expect(JSON.stringify(seek.file)).toBe(JSON.stringify(plain.file));
    } finally {
      if (prev === undefined) delete process.env.WP_ZSTD;
      else process.env.WP_ZSTD = prev;
    }
  });

  it('сообщает, если задач не хватило', async () => {
    const res = await run(FIXTURE, P({ count: 500 }));
    expect(res.shortBy).toBeGreaterThan(0);
  });
});

describe('CLI', () => {
  it('значения по умолчанию из ТЗ', () => {
    const c = parseCli(['--seed', '42', '--input', FIXTURE]);
    expect(c.params).toMatchObject({
      minRating: 1300,
      maxRating: 1700,
      count: 400,
      minPopularity: 80,
      minPlays: 500,
      maxRd: 80,
      maxUserMoves: 4,
      maxThemeShare: 0.15,
      themes: [],
    });
    expect(c.out).toBe('sets/base-1300.json');
  });

  it('seed обязателен', () => {
    expect(() => parseCli([])).toThrow(/--seed/);
  });

  it('темы списком', () => {
    const c = parseCli(['--seed', '1', '--themes', 'fork,pin', '--exclude-themes', 'mateIn1']);
    expect(c.params.themes).toEqual(['fork', 'pin']);
    expect(c.params.excludeThemes).toEqual(['mateIn1']);
  });
});
