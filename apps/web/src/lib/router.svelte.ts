export type Route =
  | { name: 'home' }
  | { name: 'solve'; cycleId: string }
  | { name: 'practice'; setId: string; puzzleId: string }
  | { name: 'summary'; cycleId: string }
  | { name: 'stats'; setId: string };

export function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [name, a, b] = parts;
  if (name === 'solve' && a) return { name: 'solve', cycleId: a };
  if (name === 'practice' && a && b) return { name: 'practice', setId: a, puzzleId: b };
  if (name === 'summary' && a) return { name: 'summary', cycleId: a };
  if (name === 'stats' && a) return { name: 'stats', setId: a };
  return { name: 'home' };
}

export function href(r: Route): string {
  switch (r.name) {
    case 'home':
      return '#/';
    case 'solve':
      return `#/solve/${encodeURIComponent(r.cycleId)}`;
    case 'practice':
      return `#/practice/${encodeURIComponent(r.setId)}/${encodeURIComponent(r.puzzleId)}`;
    case 'summary':
      return `#/summary/${encodeURIComponent(r.cycleId)}`;
    case 'stats':
      return `#/stats/${encodeURIComponent(r.setId)}`;
  }
}

class Router {
  current = $state<Route>(parse(typeof location === 'undefined' ? '' : location.hash));

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('hashchange', () => (this.current = parse(location.hash)));
    }
  }

  go(r: Route, replace = false): void {
    const h = href(r);
    if (replace) {
      history.replaceState(null, '', h);
      this.current = r;
    } else location.hash = h;
  }
}

export const router = new Router();
