import { STAT_LABEL } from "../shared/stat-labels.ts";

export type CompletionKind =
  | "keyword"
  | "condition"
  | "item"
  | "type"
  | "stat"
  | "boundOperator"
  | "minimumOperator"
  | "statValue"
  | "countValue"
  | "percentValue"
  | "thresholdValue"
  | "highlight"
  | "background"
  | "border"
  | "sound"
  | "color";

export interface CompletionContext {
  readonly kind: CompletionKind;
  readonly token: string;
  readonly from: number;
  readonly to: number;
  readonly quoted?: boolean;
}

export interface RuleCompletion {
  readonly value: string;
  readonly detail?: string;
}

export interface RuleVocabulary {
  readonly items: readonly string[];
  readonly types: readonly string[];
  readonly sounds: readonly string[];
}

interface CatalogEntry {
  readonly name?: unknown;
  readonly slot?: unknown;
}

const KEYWORDS: readonly RuleCompletion[] = [
  { value: "Show", detail: "present matching items" },
  { value: "Hide", detail: "claim matching items silently" },
  { value: "Threshold", detail: "HighRolls cutoff" },
];

const CONDITIONS: readonly RuleCompletion[] = [
  { value: "Name", detail: "comma-separated item names" },
  { value: "Type", detail: "comma-separated item types" },
  { value: "Stat", detail: "matching stat condition" },
  { value: "RequireStat", detail: "stat required independently" },
  { value: "AnyOf", detail: "indented Stat alternatives" },
  { value: "AnyStat", detail: "any listed Stat may match" },
  { value: "AllStats", detail: "every listed Stat must match" },
  { value: "StatMatches", detail: "number of matching Stat lines" },
  { value: "AvgRollPct", detail: "average roll percentage" },
  { value: "TopRolls", detail: "displayed maximum roll count" },
  { value: "HighRolls", detail: "roll count at Threshold" },
  { value: "Refine", detail: "minimum refine level" },
  { value: "Chaos", detail: "has a Chaos effect" },
  { value: "NoChaos", detail: "has no Chaos effect" },
  { value: "Favorite", detail: "is marked favourite" },
  { value: "NotFavorite", detail: "is not marked favourite" },
  { value: "OverRoll", detail: "has a roll above its maximum" },
  { value: "NoOverRoll", detail: "has no roll above its maximum" },
  { value: "Unknown", detail: "is absent from the catalog" },
  { value: "Known", detail: "is present in the catalog" },
  { value: "Tag", detail: "short displayed label" },
  { value: "Color", detail: "#rrggbb display color" },
  { value: "Highlight", detail: "dot, mark, or glow" },
  { value: "Background", detail: "border, fill, or holo" },
  { value: "Border", detail: "on or off" },
  { value: "Sound", detail: "sound on item arrival" },
];

const BOUND_OPERATORS: readonly RuleCompletion[] = [
  { value: ">=", detail: "at least" },
  { value: ">", detail: "strictly above" },
  { value: "<=", detail: "at most" },
  { value: "<", detail: "strictly below" },
  { value: "=", detail: "exactly" },
];
const MINIMUM_OPERATORS = BOUND_OPERATORS.slice(0, 2);
const STAT_VALUES: readonly RuleCompletion[] = [
  { value: "1", detail: "printed value" },
  { value: "3", detail: "printed value" },
  { value: "5", detail: "printed value" },
  { value: "10", detail: "printed value" },
  { value: "90%", detail: "top 10% of its roll range" },
];
const COUNT_VALUES: readonly RuleCompletion[] = ["1", "2", "3", "4"].map((value) => ({ value }));
const PERCENT_VALUES: readonly RuleCompletion[] = ["35", "50", "75", "90"].map((value) => ({ value }));
const COLORS: readonly RuleCompletion[] = [
  { value: "#4ade80", detail: "green" },
  { value: "#7cc0ff", detail: "blue" },
  { value: "#c4a5ff", detail: "violet" },
  { value: "#f0b429", detail: "gold" },
  { value: "#ef6f6f", detail: "red" },
  { value: "#5eead4", detail: "aqua" },
];
const ARTIFACT_TYPES = ["Rune", "Jewel", "Scroll", "Relic"];

