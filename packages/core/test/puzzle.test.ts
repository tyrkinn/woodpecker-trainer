import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { PuzzleSession, legalDests, needsPromotion, normalizeUci, validatePuzzle, type Puzzle } from '../src/index.ts';

const mk = (fen: string, moves: string, id = 't'): Puzzle => ({
  id,
  fen,
  moves: moves.split(' '),
  rating: 1500,
  themes: ['backRankMate', 'mateIn1'],
  gameUrl: 'https://lichess.org/xxxx',
});

// Две ладьи, мат по последней: ожидается Rd8#, но Re8# тоже мат.
const BACK_RANK = mk('6k1/5ppp/2p5/8/8/8/5PPP/3RR1K1 b - - 0 1', 'c6c5 d1d8', 'backrank');
// Мат в 2: Re8+ Rxe8 Rxe8#.
const MATE_IN_2 = mk('2r3k1/p4ppp/8/8/8/8/4RPPP/4R1K1 b - - 0 1', 'a7a6 e2e8 c8e8 e1e8', 'm2');
// Превращение.
const PROMO = mk('7k/3P4/p1K5/8/8/8/8/8 b - - 0 1', 'a6a5 d7d8q', 'promo');
// Решение — рокировка.
const CASTLE = mk('4k3/8/8/8/8/8/8/4K2R b K - 0 1', 'e8d8 e1g1', 'castle');
// Ход соперника — рокировка.
const OPP_CASTLE = mk('4k2r/8/8/8/8/8/8/4K3 b k - 0 1', 'e8g8 e1e2', 'oppcastle');

describe('PuzzleSession: ход соперника и цвет', () => {
  it('moves[0] проигрывается как ход соперника, потом ход пользователя', () => {
    const s = new PuzzleSession(BACK_RANK);
    expect(s.isUserTurn()).toBe(false);
    expect(s.dests().size).toBe(0);
    const m = s.playSetup();
    expect(m.uci).toBe('c6c5');
    expect(m.from).toBe('c6');
    expect(m.to).toBe('c5');
    expect(s.isUserTurn()).toBe(true);
    expect(s.dests().get('d1')).toContain('d8');
  });

  it('цвет пользователя — сторона, которая ходит после moves[0]', () => {
    const s = new PuzzleSession(BACK_RANK);
    expect(s.userColor).toBe('white');
    s.playSetup();
    expect(s.turnColor).toBe(s.userColor);

    const black = new PuzzleSession(mk('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', 'e2e4 e8e7'));
    expect(black.userColor).toBe('black');
  });

  it('нельзя сыграть setup дважды и ходить до setup', () => {
    const s = new PuzzleSession(BACK_RANK);
    expect(() => s.tryMove('d1d8')).toThrow();
    s.playSetup();
    expect(() => s.playSetup()).toThrow();
  });
});

