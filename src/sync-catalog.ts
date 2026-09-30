import path from "node:path";
import { catalogKey, type CatalogEntry, type CatalogKind, type ItemCatalog } from "./shared/item-catalog.ts";

const DEFAULT_SOURCE = "https://spiritvalers.com";
const ARTIFACT_SLOTS = ["Rune", "Jewel", "Scroll", "Relic"] as const;
const EQUIPMENT_SECTIONS: Readonly<Record<string, string>> = {
  Accessory: "Accessory",
  Back: "Accessory",
  Eyewear: "Accessory",
  Book: "Offhand",
  Shield: "Offhand",
  Chest: "Armor",
  Feet: "Armor",
  Head: "Armor",
  Legs: "Armor",
  Grimoire: "Grimoire",
  Axe: "Weapon",
  Bow: "Weapon",
  Dagger: "Weapon",
  GatlingGun: "Weapon",
  Katar: "Weapon",
  Launcher: "Weapon",
  Mace: "Weapon",
  Pistol: "Weapon",
  Rifle: "Weapon",
  Scythe: "Weapon",
  Shotgun: "Weapon",
  Spear: "Weapon",
  Sword: "Weapon",
  Twinblade: "Weapon",
  Wand: "Weapon",
};

type SourceItem = { id: string; name: string; sprite?: string; slug?: string };
type Equipment = SourceItem & { slot: string };
type Gem = SourceItem & { isBoss: boolean };
type Artifact = SourceItem & { icons: string[] };
type Cosmetic = SourceItem & { slot?: string; icon?: string };
type SupplementalCosmetic = { name: string; kind: "Cosmetic"; icon?: string };
type Source = {
  readJson: (relativePath: string) => Promise<unknown>;
  readBytes: (relativePath: string) => Promise<Uint8Array>;
  label: string;
};
type Artwork = { output: string; bytes: Uint8Array; generated: boolean };
type ArtworkSource = { origin: "published" | "supplemental"; source: string };

function isRemoteSource(source: string): boolean {
  return source.startsWith("https://") || source.startsWith("http://");
}

function sourcePath(relativePath: string): string {
  if (!relativePath || relativePath.startsWith("/") || relativePath.includes("..")) {
    throw new Error(`Unsafe source path: ${relativePath}`);
  }
  return relativePath;
}

function remoteSource(baseUrl: string): Source {
  const base = baseUrl.replace(/\/+$/, "");
  const load = async (relativePath: string): Promise<Response> => {
    const response = await fetch(`${base}/${sourcePath(relativePath)}`);
    if (!response.ok) throw new Error(`Could not fetch ${relativePath}: HTTP ${response.status}`);
    return response;
  };
  return {
    label: base,
    async readJson(relativePath) {
      return load(relativePath).then((response) => response.json());
    },
    async readBytes(relativePath) {
      const bytes = new Uint8Array(await (await load(relativePath)).arrayBuffer());
      if (!bytes.byteLength) throw new Error(`Empty artwork: ${relativePath}`);
      return bytes;
    },
  };
}

