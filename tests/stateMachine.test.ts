import { test } from "node:test";
import assert from "node:assert/strict";
import { StateMachine } from "../src/renderer/StateMachine";

test("starts in IDLE, unlocked", () => {
  const sm = new StateMachine();
  assert.equal(sm.state, "IDLE");
  assert.equal(sm.locked, false);
});

test("transition changes state and resets `since`", () => {
  const sm = new StateMachine();
  sm.update(1.5);
  assert.ok(sm.since >= 1.5);
  sm.transition("WALK");
  assert.equal(sm.state, "WALK");
  assert.equal(sm.since, 0);
});

test("lock blocks new transitions but allows same-state and unlock", () => {
  const sm = new StateMachine();
  sm.transition("DRAG", { lock: true });
  assert.equal(sm.locked, true);
  assert.equal(sm.can("WALK"), false);     // locked: cannot switch away
  assert.equal(sm.can("DRAG"), true);      // same state always allowed
  sm.unlock();
  assert.equal(sm.can("WALK"), true);
});

test("enter/exit hooks fire on transition", () => {
  const sm = new StateMachine();
  const events: string[] = [];
  sm.on("WALK", { enter: () => events.push("enter-walk"), exit: () => events.push("exit-walk") });
  sm.on("RUN", { enter: () => events.push("enter-run") });
  sm.transition("WALK");
  sm.transition("RUN");
  assert.deepEqual(events, ["enter-walk", "exit-walk", "enter-run"]);
});

test("transition to the same state is a no-op (no hook re-fire)", () => {
  const sm = new StateMachine();
  let enters = 0;
  sm.on("WALK", { enter: () => enters++ });
  sm.transition("WALK");
  sm.transition("WALK");
  assert.equal(enters, 1);
});

test("update advances `since` and runs the state's update hook", () => {
  const sm = new StateMachine();
  let dt = 0;
  sm.on("IDLE", { update: (d) => { dt += d; } });
  sm.update(0.5);
  sm.update(0.5);
  assert.equal(dt, 1);
  assert.ok(Math.abs(sm.since - 1) < 1e-9);
});
