/**
 * FG-13 (HomeRoll): heuristic natural-language → structured-filter parser for
 * "Ask HomeRoll". Deliberately dependency-free and deterministic — the LLM
 * provider layer (when configured) refines the answer, but the *search* itself
 * must work without one, so parsing cannot depend on it.
 *
 * Extracted signals: relative/absolute date ranges, city/country mentions,
 * media type, favorites, OCR text ("that says/sign/reads ..."), and the
 * remaining free text as the CLIP query.
 */

export interface ParsedAskQuery {
  query: string | null;
  city: string | null;
  country: string | null;
  takenAfter: string | null;
  takenBefore: string | null;
  mediaType: 'IMAGE' | 'VIDEO' | null;
  favorited: boolean | null;
  ocr: string | null;
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const MONTH_LOOKUP = new Map(
  MONTHS.flatMap((month, index) => [
    [month, index],
    [month.slice(0, 3), index],
  ]),
);

const strip = (value: string) => value.replace(/[?!.]+$/g, '').trim();

/** Removes the matched span from the working text so the remainder becomes the CLIP query. */
class QueryText {
  private parts: string[];

  constructor(text: string) {
    this.parts = [text];
  }

  consume(pattern: RegExp): RegExpExecArray | null {
    for (let index = 0; index < this.parts.length; index++) {
      const match = pattern.exec(this.parts[index]);
      if (!match) {
        continue;
      }

      const before = this.parts[index].slice(0, match.index);
      const after = this.parts[index].slice(match.index + match[0].length);
      this.parts.splice(index, 1, before, after);
      return match;
    }
    return null;
  }