/** Build rule vocabulary from the renderer's catalog asset, never only the current bag. */
export function catalogVocabulary(catalog: unknown, sounds: readonly string[]): RuleVocabulary {
  const items = new Set<string>();
  const types = new Set<string>(ARTIFACT_TYPES);
  if (catalog && typeof catalog === "object") {
    for (const entry of Object.values(catalog as Record<string, CatalogEntry>)) {
      if (typeof entry.name === "string" && entry.name) items.add(entry.name);
      if (typeof entry.slot === "string" && entry.slot) types.add(entry.slot);
    }
  }
  return {
    items: [...items].sort((left, right) => left.localeCompare(right)),
    types: [...types].sort((left, right) => left.localeCompare(right)),
    sounds: [...new Set(sounds)].sort((left, right) => left.localeCompare(right)),
  };
}

/** Classify the supported runtime value at the caret and the complete token it should replace. */
export function completionContextAt(text: string, caret: number): CompletionContext | null {
  const position = Math.max(0, Math.min(caret, text.length));
  const lineStart = text.lastIndexOf("\n", position - 1) + 1;
  const lineEndIndex = text.indexOf("\n", position);
  const lineEnd = lineEndIndex < 0 ? text.length : lineEndIndex;
  const line = text.slice(lineStart, lineEnd);
  const localCaret = position - lineStart;
  const firstMatch = /^\s*(\S+)/.exec(line);
  const first = (firstMatch?.[1] ?? "").toLowerCase();
  if (insideComment(line, localCaret, first)) return null;

  if (!/^\s/.test(line)) {
    if (!firstMatch || localCaret <= firstMatch[0]!.length) return wordContext("keyword", text, position, lineStart, lineEnd);
    if (first === "threshold") return stagedContext(text, position, lineStart, lineEnd, firstMatch[0]!.length, ["thresholdValue"]);
    return null;
  }

  if (!firstMatch || localCaret <= firstMatch[0]!.length) return wordContext("condition", text, position, lineStart, lineEnd);
  const valuesStart = firstMatch[0]!.length;
  if (first === "name") return listContext("item", text, position, lineStart, lineEnd, valuesStart);
  if (first === "type") return listContext("type", text, position, lineStart, lineEnd, valuesStart);
  if (first === "stat" || first === "requirestat") {
    return stagedContext(text, position, lineStart, lineEnd, valuesStart, ["stat", "boundOperator", "statValue"]);
  }
  if (first === "statmatches" || first === "toprolls" || first === "highrolls" || first === "avgrollpct") {
    return stagedContext(text, position, lineStart, lineEnd, valuesStart, ["boundOperator", first === "avgrollpct" ? "percentValue" : "countValue"]);
  }
  if (first === "refine") return stagedContext(text, position, lineStart, lineEnd, valuesStart, ["minimumOperator", "countValue"]);
  if (first === "highlight") return stagedContext(text, position, lineStart, lineEnd, valuesStart, ["highlight"]);
  if (first === "background") return stagedContext(text, position, lineStart, lineEnd, valuesStart, ["background"]);
  if (first === "border") return stagedContext(text, position, lineStart, lineEnd, valuesStart, ["border"]);
  if (first === "sound") return stagedContext(text, position, lineStart, lineEnd, valuesStart, ["sound"]);
  if (first === "color" || first === "colour") return stagedContext(text, position, lineStart, lineEnd, valuesStart, ["color"]);
  return null;
}

