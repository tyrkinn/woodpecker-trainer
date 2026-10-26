import { Chess, type Move, type Square } from 'chess.js';
import type { Puzzle } from './types.ts';

export type Color = 'white' | 'black';

export interface PlayedMove {
  uci: string;
  from: Square;
  to: Square;
  promotion?: 'q' | 'r' | 'b' | 'n';
  san: string;
  fenAfter: string;
  check: boolean;
}

export type MoveResult =
  /** Ход верный, задача продолжается; `reply` — ответ соперника, его надо проиграть. */
  | { kind: 'continue'; move: PlayedMove; reply: PlayedMove }
  /** Задача решена. `altMate` — мат другим ходом, чем в базе. */
  | { kind: 'solved'; move: PlayedMove; altMate: boolean }
  /** Ошибка. Позиция не изменилась. */
  | { kind: 'wrong'; uci: string }
  /** Нелегальный ход — его не засчитываем ни как ошибку, ни как решение. */
  | { kind: 'illegal'; uci: string };

const UCI_RE = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;

export function parseUci(uci: string): { from: Square; to: Square; promotion?: 'q' | 'r' | 'b' | 'n' } {
  const m = UCI_RE.exec(uci);
  if (!m) throw new Error(`Bad UCI: ${uci}`);
  const res: { from: Square; to: Square; promotion?: 'q' | 'r' | 'b' | 'n' } = {
    from: m[1] as Square,
    to: m[2] as Square,
  };
  if (m[3]) res.promotion = m[3] as 'q' | 'r' | 'b' | 'n';
  return res;
}

/**
 * Приводит рокировку к стандартному UCI.
 * Доска может отдать рокировку как «король на свою ладью» (e1h1) — превращаем в e1g1.
 */
export function normalizeUci(chess: Chess, uci: string): string {
  const { from, to, promotion } = parseUci(uci);
  const piece = chess.get(from);
  if (piece?.type === 'k') {
    const target = chess.get(to);
    if (target && target.type === 'r' && target.color === piece.color && from[1] === to[1]) {
      const file = to[0]! > from[0]! ? 'g' : 'c';
      return `${from}${file}${from[1]}`;
    }
  }
  return `${from}${to}${promotion ?? ''}`;
}

function toPlayed(m: Move, fenAfter: string): PlayedMove {
  const pm: PlayedMove = {
    uci: m.from + m.to + (m.promotion ?? ''),
    from: m.from,
    to: m.to,
    san: m.san,
    fenAfter,
    check: m.san.includes('+') || m.san.includes('#'),
  };
  if (m.promotion) pm.promotion = m.promotion as 'q' | 'r' | 'b' | 'n';
  return pm;
}

/** Ход пешки на последнюю горизонталь — UI должен спросить фигуру. */
export function needsPromotion(fen: string, from: string, to: string): boolean {
  const chess = new Chess(fen);
  const p = chess.get(from as Square);
  if (!p || p.type !== 'p') return false;
  return (p.color === 'w' && to[1] === '8') || (p.color === 'b' && to[1] === '1');
}

/** Карта легальных ходов в формате chessground: from -> [to...]. */
export function legalDests(fen: string): Map<string, string[]> {
  const chess = new Chess(fen);
  const dests = new Map<string, string[]>();
  for (const m of chess.moves({ verbose: true })) {
    const list = dests.get(m.from) ?? [];
    if (!list.includes(m.to)) list.push(m.to);
    dests.set(m.from, list);
  }
  return dests;
}

/**
 * Сессия одной задачи. Не знает про UI и время: только правила.
 *
 * - `moves[0]` — ход соперника, проигрывается `playSetup()`.
 * - Пользователь ходит на нечётных индексах, соперник отвечает на чётных.
 * - Мат любым ходом засчитывается, как на Lichess.
 */
export class PuzzleSession {
  readonly puzzle: Puzzle;
  private chess: Chess;
  /** Индекс следующего ожидаемого хода в `puzzle.moves`. */
  private ply = 0;
  private finished = false;

