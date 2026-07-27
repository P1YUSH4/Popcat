/**
 * Accessories — little pixel cosmetics drawn over the cat's head/neck at runtime
 * (so they can be toggled without baking every combination into the sheet).
 * Like coats, each is EARNED via an achievement — more reasons to keep the cat around.
 */
export interface Accessory { name: string; label: string; }

export const ACCESSORIES: Accessory[] = [
  { name: "none", label: "None" },
  { name: "bow", label: "Pink Bow" },
  { name: "scarf", label: "Cozy Scarf" },
  { name: "hat", label: "Party Hat" },
  { name: "crown", label: "Gold Crown" },
];

export const ACCESSORY_UNLOCKS: Record<string, string> = {
  bow: "first_paw",       // available from the start
  scarf: "first_focus",
  hat: "multitask",
  crown: "streak_7",
};

export function findAccessory(name: string): Accessory | undefined { return ACCESSORIES.find((a) => a.name === name); }
export function accessoryLabel(name: string): string { return findAccessory(name)?.label ?? name; }
export function accessoryRequirement(name: string): string | undefined { return ACCESSORY_UNLOCKS[name]; }

export function unlockedAccessories(achievementIds: string[]): Set<string> {
  const s = new Set<string>(["none"]);
  for (const a of ACCESSORIES) {
    const req = ACCESSORY_UNLOCKS[a.name];
    if (!req || achievementIds.includes(req)) s.add(a.name);
  }
  return s;
}
