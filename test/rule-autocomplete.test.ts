import { expect, test } from "bun:test";
import { applyCompletion, completionContextAt, ruleCompletions } from "../src/frontend/rule-autocomplete.ts";

const vocabulary = { items: ["Kunai", "Master Sword"], types: ["Sword"], sounds: ["chime"] };

test("friendly stat spelling completes to the parser's canonical identifier", () => {
  const text = "    Stat AttackSpeed";
  const context = completionContextAt(text, text.length)!;
  const suggestion = ruleCompletions(context, vocabulary).find((entry) => entry.value === "AtkSpd");
  expect(suggestion).toBeDefined();
  expect(applyCompletion(text, context, suggestion!).text).toBe("    Stat AtkSpd ");
});

test("item completion preserves quoted list neighbors and an inline comment", () => {
  const text = '    Name "Kunai", "Master Sw" # keep this note';
  const context = completionContextAt(text, text.indexOf('" #'))!;
  const suggestion = ruleCompletions(context, vocabulary).find((entry) => entry.value === "Master Sword")!;
  const result = applyCompletion(text, context, suggestion);
  expect(result.text).toBe('    Name "Kunai", "Master Sword" # keep this note');
  expect(result.caret).toBe(result.text.indexOf(" #"));
});
