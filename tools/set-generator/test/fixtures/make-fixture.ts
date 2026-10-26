// Генерирует маленький фикстурный CSV в формате базы Lichess. Запуск: npx tsx tools/set-generator/test/fixtures/make-fixture.ts
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = [
  { fen: '6k1/5ppp/2p5/8/8/8/5PPP/3RR1K1 b - - 0 1', moves: 'c6c5 d1d8' },
  { fen: '2r3k1/p4ppp/8/8/8/8/4RPPP/4R1K1 b - - 0 1', moves: 'a7a6 e2e8 c8e8 e1e8' },
  { fen: '7k/3P4/p1K5/8/8/8/8/8 b - - 0 1', moves: 'a6a5 d7d8q' },
  { fen: '4k3/8/8/8/8/8/8/4K2R b K - 0 1', moves: 'e8d8 e1g1' },
];
const MOTIFS = ['fork', 'pin', 'skewer', 'backRankMate', 'deflection'];

type Row = [string, string, string, number, number, number, number, string, string, string];
const rows: Row[] = [];
const add = (id: string, b: (typeof BASE)[number], rating: number, themes: string, o: Partial<{ rd: number; pop: number; plays: number; moves: string }> = {}) =>
  rows.push([id, b.fen, o.moves ?? b.moves, rating, o.rd ?? 70, o.pop ?? 92, o.plays ?? 1500, themes, `https://lichess.org/${id}#30`, '']);

for (let i = 0; i < 40; i++) {
  add(`G${String(i).padStart(3, '0')}`, BASE[i % 4]!, 1690 - i * 10, `${MOTIFS[i % 5]} short middlegame`);
}
// Отдельные строки под каждый фильтр.
add('LOW', BASE[0]!, 1200, 'fork short');
add('HIGH', BASE[0]!, 1800, 'fork short');
add('UNPOP', BASE[0]!, 1500, 'fork short', { pop: 50 });
add('FEW', BASE[0]!, 1500, 'fork short', { plays: 100 });
add('RD', BASE[0]!, 1500, 'fork short', { rd: 120 });
add('LONG', BASE[1]!, 1500, 'fork veryLong', { moves: 'a7a6 e2e8 c8e8 e1e8 a6a5 h2h3 a5a4 h3h4 a4a3 g2g3' });
add('ZUG', BASE[2]!, 1555, 'zugzwang endgame');
add('META', BASE[3]!, 1444, 'crushing endgame short');
add('BAD', BASE[0]!, 1500, 'hangingPiece short', { moves: 'c6c5 a1a8' });

const header = 'PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags';
const out = [header, ...rows.map((r) => r.join(','))].join('\n') + '\n';
writeFileSync(fileURLToPath(new URL('./puzzles.csv', import.meta.url)), out);
console.log(`wrote ${rows.length} rows`);
