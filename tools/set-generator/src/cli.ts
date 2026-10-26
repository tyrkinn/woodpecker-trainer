import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_PARAMS, summarizeSet, themeLabel, type GeneratorParams } from '@wp/core';
import { generate } from './generate.ts';
import { LICHESS_URL, openSource } from './source.ts';

const HELP = `Генератор набора задач Woodpecker из базы Lichess.

Использование:
  npx tsx tools/set-generator --seed 42 [опции]

Вход:
  --input <путь|url>       lichess_db_puzzle.csv.zst или .csv. По умолчанию — ./lichess_db_puzzle.csv.zst,
                           если файла нет — скачивание потоком с ${LICHESS_URL}

Отбор:
  --min-rating <n>         ${DEFAULT_PARAMS.minRating}
  --max-rating <n>         ${DEFAULT_PARAMS.maxRating}
  --count <n>              ${DEFAULT_PARAMS.count}
  --min-popularity <n>     ${DEFAULT_PARAMS.minPopularity}
  --min-plays <n>          ${DEFAULT_PARAMS.minPlays}
  --max-rd <n>             ${DEFAULT_PARAMS.maxRd}
  --max-user-moves <n>     ${DEFAULT_PARAMS.maxUserMoves}
  --themes <a,b>           только задачи хотя бы с одной из тем
  --exclude-themes <a,b>   без задач с этими темами
  --max-theme-share <x>    ${DEFAULT_PARAMS.maxThemeShare}
  --seed <s>               обязателен; тот же seed + параметры = тот же набор

Выход:
  --name <имя>             имя набора
  --out <путь>             sets/base-<min>.json
  --created-at <iso>       дата в файле; по умолчанию — дата данных (mtime файла / Last-Modified)
`;

function num(v: string | undefined, def: number, name: string): number {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name}: ожидается число, получено «${v}»`);
  return n;
}

const list = (v: string | undefined) =>
  v
    ? v
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

export function parseCli(argv: string[]): { params: GeneratorParams; input: string; out: string; name?: string; createdAt?: string; help: boolean } {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      input: { type: 'string' },
      'min-rating': { type: 'string' },
      'max-rating': { type: 'string' },
      count: { type: 'string' },
      'min-popularity': { type: 'string' },
      'min-plays': { type: 'string' },
      'max-rd': { type: 'string' },
      'max-user-moves': { type: 'string' },
      themes: { type: 'string' },
      'exclude-themes': { type: 'string' },
      'max-theme-share': { type: 'string' },
      seed: { type: 'string' },
      name: { type: 'string' },
      out: { type: 'string' },
      'created-at': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return { help: true } as never;
  if (!values.seed) throw new Error('--seed обязателен (например --seed 42). Подробнее: --help');

  const params: GeneratorParams = {
    minRating: num(values['min-rating'], DEFAULT_PARAMS.minRating, 'min-rating'),
    maxRating: num(values['max-rating'], DEFAULT_PARAMS.maxRating, 'max-rating'),
    count: num(values.count, DEFAULT_PARAMS.count, 'count'),
    minPopularity: num(values['min-popularity'], DEFAULT_PARAMS.minPopularity, 'min-popularity'),
    minPlays: num(values['min-plays'], DEFAULT_PARAMS.minPlays, 'min-plays'),
    maxRd: num(values['max-rd'], DEFAULT_PARAMS.maxRd, 'max-rd'),
    maxUserMoves: num(values['max-user-moves'], DEFAULT_PARAMS.maxUserMoves, 'max-user-moves'),
    themes: list(values.themes),
    excludeThemes: list(values['exclude-themes']),
    maxThemeShare: num(values['max-theme-share'], DEFAULT_PARAMS.maxThemeShare, 'max-theme-share'),
    seed: values.seed,
  };
  if (params.minRating > params.maxRating) throw new Error('--min-rating больше --max-rating');
  if (params.count < 1) throw new Error('--count должен быть ≥ 1');
  if (params.maxThemeShare <= 0 || params.maxThemeShare > 1) throw new Error('--max-theme-share в диапазоне (0, 1]');

  const input = values.input ?? (existsSync('lichess_db_puzzle.csv.zst') ? 'lichess_db_puzzle.csv.zst' : LICHESS_URL);
  const out = values.out ?? `sets/base-${params.minRating}.json`;
  const res: ReturnType<typeof parseCli> = { params, input, out, help: false };
  if (values.name) res.name = values.name;
  if (values['created-at']) res.createdAt = values['created-at'];
  return res;
}

const bar = (n: number, max: number, width = 30) => '█'.repeat(Math.max(1, Math.round((n / Math.max(1, max)) * width)));

export async function main(argv: string[]): Promise<number> {
  const cli = parseCli(argv);
  if (cli.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const t0 = Date.now();
  const src = await openSource(cli.input);
  const tty = process.stderr.isTTY;
  console.error(`Читаю ${src.label}…`);

  const genOpts: Parameters<typeof generate>[2] = {
    createdAt: cli.createdAt ? new Date(cli.createdAt) : src.sourceDate,
    onProgress: (scanned, matched) => {
      const pct = src.totalBytes ? ` ${((src.readBytes() / src.totalBytes) * 100).toFixed(0)}%` : '';
      const msg = `  ${(scanned / 1e6).toFixed(2)}M строк, подходит ${matched}${pct}`;
      if (tty) process.stderr.write(`\r${msg}   `);
    },
  };
  if (cli.name) genOpts.name = cli.name;
  const res = await generate(src.lines, cli.params, genOpts);
  if (tty) process.stderr.write('\n');

  const path = resolve(cli.out);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(res.file, null, 1) + '\n');

  const s = summarizeSet(res.file.puzzles);
  const lines = [
    '',
    `Набор «${res.file.name}» → ${cli.out}`,
    `  Задач: ${s.count}${res.shortBy ? `  (не хватило ${res.shortBy}: ослабь фильтры или --max-theme-share)` : ''}`,
    `  Просмотрено ${res.scanned.toLocaleString('ru')} строк, после фильтров ${res.matched.toLocaleString('ru')}` +
      (res.invalid ? `, отброшено битых ${res.invalid}` : ''),
    `  Рейтинг: ${s.minRating}–${s.maxRating}`,
    ...s.histogram.map((h) => `    ${h.from}–${h.to}  ${String(h.n).padStart(4)}  ${bar(h.n, Math.max(...s.histogram.map((x) => x.n)))}`),
    '  Топ-10 тем:',
    ...s.topThemes.map(
      (t) => `    ${t.theme.padEnd(18)} ${String(t.n).padStart(4)}  ${(t.share * 100).toFixed(1).padStart(5)}%  ${themeLabel(t.theme)}`,
    ),
    `  Готово за ${((Date.now() - t0) / 1000).toFixed(1)} с`,
    '',
  ];
  process.stdout.write(lines.join('\n'));
  return res.file.puzzles.length > 0 ? 0 : 2;
}
