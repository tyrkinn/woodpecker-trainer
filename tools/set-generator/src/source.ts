import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { Readable, Transform, type TransformCallback } from 'node:stream';

export const LICHESS_URL = 'https://database.lichess.org/lichess_db_puzzle.csv.zst';

export interface LineSource {
  lines: AsyncIterable<string>;
  /** Дата данных: mtime файла или Last-Modified. Делает createdAt детерминированным. */
  sourceDate: Date;
  /** Байты сжатого/сырого входа, если известны (для прогресса). */
  totalBytes: number | null;
  /** Счётчик прочитанных байт входа. */
  readBytes: () => number;
  label: string;
}

export type ZstdBackend = 'bin' | 'js';

/**
 * Какой распаковщик использовать. База Lichess — seekable zstd: перед кадрами идут skippable-кадры.
 * Встроенный в Node потоковый zstd на них ломается (Node 22 молча отдаёт 0 байт, Node 26 бросает
 * «Unknown frame descriptor»), поэтому он не используется. Порядок: системный `zstd`, затем fzstd.
 * Переопределяется переменной WP_ZSTD=bin|js.
 */
export function pickZstdBackend(): ZstdBackend {
  const forced = process.env.WP_ZSTD;
  if (forced === 'bin' || forced === 'js') return forced;
  const r = spawnSync('zstd', ['--version'], { stdio: 'ignore' });
  return r.status === 0 ? 'bin' : 'js';
}

/** Распаковка системным `zstd -dc`: самый быстрый вариант. */
function zstdBinary(input: Readable): Readable {
  const child = spawn('zstd', ['-dcq'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  input.on('error', (e) => child.stdout.destroy(e));
  input.pipe(child.stdin);
  // Читатель может бросить поток раньше конца — тогда zstd получает EPIPE, это не ошибка.
  child.stdin.on('error', () => {});
  child.on('close', (code) => {
    if (code !== 0 && code !== null && !child.stdout.destroyed) {
      child.stdout.destroy(new Error(`zstd завершился с кодом ${code}: ${stderr.trim()}`));
    }
  });
  return child.stdout;
}

/** Распаковка на чистом JS (fzstd): понимает skippable-кадры, работает везде. */
async function zstdDecompressor(): Promise<Transform> {
  const { Decompress } = await import('fzstd');
  let push: ((b: Uint8Array) => void) | null = null;
  const dec = new Decompress((chunk: Uint8Array) => push?.(chunk));
  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      push = (b) => this.push(Buffer.from(b));
      try {
        dec.push(chunk);
        cb();
      } catch (e) {
        cb(e as Error);
      }
    },
    flush(cb: TransformCallback) {
      push = (b) => this.push(Buffer.from(b));
      try {
        dec.push(new Uint8Array(0), true);
        cb();
      } catch (e) {
        cb(e as Error);
      }
    },
  });
}

function counting(): { t: Transform; n: () => number } {
  let n = 0;
  const t = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      cb(null, chunk);
    },
  });
  return { t, n: () => n };
}

/** Открывает базу потоком: локальный путь или http(s)-URL, .csv или .csv.zst. */
export async function openSource(input: string): Promise<LineSource> {
  const isUrl = /^https?:\/\//.test(input);
  let raw: Readable;
  let sourceDate: Date;
  let totalBytes: number | null = null;

  if (isUrl) {
    const res = await fetch(input);
    if (!res.ok || !res.body) throw new Error(`Не удалось скачать ${input}: HTTP ${res.status}`);
    const lm = res.headers.get('last-modified');
    sourceDate = lm ? new Date(lm) : new Date(new Date().toISOString().slice(0, 10));
    const len = Number(res.headers.get('content-length'));
    totalBytes = Number.isFinite(len) && len > 0 ? len : null;
    raw = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  } else {
    const st = await stat(input).catch(() => null);
    if (!st) throw new Error(`Файл не найден: ${input}`);
    sourceDate = st.mtime;
    totalBytes = st.size;
    raw = createReadStream(input, { highWaterMark: 1 << 20 });
  }

  const counter = counting();
  let stream: Readable = raw.pipe(counter.t);
  let label = input;
  if (/\.zst(\?|$)/.test(input)) {
    const backend = pickZstdBackend();
    stream = backend === 'bin' ? zstdBinary(stream) : stream.pipe(await zstdDecompressor());
    label = `${input} (zstd: ${backend === 'bin' ? 'системный' : 'fzstd'})`;
  }
  stream.setEncoding('utf8');

  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  return { lines: rl, sourceDate, totalBytes, readBytes: counter.n, label };
}
