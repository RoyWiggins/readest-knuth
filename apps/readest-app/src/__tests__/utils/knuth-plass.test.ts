import { describe, expect, it } from 'vitest';
import { breakLines, KPItem, KP_INFINITY, paragraphEnd, raggedBreak } from '@/utils/knuthPlass';

// Monospace model: every character is one unit wide, a space is one unit that
// may stretch by half and shrink by a third (TeX's defaults for a word space).
const space = (): KPItem => ({ type: 'glue', width: 1, stretch: 0.5, shrink: 1 / 3 });

const itemize = (text: string, hyphenate = false): KPItem[] => {
  const items: KPItem[] = [];
  text.split(' ').forEach((word, i) => {
    if (i > 0) items.push(space());
    const parts = hyphenate ? word.split('-') : [word];
    parts.forEach((part, j) => {
      if (j > 0) items.push({ type: 'penalty', width: 1, penalty: 50, flagged: true });
      items.push({ type: 'box', width: part.length });
    });
  });
  return [...items, ...paragraphEnd()];
};

const lineWidths = (items: KPItem[], positions: number[]): number[] => {
  const widths: number[] = [];
  let start = 0;
  for (const end of positions) {
    let width = 0;
    // Discard leading glue/penalties after a break, as the algorithm does.
    while (start < end && items[start]!.type !== 'box') start++;
    for (let i = start; i < end; i++) {
      const item = items[i]!;
      if (item.type !== 'penalty') width += item.width;
    }
    const last = items[end]!;
    if (last.type === 'penalty') width += last.width;
    widths.push(width);
    start = end + 1;
  }
  return widths;
};

// The first paragraph of "The Frog King", the example of Knuth & Plass.
const FROG_KING =
  'In olden times when wishing still helped one, there lived a king whose ' +
  'daughters were all beautiful; and the youngest was so beautiful that the ' +
  'sun itself, which has seen so much, was astonished whenever it shone in her face.';

