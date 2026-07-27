import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRhythm, stepEnergy, moodLabel, type Features } from "../src/renderer/Affect";
import { shortAppName, appCategory } from "../src/renderer/Perception";
import { nextStreak, yesterdayOf } from "../src/renderer/Achievements";
import { unlockedCoats } from "../src/renderer/Coats";
import { peakHours } from "../src/renderer/Patterns";

const MIN = 60_000;

// a calm, present-but-idle daytime baseline; override per-test
function base(overrides: Partial<Features> = {}): Features {
  return {
    idleMs: 1000, typingActive: false, typingRate: 0, scrolling: false,
    cursorSpeed: 0, appSwitchRate: 0, focusStreakMs: 0, sessionMs: 5 * MIN,
    hour: 14, ...overrides,
  };
}

test("AWAY when idle beyond 30s", () => {
  assert.equal(classifyRhythm(base({ idleMs: 45_000 })), "AWAY");
});

test("FOCUSED while actively typing", () => {
  assert.equal(classifyRhythm(base({ typingActive: true })), "FOCUSED");
});

test("FLOW after a long uninterrupted focus streak", () => {
  assert.equal(classifyRhythm(base({ focusStreakMs: 25 * MIN })), "FLOW");
});

test("SCATTERED on rapid window-hopping without typing", () => {
  assert.equal(classifyRhythm(base({ appSwitchRate: 8 })), "SCATTERED");
});

test("typing beats window-hopping (not scattered while actually working)", () => {
  assert.equal(classifyRhythm(base({ appSwitchRate: 8, typingActive: true })), "FOCUSED");
});

test("FATIGUED after a marathon session", () => {
  assert.equal(classifyRhythm(base({ sessionMs: 160 * MIN })), "FATIGUED");
});

test("WINDING_DOWN late at night when not actively typing", () => {
  assert.equal(classifyRhythm(base({ hour: 1, idleMs: 12_000 })), "WINDING_DOWN");
});

test("IDLE is the calm daytime default", () => {
  assert.equal(classifyRhythm(base()), "IDLE");
});

test("energy rises toward an active target and falls when away", () => {
  const active = stepEnergy(0.5, base({ typingActive: true }), 2);
  assert.ok(active > 0.5, "typing should raise energy");
  let e = 0.8;
  for (let i = 0; i < 30; i++) e = stepEnergy(e, base({ idleMs: 60_000 }), 1);
  assert.ok(e < 0.35, `idle energy should decay low, got ${e}`);
});

test("night lowers the energy target", () => {
  const day = stepEnergy(0.5, base({ hour: 14, idleMs: 2000 }), 2);
  const night = stepEnergy(0.5, base({ hour: 2, idleMs: 2000 }), 2);
  assert.ok(night < day, "night energy should be lower than day for the same activity");
});

test("energy stays clamped to [0,1]", () => {
  assert.ok(stepEnergy(1, base({ typingActive: true }), 100) <= 1);
  assert.ok(stepEnergy(0, base({ idleMs: 99_999 }), 100) >= 0);
});

test("moodLabel reflects the rhythm state", () => {
  assert.equal(moodLabel("FLOW", 0.8), "in the zone");
  assert.equal(moodLabel("AWAY", 0.2), "waiting for you");
  assert.equal(moodLabel("WINDING_DOWN", 0.2), "sleepy");
});

test("shortAppName extracts a readable label from window titles", () => {
  assert.equal(shortAppName("Cat.ts — Popcat — Visual Studio Code"), "Visual Studio Code");
  assert.equal(shortAppName("Inbox (3) - user@mail - Outlook"), "Outlook");
  assert.equal(shortAppName(""), null);
  assert.equal(shortAppName("   "), null);
});

test("appCategory classifies apps from their label", () => {
  assert.equal(appCategory("Visual Studio Code"), "editor");
  assert.equal(appCategory("Windows PowerShell"), "terminal");
  assert.equal(appCategory("Google Chrome"), "browser");
  assert.equal(appCategory("Discord"), "chat");
  assert.equal(appCategory("Figma"), "design");
  assert.equal(appCategory("Spotify"), "media");
  assert.equal(appCategory("Notepad"), "other");
  assert.equal(appCategory(null), "other");
});

test("yesterdayOf returns the previous calendar day", () => {
  assert.equal(yesterdayOf("2026-06-19"), "2026-06-18");
  assert.equal(yesterdayOf("2026-03-01"), "2026-02-28");   // non-leap year
  assert.equal(yesterdayOf("2026-01-01"), "2025-12-31");   // year rollover
});

test("peakHours: returns the busiest hours with enough data, sorted", () => {
  const h = new Array(24).fill(0);
  h[9] = 120; h[10] = 90; h[14] = 40; h[3] = 5;   // 3am has too little data
  assert.deepEqual(peakHours(h), [9, 10, 14]);
  assert.equal(peakHours(h).includes(3), false);   // below the 20-min floor
  assert.deepEqual(peakHours(new Array(24).fill(0)), []);  // no data -> no peaks
});

test("unlockedCoats: default always unlocked, others gated by achievements", () => {
  const none = unlockedCoats([]);
  assert.ok(none.has("default"));
  assert.equal(none.has("warmgrey"), false);     // needs 'flow'
  const some = unlockedCoats(["flow", "night_owl"]);
  assert.ok(some.has("warmgrey"));               // flow -> warmgrey
  assert.ok(some.has("chocolate"));              // night_owl -> chocolate
  assert.equal(some.has("plum"), false);         // streak_7 not earned
});

test("nextStreak: consecutive days increment, gaps reset, same day holds", () => {
  assert.equal(nextStreak("2026-06-18", "2026-06-19", 4), 5);  // yesterday -> +1
  assert.equal(nextStreak("2026-06-15", "2026-06-19", 4), 1);  // gap -> reset
  assert.equal(nextStreak("2026-06-19", "2026-06-19", 4), 4);  // same day -> hold
  assert.equal(nextStreak("", "2026-06-19", 0), 1);            // first ever -> 1
});
