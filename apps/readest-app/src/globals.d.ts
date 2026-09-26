declare module '*.css' {
  interface IClassNames {
    [className: string]: string;
  }
  const classNames: IClassNames;
  export default classNames;
}

declare module 'hyphen' {
  type HyphenationPatterns = unknown;
  const createHyphenator: (
    patterns: HyphenationPatterns,
    options?: { hyphenChar?: string; minWordLength?: number },
  ) => (text: string) => string;
  export default createHyphenator;
}

declare module 'hyphen/patterns/*' {
  const patterns: unknown;
  export default patterns;
}