describe('PuzzleSession: проверка хода', () => {
  it('верный ход решает однохдовку', () => {
    const s = new PuzzleSession(BACK_RANK);
    s.playSetup();
    const r = s.tryMove('d1d8');
    expect(r.kind).toBe('solved');
    if (r.kind === 'solved') expect(r.altMate).toBe(false);
    expect(s.isFinished).toBe(true);
  });

  it('альтернативный мат засчитывается', () => {
    const s = new PuzzleSession(BACK_RANK);
    s.playSetup();
    const r = s.tryMove('e1e8');
    expect(r.kind).toBe('solved');
    if (r.kind === 'solved') {
      expect(r.altMate).toBe(true);
      expect(r.move.san).toBe('Re8#');
    }
  });

  it('неверный не-матовый ход = ошибка, позиция не меняется', () => {
    const s = new PuzzleSession(BACK_RANK);
    s.playSetup();
    const before = s.fen;
    const r = s.tryMove('h2h3');
    expect(r).toEqual({ kind: 'wrong', uci: 'h2h3' });
    expect(s.fen).toBe(before);
  });

  it('нелегальный ход не считается ни ошибкой, ни решением', () => {
    const s = new PuzzleSession(BACK_RANK);
    s.playSetup();
    expect(s.tryMove('d1d7').kind).toBe('wrong'); // легальный, но не мат
    expect(s.tryMove('a1a8').kind).toBe('illegal');
    expect(s.isUserTurn()).toBe(true);
  });

  it('многоходовка: ответ соперника проигрывается автоматически', () => {
    const s = new PuzzleSession(MATE_IN_2);
    s.playSetup();
    expect(s.userMoveCount).toBe(2);
    const r1 = s.tryMove('e2e8');
    expect(r1.kind).toBe('continue');
    if (r1.kind === 'continue') {
      expect(r1.move.check).toBe(true);
      expect(r1.reply.uci).toBe('c8e8');
    }
    expect(s.isUserTurn()).toBe(true);
    const r2 = s.tryMove('e1e8');
    expect(r2.kind).toBe('solved');
    expect(s.isFinished).toBe(true);
  });

  it('многоходовка: ошибка на втором ходу', () => {
    const s = new PuzzleSession(MATE_IN_2);
    s.playSetup();
    s.tryMove('e2e8');
    expect(s.tryMove('g1f1').kind).toBe('wrong');
    const rest = s.giveUp();
    expect(rest.map((m) => m.uci)).toEqual(['e1e8']);
    expect(s.isFinished).toBe(true);
  });

  it('remainingSolution показывает всё решение и не меняет состояние', () => {
    const s = new PuzzleSession(MATE_IN_2);
    s.playSetup();
    const fen = s.fen;
    expect(s.remainingSolution().map((m) => m.san)).toEqual(['Re8+', 'Rxe8', 'Rxe8#']);
    expect(s.fen).toBe(fen);
  });
});

describe('PuzzleSession: превращение и рокировка', () => {
  it('превращение в ферзя по UCI с суффиксом', () => {
    const s = new PuzzleSession(PROMO);
    s.playSetup();
    expect(needsPromotion(s.fen, 'd7', 'd8')).toBe(true);
    expect(needsPromotion(s.fen, 'c6', 'c7')).toBe(false);
    const r = s.tryMove('d7d8q');
    expect(r.kind).toBe('solved');
    if (r.kind === 'solved') expect(r.move.promotion).toBe('q');
  });

  it('превращение не в ту фигуру = ошибка', () => {
    const s = new PuzzleSession(PROMO);
    s.playSetup();
    expect(s.tryMove('d7d8n').kind).toBe('wrong');
  });

  it('рокировка ходом короля e1g1', () => {
    const s = new PuzzleSession(CASTLE);
    s.playSetup();
    const r = s.tryMove('e1g1');
    expect(r.kind).toBe('solved');
    if (r.kind === 'solved') {
      expect(r.move.san).toBe('O-O');
      expect(new Chess(r.move.fenAfter).get('f1')?.type).toBe('r');
    }
  });

  it('рокировка «король на ладью» (e1h1, как отдаёт доска) приводится к e1g1', () => {
    const s = new PuzzleSession(CASTLE);
    s.playSetup();
    expect(normalizeUci(new Chess(s.fen), 'e1h1')).toBe('e1g1');
    expect(s.tryMove('e1h1').kind).toBe('solved');
  });

  it('рокировка соперника в moves[0]', () => {
    const s = new PuzzleSession(OPP_CASTLE);
    const m = s.playSetup();
    expect(m.san).toBe('O-O');
    expect(m.to).toBe('g8');
    expect(new Chess(s.fen).get('f8')?.type).toBe('r');
  });

  it('dests содержат рокировку', () => {
    const s = new PuzzleSession(CASTLE);
    s.playSetup();
    expect(legalDests(s.fen).get('e1')).toContain('g1');
  });
});

describe('validatePuzzle', () => {
  it('принимает корректную и отклоняет сломанную задачу', () => {
    expect(validatePuzzle(MATE_IN_2)).toBeNull();
    expect(validatePuzzle({ ...MATE_IN_2, moves: ['a7a6', 'e2e9'] })).not.toBeNull();
    expect(validatePuzzle({ ...MATE_IN_2, moves: ['a7a6', 'e2e8', 'c8e8'] })).toBeNull();
    expect(validatePuzzle({ ...MATE_IN_2, moves: ['a7a6', 'e1e8', 'c8e8'] })).not.toBeNull(); // e2 закрывает линию
    expect(validatePuzzle({ ...MATE_IN_2, moves: ['a7a6', 'd1d8'] })).not.toBeNull();
  });
});
