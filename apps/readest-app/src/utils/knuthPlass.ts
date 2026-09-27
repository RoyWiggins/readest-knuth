/**
 * Knuth–Plass optimum-fit line breaking ("Breaking Paragraphs into Lines",
 * Knuth & Plass, 1981), over the classic box/glue/penalty model.
 *
 * Pure and DOM-free: the caller measures its text into items and gets back the
 * chosen breakpoints with the adjustment ratio of each line. See
 * knuthPlassLayout.ts for how the reader applies them to a book paragraph.
 */

export type KPBox = { type: 'box'; width: number };
export type KPGlue = { type: 'glue'; width: number; stretch: number; shrink: number };
export type KPPenalty = { type: 'penalty'; width: number; penalty: number; flagged: boolean };
export type KPItem = KPBox | KPGlue | KPPenalty;

/** A penalty at or above this forbids a break; at or below its negation forces one. */
export const KP_INFINITY = 10000;

export interface KPOptions {
  /** Largest adjustment ratio a line may stretch to (TeX's \tolerance / 100 ^ (1/3)). */
  tolerance: number;
  /** Added to a line's badness before squaring (TeX's \linepenalty). */
  linePenalty: number;
  /** Two consecutive lines ending in flagged (hyphen) penalties (TeX's \doublehyphendemerits). */
  flaggedDemerits: number;
  /** Adjacent lines whose fitness classes differ by more than one (TeX's \adjdemerits). */
  fitnessDemerits: number;
}

export const DEFAULT_KP_OPTIONS: KPOptions = {
  tolerance: 2,
  linePenalty: 10,
  flaggedDemerits: 3000,
  fitnessDemerits: 100,
};

export interface KPBreak {
  /** Index of the glue or penalty item the line ends at. */
  position: number;
  /** Adjustment ratio of the line ending here: >0 stretched, <0 shrunk. */
  ratio: number;
}

type Totals = { width: number; stretch: number; shrink: number };

type ActiveNode = {
  position: number;
  line: number;
  fitness: number;
  totals: Totals;
  demerits: number;
  ratio: number;
  previous: ActiveNode | null;
};

const fitnessClass = (ratio: number): number => {
  if (ratio < -0.5) return 0; // tight
  if (ratio <= 0.5) return 1; // decent
  if (ratio <= 1) return 2; // loose
  return 3; // very loose
};

const isFlagged = (item: KPItem | undefined): boolean => item?.type === 'penalty' && item.flagged;

const isForcedBreak = (item: KPItem | undefined): boolean =>
  item?.type === 'penalty' && item.penalty <= -KP_INFINITY;

/**
 * Build the standard item list tail for a paragraph: a finishing glue that can
 * stretch without bound so the last line is set at its natural width, then a
 * forced break. Callers append this after their last box.
 */
export const paragraphEnd = (): KPItem[] => [
  { type: 'penalty', width: 0, penalty: KP_INFINITY, flagged: false },
  { type: 'glue', width: 0, stretch: KP_INFINITY, shrink: 0 },
  { type: 'penalty', width: 0, penalty: -KP_INFINITY, flagged: true },
];

/**
 * A breakpoint for ragged-right setting, the encoding of Knuth & Plass: a line
 * ending at `penalty` gets `stretch` of white space at its end, while a line
 * running through it gets `space` (the interword space the break replaces, 0
 * inside a word) and no stretch at all, since the two glues cancel out. Spaces
 * thus keep their natural width and only the rag varies, which the demerits
 * then keep even. The leading infinite penalty keeps the engine from breaking
 * at the first glue, where the line would get no stretch.
 */
export const raggedBreak = <P extends KPPenalty>(
  penalty: P,
  stretch: number,
  space = 0,
): (KPGlue | KPPenalty | P)[] => [
  { type: 'penalty', width: 0, penalty: KP_INFINITY, flagged: false },
  { type: 'glue', width: 0, stretch, shrink: 0 },
  penalty,
  { type: 'glue', width: space, stretch: -stretch, shrink: 0 },
];

/**
 * Choose optimal breakpoints for `items` set in lines of `lineWidth`. Returns
 * the breaks in order (the last one is the paragraph's final forced break), or
 * null when no set of lines fits within `options.tolerance`.
 */