function localSource(directory: string): Source {
  const root = path.resolve(directory);
  const read = async (relativePath: string): Promise<Uint8Array> => {
    const file = Bun.file(path.join(root, sourcePath(relativePath)));
    if (!(await file.exists())) throw new Error(`Missing source file: ${relativePath}`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!bytes.byteLength) throw new Error(`Empty source file: ${relativePath}`);
    return bytes;
  };
  return {
    label: root,
    async readJson(relativePath) {
      try {
        return JSON.parse(new TextDecoder().decode(await read(relativePath)));
      } catch (error) {
        throw new Error(`Invalid JSON in ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    readBytes: read,
  };
}

function requiredArray<T>(value: unknown, sourceName: string): T[] {
  if (!Array.isArray(value)) throw new Error(`${sourceName} must be an array`);
  return value as T[];
}

function requiredCosmetics(value: unknown): Cosmetic[] {
  if (!value || typeof value !== "object" || !("items" in value) || !Array.isArray(value.items)) {
    throw new Error("wiki-data/cosmetics.json must contain an items array");
  }
  return value.items as Cosmetic[];
}

function requiredSupplementalCosmetics(value: unknown): Record<string, SupplementalCosmetic> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("assets/cosmetics.json must be an object");
  }
  const cosmetics: Record<string, SupplementalCosmetic> = {};
  for (const [id, item] of Object.entries(value)) {
    if (!item || typeof item !== "object" || !("name" in item) || typeof item.name !== "string"
      || !("kind" in item) || item.kind !== "Cosmetic"
      || ("icon" in item && item.icon !== undefined && typeof item.icon !== "string")) {
      throw new Error(`Invalid supplemental cosmetic: ${id}`);
    }
    cosmetics[id] = { name: item.name, kind: "Cosmetic", ...(typeof item.icon === "string" ? { icon: item.icon } : {}) };
  }
  return cosmetics;
}

function requireItem(item: SourceItem, sourceName: string): void {
  if (!item || typeof item.id !== "string" || !item.id || typeof item.name !== "string" || !item.name) {
    throw new Error(`${sourceName} contains an item without a non-empty id and name`);
  }
}

function sourceIconFile(relativePath: string): string {
  const safe = relativePath.replace(/[^A-Za-z0-9._-]+/g, "-").toLowerCase();
  if (!safe.endsWith(".webp")) throw new Error(`Expected WebP artwork, got ${relativePath}`);
  return `icons/published-${safe}`;
}

function publishedIcon(relativePath: string): { source: string; output: string } {
  return { source: sourcePath(relativePath), output: sourceIconFile(relativePath) };
}

function entry(
  id: string,
  name: string,
  kind: CatalogKind,
  icon: string | null,
  wiki: string | null,
  section: string | null = null,
  slot: string | null = null,
): CatalogEntry {
  return { id, name, kind, icon, wiki, section, slot };
}

function add(catalog: Record<string, CatalogEntry>, item: CatalogEntry, artifactSlot?: string): void {
  const key = catalogKey(item.kind, item.id, artifactSlot);
  if (catalog[key]) throw new Error(`Duplicate catalog key: ${key}`);
  catalog[key] = item;
}

function difference(previous: ItemCatalog, next: ItemCatalog): Record<string, number> {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const key of keys) {
    if (!(key in previous)) added += 1;
    else if (!(key in next)) removed += 1;
    else if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) changed += 1;
  }
  return { added, removed, changed };
}


async function loadArtwork(artwork: Map<string, ArtworkSource>, source: Source): Promise<Artwork[]> {
  const sources = [...artwork.entries()];
  const files = new Array<Artwork>(sources.length);
  let next = 0;
  const workers = Math.min(8, sources.length);
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < sources.length) {
      const index = next++;
      const [output, image] = sources[index]!;
      const bytes = image.origin === "published"
        ? await source.readBytes(image.source)
        : new Uint8Array(await Bun.file(path.join("assets", image.source)).arrayBuffer());
      if (bytes.length < 12
        || bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46
        || bytes[8] !== 0x57 || bytes[9] !== 0x45 || bytes[10] !== 0x42 || bytes[11] !== 0x50) {
        throw new Error(`Missing or invalid WebP artwork: ${image.source}`);
      }
      files[index] = { output, bytes, generated: image.origin === "published" };
    }
  }));
  return files;
}
async function main(): Promise<void> {
  const sourceArgument = Bun.argv[2] ?? DEFAULT_SOURCE;
  const source = isRemoteSource(sourceArgument) ? remoteSource(sourceArgument) : localSource(sourceArgument);
  const [equipment, cards, gems, artifacts, materials, consumables, releasedCosmetics, supplemental] = await Promise.all([
    source.readJson("equip-configs.json").then((value) => requiredArray<Equipment>(value, "equip-configs.json")),
    source.readJson("card-configs.json").then((value) => requiredArray<SourceItem>(value, "card-configs.json")),
    source.readJson("gem-configs.json").then((value) => requiredArray<Gem>(value, "gem-configs.json")),
    source.readJson("artifact-configs.json").then((value) => requiredArray<Artifact>(value, "artifact-configs.json")),
    source.readJson("wiki-data/materials.json").then((value) => requiredArray<SourceItem>(value, "wiki-data/materials.json")),
    source.readJson("wiki-data/consumables.json").then((value) => requiredArray<SourceItem>(value, "wiki-data/consumables.json")),
    source.readJson("wiki-data/cosmetics.json").then(requiredCosmetics),
    Bun.file("assets/cosmetics.json").json().then(requiredSupplementalCosmetics),
  ]);

  const catalog: Record<string, CatalogEntry> = {};
  const artwork = new Map<string, ArtworkSource>();
  const registerPublishedArtwork = (relativePath: string): string => {
    const image = publishedIcon(relativePath);
    const prior = artwork.get(image.output);
    if (prior && (prior.origin !== "published" || prior.source !== image.source)) {
      throw new Error(`Ambiguous artwork mapping for ${image.output}`);
    }
    artwork.set(image.output, { origin: "published", source: image.source });
    return image.output;
  };
  const registerSupplementalArtwork = (relativePath: string): string => {
    const assetPath = sourcePath(relativePath);
    const prior = artwork.get(assetPath);
    if (prior && (prior.origin !== "supplemental" || prior.source !== assetPath)) {
      throw new Error(`Ambiguous artwork mapping for ${assetPath}`);
    }
    artwork.set(assetPath, { origin: "supplemental", source: assetPath });
    return assetPath;
  };

  for (const item of equipment) {
    requireItem(item, "equip-configs.json");
    const section = EQUIPMENT_SECTIONS[item.slot];
    if (!section) throw new Error(`Unknown equipment slot ${item.slot} for ${item.id}`);
    const wikiCategory = item.slot === "Grimoire" ? "grimoires" : "equipment";
    add(catalog, entry(item.id, item.name, "Equipment", registerPublishedArtwork(`content/game/icons/equip-${item.sprite || item.id}.webp`), `https://spiritvalers.com/#/${wikiCategory}/${encodeURIComponent(item.id)}`, section, item.slot));
  }
  for (const item of cards) {
    requireItem(item, "card-configs.json");
    add(catalog, entry(item.id, item.name, "Card", registerPublishedArtwork(`content/game/icons/${item.sprite || "card"}.webp`), `https://spiritvalers.com/#/cards/${encodeURIComponent(item.id)}`));
  }
  for (const item of gems) {
    requireItem(item, "gem-configs.json");
    if (typeof item.isBoss !== "boolean") throw new Error(`Gem ${item.id} is missing isBoss`);
    add(catalog, entry(item.id, item.name, "Gem", registerPublishedArtwork(`content/game/icons/item-gem-${item.isBoss ? "boss" : "skill"}.webp`), `https://spiritvalers.com/#/gems/${encodeURIComponent(item.id)}`));
  }
  for (const item of artifacts) {
    requireItem(item, "artifact-configs.json");
    if (!Array.isArray(item.icons) || item.icons.length !== ARTIFACT_SLOTS.length || item.icons.some((icon) => typeof icon !== "string" || !icon)) {
      throw new Error(`Artifact ${item.id} must supply exactly four piece icons`);
    }
    const wiki = `https://spiritvalers.com/#/artifacts/${encodeURIComponent(item.id)}`;
    add(catalog, entry(item.id, item.name, "Artifact", registerPublishedArtwork(item.icons[0]!), wiki));
    ARTIFACT_SLOTS.forEach((slot, index) => {
      add(catalog, entry(item.id, `${item.name} ${slot}`, "Artifact", registerPublishedArtwork(item.icons[index]!), wiki, null, slot), slot);
    });
  }
  for (const item of materials) {
    requireItem(item, "wiki-data/materials.json");
    if (!item.slug || !item.sprite) throw new Error(`Material ${item.id} is missing slug or sprite`);
    add(catalog, entry(item.id, item.name, "Material", registerPublishedArtwork(`wiki-data/icons/${item.sprite}.webp`), `https://spiritvalers.com/#/materials/${encodeURIComponent(item.slug)}`));
  }
  for (const item of consumables) {
    requireItem(item, "wiki-data/consumables.json");
    if (!item.slug || !item.sprite) throw new Error(`Consumable ${item.id} is missing slug or sprite`);
    add(catalog, entry(item.id, item.name, "Consumable", registerPublishedArtwork(`wiki-data/icons/${item.sprite}.webp`), `https://spiritvalers.com/#/consumables/${encodeURIComponent(item.slug)}`));
  }
  for (const [id, item] of Object.entries(supplemental)) {
    if (!item || item.kind !== "Cosmetic" || !item.name) throw new Error(`Invalid supplemental cosmetic: ${id}`);
    add(catalog, entry(id, item.name, "Cosmetic", item.icon ? registerSupplementalArtwork(item.icon) : null, null, null, "Cosmetic"));
  }
  const releasedCosmeticIds = new Set<string>();
  for (const item of releasedCosmetics) {
    requireItem(item, "wiki-data/cosmetics.json");
    if (releasedCosmeticIds.has(item.id)) throw new Error(`Duplicate released cosmetic id: ${item.id}`);
    releasedCosmeticIds.add(item.id);
    const key = catalogKey("Cosmetic", item.id);
    const icon = item.icon ? registerPublishedArtwork(item.icon) : null;
    catalog[key] = entry(item.id, item.name, "Cosmetic", icon, null, item.slot ?? null, "Cosmetic");
  }

  const files = await loadArtwork(artwork, source);

  const orderedCatalog = Object.fromEntries(Object.entries(catalog).sort(([left], [right]) => left.localeCompare(right)));
  const outputPath = "assets/catalog.json";
  const previous = await Bun.file(outputPath).exists()
    ? await Bun.file(outputPath).json()
    : {};
  const counts = Object.values(orderedCatalog).reduce<Record<string, number>>((total, item) => {
    total[item.kind] = (total[item.kind] ?? 0) + 1;
    return total;
  }, {});

  // All source data and artwork have loaded successfully; only now mutate generated outputs.
  for (const file of files) {
    if (file.generated) await Bun.write(path.join("assets", file.output), file.bytes);
  }
  await Bun.write(outputPath, `${JSON.stringify(orderedCatalog, null, 2)}\n`);

  const copiedArtwork = files.filter((file) => file.generated).length;
  console.log(JSON.stringify({
    source: source.label,
    entries: Object.keys(orderedCatalog).length,
    counts,
    artwork: { copied: copiedArtwork, supplementalValidated: files.length - copiedArtwork },
    sourceDifferences: difference(previous, orderedCatalog),
    cosmetics: { supplemental: Object.keys(supplemental).length, releasedOverlay: releasedCosmetics.length },
  }, null, 2));
}

await main();