export function ruleCompletions(context: CompletionContext, vocabulary: RuleVocabulary): RuleCompletion[] {
  switch (context.kind) {
    case "keyword": return filterCompletions(KEYWORDS, context.token);
    case "condition": return filterCompletions(CONDITIONS, context.token);
    case "item": return filterCompletions(vocabulary.items.map((value) => ({ value })), context.token, 80);
    case "type": return filterCompletions(vocabulary.types.map((value) => ({ value })), context.token);
    case "stat": return statCompletions(context.token);
    case "boundOperator": return filterCompletions(BOUND_OPERATORS, context.token);
    case "minimumOperator": return filterCompletions(MINIMUM_OPERATORS, context.token);
    case "statValue": return filterCompletions(STAT_VALUES, context.token);
    case "countValue": return filterCompletions(COUNT_VALUES, context.token);
    case "percentValue": return filterCompletions(PERCENT_VALUES, context.token);
    case "thresholdValue": return filterCompletions([{ value: "90", detail: "default cutoff" }], context.token);
    case "highlight": return filterCompletions(["dot", "mark", "glow"].map((value) => ({ value })), context.token);
    case "background": return filterCompletions(["border", "fill", "holo"].map((value) => ({ value })), context.token);
    case "border": return filterCompletions(["on", "off"].map((value) => ({ value })), context.token);
    case "sound": return filterCompletions(vocabulary.sounds.map((value) => ({ value })), context.token);
    case "color": return filterCompletions(COLORS, context.token);
  }
}

export function applyCompletion(text: string, context: CompletionContext, completion: RuleCompletion): { text: string; caret: number } {
  const quoted = context.kind === "item" && (context.quoted || /\s/.test(completion.value));
  const value = quoted ? `"${completion.value}"` : completion.value;
  const needsSpace = context.kind === "keyword" || context.kind === "condition" || context.kind === "boundOperator" || context.kind === "minimumOperator" || context.kind === "stat";
  const inserted = needsSpace ? `${value} ` : value;
  return { text: text.slice(0, context.from) + inserted + text.slice(context.to), caret: context.from + inserted.length };
}

export function editIndent(text: string, start: number, end: number, outdent: boolean): { text: string; selectionStart: number; selectionEnd: number } {
  const indent = "    ";
  if (!outdent && start === end) {
    return { text: text.slice(0, start) + indent + text.slice(end), selectionStart: start + indent.length, selectionEnd: end + indent.length };
  }
  const firstLineStart = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const selectionAnchor = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const lastLineStart = text.lastIndexOf("\n", Math.max(0, selectionAnchor - 1)) + 1;
  const nextBreak = text.indexOf("\n", lastLineStart);
  const blockEnd = nextBreak < 0 ? text.length : nextBreak;
  const lines = text.slice(firstLineStart, blockEnd).split("\n");
  if (!outdent) {
    const replacement = lines.map((line) => indent + line).join("\n");
    return {
      text: text.slice(0, firstLineStart) + replacement + text.slice(blockEnd),
      selectionStart: start + indent.length,
      selectionEnd: end + indent.length * lines.length,
    };
  }
  let removed = 0;
  let removedFromFirst = 0;
  const replacement = lines.map((line, index) => {
    const prefix = /^(?: {1,4}|\t)/.exec(line)?.[0] ?? "";
    if (index === 0) removedFromFirst = prefix.length;
    removed += prefix.length;
    return line.slice(prefix.length);
  }).join("\n");
  return {
    text: text.slice(0, firstLineStart) + replacement + text.slice(blockEnd),
    selectionStart: Math.max(firstLineStart, start - removedFromFirst),
    selectionEnd: Math.max(firstLineStart, end - removed),
  };
}

function insideComment(line: string, caret: number, first: string | undefined): boolean {
  if (first === "color" || first === "colour") {
    const firstHash = line.indexOf("#");
    const secondHash = firstHash < 0 ? -1 : line.indexOf("#", firstHash + 1);
    return secondHash >= 0 && caret > secondHash;
  }
  const comment = /(^|\s)#(?![0-9a-fA-F]{6}\b)/.exec(line);
  return comment !== null && caret > comment.index + comment[0].length - 1;
}

function wordContext(kind: "keyword" | "condition", text: string, caret: number, lineStart: number, lineEnd: number): CompletionContext {
  const from = wordStart(text, caret, lineStart);
  const to = wordEnd(text, caret, lineEnd);
  return { kind, token: text.slice(from, to), from, to };
}