  text(): string {
    return strip(this.parts.join(' ').replaceAll(/\s+/g, ' '));
  }
}

const parseDateRange = (text: QueryText): { takenAfter: string | null; takenBefore: string | null } => {
  const now = new Date();
  const year = now.getUTCFullYear();

  // "in 2019" / "from 2019" / "2019"
  const yearMatch = text.consume(/\b(?:in|from|during|back in)\s+(20\d{2})\b/i) ?? text.consume(/\b(20\d{2})\b/);
  if (yearMatch) {
    const y = Number(yearMatch[1]);
    return { takenAfter: `${y}-01-01T00:00:00.000Z`, takenBefore: `${y + 1}-01-01T00:00:00.000Z` };
  }

  // "last summer" / "this summer"
  const season = text.consume(/\b(this|last)\s+(summer|winter|spring|fall|autumn)\b/i);
  if (season) {
    const isLast = season[1].toLowerCase() === 'last';
    const name = season[2].toLowerCase();
    const bounds: Record<string, [number, number]> = {
      summer: [6, 8],
      winter: [12, 2],
      spring: [3, 5],
      fall: [9, 11],
      autumn: [9, 11],
    };
    const [startMonth, endMonth] = bounds[name];
    const anchorYear = isLast && now.getUTCMonth() + 1 < startMonth ? year - 1 : isLast ? year - 1 : year;
    const after = `${anchorYear}-${String(startMonth).padStart(2, '0')}-01T00:00:00.000Z`;
    // seasons that wrap the year boundary (winter: Dec→Feb) end in the following year
    const before =
      endMonth < startMonth || endMonth === 12
        ? `${anchorYear + 1}-${String((endMonth % 12) + 1).padStart(2, '0')}-01T00:00:00.000Z`
        : `${anchorYear}-${String(endMonth + 1).padStart(2, '0')}-01T00:00:00.000Z`;
    return { takenAfter: after, takenBefore: before };
  }

  // "last july" / "in june 2023"
  const month = text.consume(
    /\b(?:in|last|this|during)?\s?(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b(?:\s+(20\d{2}))?/i,
  );
  if (month) {
    const monthIndex = MONTH_LOOKUP.get(month[1].toLowerCase())!;
    const monthYear = month[2] ? Number(month[2]) : now.getUTCMonth() + 1 < monthIndex + 1 ? year - 1 : year;
    const after = `${monthYear}-${String(monthIndex + 1).padStart(2, '0')}-01T00:00:00.000Z`;
    const before =
      monthIndex === 11
        ? `${monthYear + 1}-01-01T00:00:00.000Z`
        : `${monthYear}-${String(monthIndex + 2).padStart(2, '0')}-01T00:00:00.000Z`;
    return { takenAfter: after, takenBefore: before };
  }

  // "last week" / "last month" / "last year" / "today" / "yesterday"
  const relative = text.consume(/\b(today|yesterday|this week|last week|this month|last month|this year|last year)\b/i);
  if (relative) {
    const unit = relative[1].toLowerCase();
    const start = new Date(now);
    let before: Date | null = null;
    switch (unit) {
      case 'today': {
        start.setUTCHours(0, 0, 0, 0);
        break;
      }
      case 'yesterday': {
        start.setUTCDate(start.getUTCDate() - 1);
        start.setUTCHours(0, 0, 0, 0);
        before = new Date(start);
        before.setUTCDate(before.getUTCDate() + 1);
        break;
      }
      case 'this week': {
        start.setUTCDate(start.getUTCDate() - start.getUTCDay());
        start.setUTCHours(0, 0, 0, 0);
        break;
      }
      case 'last week': {
        start.setUTCDate(start.getUTCDate() - start.getUTCDay() - 7);
        start.setUTCHours(0, 0, 0, 0);
        before = new Date(start);
        before.setUTCDate(before.getUTCDate() + 7);
        break;
      }
      case 'this month': {
        start.setUTCDate(1);
        start.setUTCHours(0, 0, 0, 0);
        break;
      }
      case 'last month': {
        start.setUTCMonth(start.getUTCMonth() - 1);
        start.setUTCDate(1);
        start.setUTCHours(0, 0, 0, 0);
        before = new Date(start);
        before.setUTCMonth(before.getUTCMonth() + 1);
        break;
      }
      case 'this year': {
        start.setUTCMonth(0, 1);
        start.setUTCHours(0, 0, 0, 0);
        break;
      }
      case 'last year': {
        start.setUTCFullYear(year - 1, 0, 1);
        start.setUTCHours(0, 0, 0, 0);
        before = new Date(start);
        before.setUTCFullYear(year);
        break;
      }
    }
    return { takenAfter: start.toISOString(), takenBefore: before ? before.toISOString() : null };
  }

  return { takenAfter: null, takenBefore: null };
};

export const parseAskQuery = (input: string): ParsedAskQuery => {
  const text = new QueryText(input);
  const parsed: ParsedAskQuery = {
    query: null,
    city: null,
    country: null,
    takenAfter: null,
    takenBefore: null,
    mediaType: null,
    favorited: null,
    ocr: null,
  };

  // media type
  if (text.consume(/\b(videos?|clips|movies)\b/i)) {
    parsed.mediaType = 'VIDEO';
  } else if (text.consume(/\b(photos?|pictures?|pics|images?)\b/i)) {
    parsed.mediaType = 'IMAGE';
  }

  // favorites
  if (text.consume(/\b(favorit\w*|starred|loved|liked)\b/i)) {
    parsed.favorited = true;
  }

  // OCR text: "that says X" / "with text X" / "sign reading X"
  const ocr = text.consume(
    /\b(?:that|which)?\s?(?:says|said|reads?|reading|with the words?|with text)\s+(?:["“']?)(.+?)(?:["”']?)?(?=\s+(?:in|from|at|during|taken|photos?|videos?|pictures?)\b|[,.?!]|$)/i,
  );
  if (ocr) {
    parsed.ocr = strip(ocr[1]);
  }

  // places: "in Paris" / "at the beach in France" — capitalized proper noun after a place preposition
  const place = text.consume(/\b(?:in|at|around|near|from)\s+((?:[A-Z][\p{L}'’-]+[ \t]?)+"?\s?)+/u);
  if (place) {
    const candidate = strip(place[1].replaceAll(/["\u201c\u201d]/g, ''));
    // multi-word captures like "the beach" are not places; require a capitalized token
    const proper = candidate
      .split(/\s+/)
      .filter((word) => /^[A-Z]/.test(word))
      .join(' ');
    if (proper) {
      parsed.city = proper;
    }
  }

  const { takenAfter, takenBefore } = parseDateRange(text);
  parsed.takenAfter = takenAfter;
  parsed.takenBefore = takenBefore;

  const remainder = text.text();
  // generic filler that carries no search signal
  const cleaned = remainder
    .replaceAll(
      /\b(show|find|search|look for|give me|display|of|all|the|my|me|please|with|having|where|are|is|any)\b/gi,
      ' ',
    )
    .replaceAll(/\s+/g, ' ')
    .trim();
  parsed.query = cleaned.length > 0 ? cleaned : remainder.length > 0 ? remainder : null;

  return parsed;
};
