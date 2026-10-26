import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import * as zlib from 'node:zlib';

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

/** zstd-распаковка: встроенная в Node (22.15+), иначе чистый JS fzstd. */
async function zstdDecompressor(): Promise<Transform> {
  const native = (zlib as unknown as { createZstdDecompress?: () => Transform }).createZstdDecompress;
  if (typeof native === 'function') return native();
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
  if (/\.zst(\?|$)/.test(input)) stream = stream.pipe(await zstdDecompressor());
  stream.setEncoding('utf8');

  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  return { lines: rl, sourceDate, totalBytes, readBytes: counter.n, label: input };
}