function stagedContext(text: string, caret: number, lineStart: number, lineEnd: number, valuesStart: number, stages: readonly CompletionKind[]): CompletionContext | null {
  const localStart = lineStart + valuesStart;
  const before = text.slice(localStart, caret);
  const tokens = before.match(/\S+/g) ?? [];
  const trailingWhitespace = /\s$/.test(before);
  const stage = trailingWhitespace ? tokens.length : Math.max(0, tokens.length - 1);
  if (stage >= stages.length) return null;
  const kind = stages[stage]!;
  if (trailingWhitespace || tokens.length === 0) return { kind, token: "", from: caret, to: caret };
  const from = wordStart(text, caret, localStart);
  const to = wordEnd(text, caret, lineEnd);
  return { kind, token: text.slice(from, to), from, to };
}

function listContext(kind: "item" | "type", text: string, caret: number, lineStart: number, lineEnd: number, valuesStart: number): CompletionContext {
  const start = lineStart + valuesStart;
  let segmentStart = start;
  let segmentEnd = lineEnd;
  let quoted = false;
  for (let index = start; index < lineEnd; index++) {
    const char = text[index]!;
    if (char === "\"") quoted = !quoted;
    if (char === "#" && !quoted && /\s/.test(text[index - 1] ?? "")) {
      segmentEnd = index;
      break;
    }
    if (char === "," && !quoted) {
      if (index < caret) segmentStart = index + 1;
      else { segmentEnd = index; break; }
    }
  }
  let from = segmentStart;
  while (from < segmentEnd && /\s/.test(text[from]!)) from++;
  let to = segmentEnd;
  while (to > from && /\s/.test(text[to - 1]!)) to--;
  const isQuoted = text[from] === "\"";
  if (isQuoted) {
    from++;
    if (text[to - 1] === "\"") to--;
  }
  return { kind, token: text.slice(from, to), from: isQuoted ? from - 1 : from, to: isQuoted && text[to] === "\"" ? to + 1 : to, ...(isQuoted ? { quoted: true } : {}) };
}

function wordStart(text: string, caret: number, lowerBound: number): number {
  let start = caret;
  while (start > lowerBound && !/\s/.test(text[start - 1]!)) start--;
  return start;
}

function wordEnd(text: string, caret: number, upperBound: number): number {
  let end = caret;
  while (end < upperBound && !/\s/.test(text[end]!)) end++;
  return end;
}

function filterCompletions(completions: readonly RuleCompletion[], token: string, limit = 60): RuleCompletion[] {
  const query = token.toLocaleLowerCase();
  return completions
    .map((completion) => ({ completion, rank: matchRank(completion.value, query) }))
    .filter((entry): entry is { completion: RuleCompletion; rank: number } => entry.rank >= 0)
    .sort((left, right) => left.rank - right.rank || left.completion.value.localeCompare(right.completion.value))
    .slice(0, limit)
    .map((entry) => entry.completion);
}

function statCompletions(token: string): RuleCompletion[] {
  const query = token.toLocaleLowerCase();
  const normalizedQuery = query.replace(/[^a-z0-9]/g, "");
  return Object.entries(STAT_LABEL)
    .map(([value, label]) => ({
      value,
      detail: label,
      rank: Math.min(...[
        matchRank(value, query),
        matchRank(label, query),
        matchRank(value.replace(/[^a-z0-9]/gi, ""), normalizedQuery),
        matchRank(label.replace(/[^a-z0-9]/gi, ""), normalizedQuery),
      ].filter((rank) => rank >= 0)),
    }))
    .filter((entry) => Number.isFinite(entry.rank))
    .sort((left, right) => left.rank - right.rank || left.value.localeCompare(right.value))
    .map(({ value, detail }) => ({ value, detail }));
}

function matchRank(value: string, query: string): number {
  const normalized = value.toLocaleLowerCase();
  if (!query) return 1;
  if (normalized === query) return 0;
  if (normalized.startsWith(query)) return 1;
  return query.length > 1 && normalized.includes(query) ? 2 : -1;
}
