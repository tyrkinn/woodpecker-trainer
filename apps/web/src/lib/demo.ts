import type { PuzzleSetFile } from '@wp/core';

/**
 * Встроенный мини-набор, чтобы попробовать тренажёр до генерации своего.
 * Настоящий набор делается генератором из базы Lichess.
 */
export const DEMO_SET: PuzzleSetFile = {
  id: 'demo-v1',
  name: 'Пробный набор · 8 задач',
  createdAt: '2026-10-26T00:00:00.000Z',
  params: { note: 'demo' },
  puzzles: [
    {
      id: 'demo-backrank',
      fen: '6k1/5ppp/2p5/8/8/8/5PPP/3RR1K1 b - - 0 1',
      moves: ['c6c5', 'd1d8'],
      rating: 900,
      themes: ['backRankMate', 'mateIn1', 'oneMove', 'endgame'],
      gameUrl: '',
    },
    {
      id: 'demo-backrank-black',
      fen: '3rr1k1/5ppp/8/8/8/2P5/5PPP/6K1 w - - 0 1',
      moves: ['c3c4', 'd8d1'],
      rating: 950,
      themes: ['backRankMate', 'mateIn1', 'oneMove', 'endgame'],
      gameUrl: '',
    },
    {
      id: 'demo-g7',
      fen: '1n3rk1/5ppp/8/8/6Q1/8/1B3PPP/6K1 b - - 0 1',
      moves: ['b8c6', 'g4g7'],
      rating: 1000,
      themes: ['mateIn1', 'oneMove', 'kingsideAttack', 'middlegame'],
      gameUrl: '',
    },
    {
      id: 'demo-promo',
      fen: '7k/3P4/p1K5/8/8/8/8/8 b - - 0 1',
      moves: ['a6a5', 'd7d8q'],
      rating: 1050,
      themes: ['promotion', 'advancedPawn', 'oneMove', 'endgame'],
      gameUrl: '',
    },
    {
      id: 'demo-fork',
      fen: 'r3k3/p4ppp/8/1N6/8/8/5PPP/6K1 b - - 0 1',
      moves: ['h7h6', 'b5c7', 'e8d7', 'c7a8'],
      rating: 1150,
      themes: ['fork', 'short', 'endgame'],
      gameUrl: '',
    },
    {
      id: 'demo-skewer',
      fen: '8/8/8/3k4/7q/8/5PPP/R5K1 b - - 0 1',
      moves: ['h4h5', 'a1a5', 'd5e6', 'a5h5'],
      rating: 1250,
      themes: ['skewer', 'short', 'endgame'],
      gameUrl: '',
    },
    {
      id: 'demo-mate2',
      fen: '2r3k1/p4ppp/8/8/8/8/4RPPP/4R1K1 b - - 0 1',
      moves: ['a7a6', 'e2e8', 'c8e8', 'e1e8'],
      rating: 1350,
      themes: ['backRankMate', 'mateIn2', 'deflection', 'short', 'endgame'],
      gameUrl: '',
    },
    {
      id: 'demo-smothered',
      fen: '5r1k/p5pp/7N/8/2Q5/8/6PP/6K1 b - - 0 1',
      moves: ['a7a6', 'c4g8', 'f8g8', 'h6f7'],
      rating: 1450,
      themes: ['smotheredMate', 'mateIn2', 'sacrifice', 'short', 'middlegame'],
      gameUrl: '',
    },
  ],
};