export const breakLines = (
  items: KPItem[],
  lineWidth: number | ((line: number) => number),
  options: Partial<KPOptions> = {},
): KPBreak[] | null => {
  const { tolerance, linePenalty, flaggedDemerits, fitnessDemerits } = {
    ...DEFAULT_KP_OPTIONS,
    ...options,
  };
  const widthOf = typeof lineWidth === 'number' ? () => lineWidth : lineWidth;

  // Running totals of everything before the current item.
  const sum: Totals = { width: 0, stretch: 0, shrink: 0 };

  // Totals as of the start of the line that follows a break at `position`:
  // glue and non-forced penalties right after a break are discarded, so they
  // are folded into the totals and never count against the next line.
  const totalsAfter = (position: number): Totals => {
    const totals = { ...sum };
    for (let i = position; i < items.length; i++) {
      const item = items[i]!;
      if (item.type === 'box') break;
      if (item.type === 'glue') {
        totals.width += item.width;
        totals.stretch += item.stretch;
        totals.shrink += item.shrink;
      } else if (item.penalty <= -KP_INFINITY && i > position) break;
    }
    return totals;
  };

  let active: ActiveNode[] = [
    {
      position: 0,
      line: 0,
      fitness: 1,
      totals: { width: 0, stretch: 0, shrink: 0 },
      demerits: 0,
      ratio: 0,
      previous: null,
    },
  ];

  const ratioFor = (node: ActiveNode, item: KPItem): number => {
    let width = sum.width - node.totals.width;
    if (item.type === 'penalty') width += item.width;
    const target = widthOf(node.line);
    if (width < target) {
      const stretch = sum.stretch - node.totals.stretch;
      return stretch > 0 ? (target - width) / stretch : KP_INFINITY;
    }
    if (width > target) {
      const shrink = sum.shrink - node.totals.shrink;
      return shrink > 0 ? (target - width) / shrink : -KP_INFINITY;
    }
    return 0;
  };

  const tryBreak = (position: number, item: KPItem) => {
    const penalty = item.type === 'penalty' ? item.penalty : 0;
    const flagged = item.type === 'penalty' && item.flagged;
    // Best candidate per fitness class for a new active node at `position`.
    const candidates: (Omit<ActiveNode, 'totals'> | null)[] = [null, null, null, null];
    const survivors: ActiveNode[] = [];

    for (const node of active) {
      const ratio = ratioFor(node, item);
      // A line that cannot shrink enough will only get longer from here on,
      // and nothing may follow a forced break on the same line.
      const keep = ratio >= -1 && penalty > -KP_INFINITY;
      if (keep) survivors.push(node);
      if (ratio < -1 || ratio > tolerance) continue;

      const badness = 100 * Math.abs(ratio) ** 3;
      let demerits: number;
      if (penalty >= 0) demerits = (linePenalty + badness) ** 2 + penalty ** 2;
      else if (penalty > -KP_INFINITY) demerits = (linePenalty + badness) ** 2 - penalty ** 2;
      else demerits = (linePenalty + badness) ** 2;
      if (flagged && isFlagged(items[node.position])) demerits += flaggedDemerits;
      const fitness = fitnessClass(ratio);
      if (Math.abs(fitness - node.fitness) > 1) demerits += fitnessDemerits;
      demerits += node.demerits;

      const best = candidates[fitness];
      if (!best || demerits < best.demerits) {
        candidates[fitness] = {
          position,
          line: node.line + 1,
          fitness,
          demerits,
          ratio,
          previous: node,
        };
      }
    }

    active = survivors;
    const minDemerits = Math.min(...candidates.map((c) => c?.demerits ?? Infinity));
    if (minDemerits === Infinity) return;
    const totals = totalsAfter(position);
    for (const candidate of candidates) {
      // Keep other fitness classes only while they could still win once the
      // adjacent-line demerits of what follows are counted.
      if (candidate && candidate.demerits <= minDemerits + fitnessDemerits) {
        active.push({ ...candidate, totals });
      }
    }
  };

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.type === 'box') {
      sum.width += item.width;
    } else if (item.type === 'glue') {
      if (i > 0 && items[i - 1]!.type === 'box') tryBreak(i, item);
      sum.width += item.width;
      sum.stretch += item.stretch;
      sum.shrink += item.shrink;
    } else if (item.penalty < KP_INFINITY) {
      tryBreak(i, item);
    }
    if (active.length === 0) return null;
  }

  // The paragraph ends in a forced break, so every surviving node sits on it.
  let best: ActiveNode | null = null;
  for (const node of active) {
    if (node.position === items.length - 1 || isForcedBreak(items[node.position])) {
      if (!best || node.demerits < best.demerits) best = node;
    }
  }
  if (!best || best.position === 0) return null;

  const breaks: KPBreak[] = [];
  for (let node: ActiveNode | null = best; node && node.previous; node = node.previous) {
    breaks.push({ position: node.position, ratio: node.ratio });
  }
  return breaks.reverse();
};