  constructor(puzzle: Puzzle) {
    if (puzzle.moves.length < 2) throw new Error(`Puzzle ${puzzle.id}: need at least 2 moves`);
    this.puzzle = puzzle;
    this.chess = new Chess(puzzle.fen);
  }

  get fen(): string {
    return this.chess.fen();
  }

  get isSetupPlayed(): boolean {
    return this.ply > 0;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** Цвет пользователя — сторона, которая ходит после `moves[0]`. */
  get userColor(): Color {
    // До хода соперника ходит соперник, значит пользователь — противоположный цвет.
    const turnAtStart = new Chess(this.puzzle.fen).turn();
    return turnAtStart === 'w' ? 'black' : 'white';
  }

  get turnColor(): Color {
    return this.chess.turn() === 'w' ? 'white' : 'black';
  }

  /** Сколько ходов пользователя в задаче. */
  get userMoveCount(): number {
    return Math.floor(this.puzzle.moves.length / 2);
  }

  dests(): Map<string, string[]> {
    return this.finished || !this.isUserTurn() ? new Map() : legalDests(this.fen);
  }

  isUserTurn(): boolean {
    return this.ply > 0 && this.ply % 2 === 1 && !this.finished;
  }

  inCheck(): boolean {
    return this.chess.inCheck();
  }

  /** Проигрывает ход соперника `moves[0]`. */
  playSetup(): PlayedMove {
    if (this.ply !== 0) throw new Error('Setup already played');
    const mv = this.apply(this.puzzle.moves[0]!);
    this.ply = 1;
    return mv;
  }

  /** Проверка хода пользователя. При ошибке позиция не меняется. */
  tryMove(rawUci: string): MoveResult {
    if (!this.isUserTurn()) throw new Error('Not user turn');
    let uci: string;
    try {
      uci = normalizeUci(this.chess, rawUci);
    } catch {
      return { kind: 'illegal', uci: rawUci };
    }
    const expected = normalizeUci(this.chess, this.puzzle.moves[this.ply]!);
    const isLast = this.ply === this.puzzle.moves.length - 1;

    if (uci === expected) {
      const move = this.apply(uci);
      if (isLast || this.chess.isCheckmate()) {
        this.finished = true;
        this.ply += 1;
        return { kind: 'solved', move, altMate: false };
      }
      const reply = this.apply(this.puzzle.moves[this.ply + 1]!);
      this.ply += 2;
      return { kind: 'continue', move, reply };
    }

    // Альтернативный ход: засчитываем только мат.
    const probe = new Chess(this.chess.fen());
    let probeMove: Move;
    try {
      probeMove = probe.move(parseUci(uci));
    } catch {
      return { kind: 'illegal', uci: rawUci };
    }
    if (probe.isCheckmate()) {
      this.chess = probe;
      this.finished = true;
      this.ply = this.puzzle.moves.length;
      return { kind: 'solved', move: toPlayed(probeMove, probe.fen()), altMate: true };
    }
    return { kind: 'wrong', uci };
  }

  /** Оставшиеся ходы решения от текущей позиции (для показа после ошибки). Состояние не меняет. */
  remainingSolution(): PlayedMove[] {
    const probe = new Chess(this.chess.fen());
    const out: PlayedMove[] = [];
    for (let i = this.ply; i < this.puzzle.moves.length; i++) {
      const m = probe.move(parseUci(normalizeUci(probe, this.puzzle.moves[i]!)));
      out.push(toPlayed(m, probe.fen()));
    }
    return out;
  }

  /** Сдаться («Не знаю» или после ошибки). */
  giveUp(): PlayedMove[] {
    const rest = this.remainingSolution();
    this.finished = true;
    return rest;
  }

  private apply(uci: string): PlayedMove {
    const m = this.chess.move(parseUci(normalizeUci(this.chess, uci)));
    return toPlayed(m, this.chess.fen());
  }
}

/** Проверяет, что задачу можно проиграть целиком по правилам. Для валидации импорта. */
export function validatePuzzle(p: Puzzle): string | null {
  try {
    const chess = new Chess(p.fen);
    for (const uci of p.moves) chess.move(parseUci(normalizeUci(chess, uci)));
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
