import { expect, test } from "bun:test";
import { applyCompletion, catalogVocabulary, completionContextAt, ruleCompletions } from "../src/frontend/rule-autocomplete.ts";

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

test("unified catalog discovers item names and category filters without visual slots", () => {
  const catalog = {
    "Material:Mushroom": { id: "Mushroom", name: "Mushroom", kind: "Material", icon: "icons/mushroom.webp" },
    "Consumable:Artifact Box Advanced": { id: "Artifact Box Advanced", name: "Box of Mastery", kind: "Consumable", icon: "icons/security_box_bw.webp" },
    "Card:Mushroom": { id: "Mushroom", name: "Shroom Card", kind: "Card", icon: "icons/card.webp" },
    "Gem:AtkSpd Gem": { id: "AtkSpd Gem", name: "Tempo Gem", kind: "Gem", icon: "icons/gem.webp" },
    "Cosmetic:Turtle": { id: "Turtle", name: "Turtle Baby Pet", kind: "Cosmetic", slot: "Cosmetic", icon: "icons/cosmetic-turtle.webp" },
    "Equipment:Abyss Shard": { id: "Abyss Shard", name: "Abyss Shard", kind: "Equipment", slot: "Dagger", icon: "icons/equip-abyss-shard.webp" },
  };
  const vocabulary = catalogVocabulary(catalog, []);

  expect(vocabulary.types).toEqual(expect.arrayContaining(["Material", "Consumable", "Card", "Gem", "Cosmetic", "Dagger"]));
  const typeContext = completionContextAt("  Type Con", 10)!;
  expect(ruleCompletions(typeContext, vocabulary).map((entry) => entry.value)).toContain("Consumable");
  const nameContext = completionContextAt("  Name Box", 10)!;
  expect(ruleCompletions(nameContext, vocabulary).map((entry) => entry.value)).toContain("Box of Mastery");
});