describe('breakLines', () => {
  it('ends with the forced break and keeps every line within tolerance', () => {
    const items = itemize(FROG_KING);
    const breaks = breakLines(items, 30, { tolerance: 3 })!;
    expect(breaks).not.toBeNull();
    expect(breaks[breaks.length - 1]!.position).toBe(items.length - 1);
    for (const { ratio } of breaks.slice(0, -1)) {
      expect(ratio).toBeGreaterThanOrEqual(-1);
      expect(ratio).toBeLessThanOrEqual(3);
    }
  });

  it('only breaks at glue following a box or at penalties', () => {
    const items = itemize(FROG_KING);
    const breaks = breakLines(items, 30, { tolerance: 3 })!;
    for (const { position } of breaks) {
      const item = items[position]!;
      if (item.type === 'glue') expect(items[position - 1]!.type).toBe('box');
      else expect(item.type).toBe('penalty');
    }
  });

  it('reports the ratio that sets each line to the measure', () => {
    const items = itemize(FROG_KING);
    const breaks = breakLines(items, 30, { tolerance: 3 })!;
    const widths = lineWidths(
      items,
      breaks.map((b) => b.position),
    );
    let start = 0;
    breaks.slice(0, -1).forEach(({ position, ratio }, line) => {
      const glue = items
        .slice(start, position)
        .filter((item): item is Extract<KPItem, { type: 'glue' }> => item.type === 'glue');
      // Glue discarded at the start of a line never counts.
      const counted = items[start]!.type === 'glue' ? glue.slice(1) : glue;
      const flex = counted.reduce((acc, g) => acc + (ratio >= 0 ? g.stretch : g.shrink), 0);
      expect(widths[line]! + ratio * flex).toBeCloseTo(30, 6);
      start = position + 1;
    });
  });

  it('spreads the looseness more evenly than first-fit', () => {
    const items = itemize(FROG_KING);
    const breaks = breakLines(items, 30, { tolerance: 10 })!;
    const optimal = breaks.slice(0, -1).map((b) => Math.abs(b.ratio));

    // First fit: take as many words as fit at natural width.
    const greedy: number[] = [];
    let width = 0;
    let stretch = 0;
    let lastGlue = -1;
    let lineStart = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (item.type === 'box') {
        if (width + item.width > 30 && lastGlue > lineStart) {
          greedy.push(stretch > 0 ? (30 - width) / stretch : 0);
          width = 0;
          stretch = 0;
          i = lastGlue;
          lineStart = lastGlue + 1;
          continue;
        }
        width += item.width;
      } else if (item.type === 'glue' && item.stretch < KP_INFINITY && i > lineStart) {
        // Ratio of the line if it ended just before this glue.
        lastGlue = i;
        width += item.width;
        stretch += item.stretch;
      }
    }
    // Compare the worst line: optimum fit never does worse than first fit.
    expect(Math.max(...optimal)).toBeLessThanOrEqual(Math.max(...greedy) + 1e-9);
  });

  it('returns null when a word cannot fit the measure', () => {
    expect(breakLines(itemize('a supercalifragilistic word'), 10)).toBeNull();
  });

  it('breaks inside words at hyphenation penalties', () => {
    const text =
      'the con-sti-tu-tion-al-ly in-com-pre-hen-si-ble ar-gu-ments of the ' +
      'pro-lif-er-at-ing com-mit-tees were not at all what we had hoped for';
    const items = itemize(text, true);
    const breaks = breakLines(items, 19, { tolerance: 3 })!;
    expect(breaks).not.toBeNull();
    expect(breaks.some(({ position }) => items[position]!.type === 'penalty')).toBe(true);
    for (const { ratio } of breaks.slice(0, -1)) {
      expect(ratio).toBeGreaterThanOrEqual(-1);
      expect(ratio).toBeLessThanOrEqual(3);
    }
  });

  it('sets a one-line paragraph as a single final line', () => {
    const items = itemize('short line');
    expect(breakLines(items, 30)).toEqual([
      { position: items.length - 1, ratio: expect.any(Number) },
    ]);
  });

  it('honors a varying measure per line', () => {
    const items = itemize(FROG_KING);
    const breaks = breakLines(items, (line) => (line === 0 ? 20 : 30), { tolerance: 3 })!;
    const widths = lineWidths(
      items,
      breaks.map((b) => b.position),
    );
    expect(widths[0]).toBeLessThanOrEqual(20 + 3);
  });

  describe('ragged right', () => {
    // Every space becomes a possible line end with 6 units of stretch.
    const itemizeRagged = (text: string): KPItem[] => {
      const items: KPItem[] = [];
      text.split(' ').forEach((word, i) => {
        if (i > 0) {
          items.push(
            ...raggedBreak({ type: 'penalty', width: 0, penalty: 0, flagged: false }, 6, 1),
          );
        }
        items.push({ type: 'box', width: word.length });
      });
      return [...items, ...paragraphEnd()];
    };

    // Natural width of each line: boxes plus the spaces that did not break.
    const raggedLines = (breaks: { position: number }[], items: KPItem[]) => {
      const lines: number[] = [];
      let width = 0;
      let next = 0;
      items.forEach((item, i) => {
        if (i === breaks[next]?.position) {
          lines.push(width);
          width = 0;
          next++;
        } else if (item.type !== 'penalty') {
          width += item.width;
        }
      });
      // Spaces around a break are discarded: drop a leading space width.
      return lines.map((w, i) => (i === 0 ? w : w - 1));
    };

    it('keeps spaces at their natural width and every line within the measure', () => {
      const items = itemizeRagged(FROG_KING);
      const breaks = breakLines(items, 30)!;
      expect(breaks).not.toBeNull();
      const words = FROG_KING.split(' ');
      const lines = raggedLines(breaks, items);
      lines.forEach((w) => expect(w).toBeLessThanOrEqual(30));
      // Joining the lines' words with single spaces reproduces the widths.
      const total = lines.reduce((sum, w) => sum + w, 0);
      expect(total).toBe(words.join(' ').length - (lines.length - 1));
    });

    it('gives a smoother right edge than first fit', () => {
      const items = itemizeRagged(FROG_KING);
      const breaks = breakLines(items, 30)!;
      const optimal = raggedLines(breaks, items).slice(0, -1);

      const greedy: number[] = [];
      let line = '';
      for (const word of FROG_KING.split(' ')) {
        const next = line ? `${line} ${word}` : word;
        if (next.length > 30) {
          greedy.push(line.length);
          line = word;
        } else line = next;
      }
      const cost = (widths: number[]) => widths.reduce((sum, w) => sum + (30 - w) ** 2, 0);
      expect(cost(optimal)).toBeLessThan(cost(greedy));
    });
  });
});
