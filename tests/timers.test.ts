import { test } from "node:test";
import assert from "node:assert/strict";
import { advancePomo, isDue, reminderDue, mmss } from "../src/renderer/timers";

test("advancePomo: focus session -> short break", () => {
  const r = advancePomo("work", 0, 4);
  assert.equal(r.phase, "break");
  assert.equal(r.sessions, 1);
  assert.equal(r.alert, "break");
});

test("advancePomo: every 4th focus session -> long break", () => {
  const r = advancePomo("work", 3, 4);   // completing the 4th session
  assert.equal(r.phase, "long");
  assert.equal(r.sessions, 4);
  assert.equal(r.alert, "longbreak");
});

test("advancePomo: a break -> back to focus (session count unchanged)", () => {
  const r = advancePomo("break", 2, 4);
  assert.equal(r.phase, "work");
  assert.equal(r.sessions, 2);
  assert.equal(r.alert, "focus");
  assert.equal(advancePomo("long", 4, 4).phase, "work");
});

test("advancePomo: longEvery clamps to >= 1", () => {
  const r = advancePomo("work", 0, 0);   // 0 would divide-by-zero; clamps to 1
  assert.equal(r.phase, "long");
  assert.equal(r.alert, "longbreak");
});

test("advancePomo: full 1..8 session cycle puts long breaks at 4 and 8", () => {
  const longs: number[] = [];
  let phase: "work" | "break" | "long" = "work", sessions = 0;
  for (let i = 0; i < 16; i++) {
    const r = advancePomo(phase, sessions, 4);
    if (r.alert === "longbreak") longs.push(r.sessions);
    phase = r.phase; sessions = r.sessions;
  }
  assert.deepEqual(longs, [4, 8]);
});

test("isDue: only when set (>0) and time passed", () => {
  assert.equal(isDue(1000, 0), false);     // 0 = not scheduled
  assert.equal(isDue(999, 1000), false);
  assert.equal(isDue(1000, 1000), true);
  assert.equal(isDue(1500, 1000), true);
});

test("reminderDue: fires only after the interval, never when interval is 0", () => {
  assert.equal(reminderDue(5000, 0, 0), false);       // 0 = disabled
  assert.equal(reminderDue(5000, 0, 6000), false);
  assert.equal(reminderDue(7000, 0, 6000), true);
});

test("mmss: formats remaining ms, clamps negatives", () => {
  assert.equal(mmss(0), "0:00");
  assert.equal(mmss(-500), "0:00");
  assert.equal(mmss(5_000), "0:05");
  assert.equal(mmss(65_000), "1:05");
  assert.equal(mmss(25 * 60_000), "25:00");
});
