import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyContext, isWorkMode } from "../src/renderer/context";

test("coding-practice sites -> focus", () => {
  assert.equal(classifyContext("chrome", "Two Sum - LeetCode"), "focus");
  assert.equal(classifyContext("firefox", "Problemset - Codeforces"), "focus");
});

test("AI assistants -> ai", () => {
  assert.equal(classifyContext("Google Chrome", "New chat — Claude"), "ai");
  assert.equal(classifyContext("chrome", "ChatGPT"), "ai");
});

test("editors / terminals -> coding", () => {
  assert.equal(classifyContext("Code.exe", "main.ts - ComNyang - Visual Studio Code"), "coding");
  assert.equal(classifyContext("WindowsTerminal.exe", "pwsh"), "coding");
  assert.equal(classifyContext("pycharm64.exe", "app.py - myproj"), "coding");
});

test("dev tools / sites -> coding (work, not leisure)", () => {
  assert.equal(classifyContext("chrome", "P1YUSH4/Popcat - GitHub"), "coding");
  assert.equal(classifyContext("chrome", "node.js - how to … - Stack Overflow"), "coding");
  assert.equal(classifyContext("Postman", "My Workspace"), "coding");
  assert.equal(classifyContext("chrome", "Pipelines - GitLab"), "coding");
});

test("leisure sites -> leisure", () => {
  assert.equal(classifyContext("chrome", "lofi beats - YouTube"), "leisure");
  assert.equal(classifyContext("firefox", "reddit - dive into anything"), "leisure");
  assert.equal(classifyContext("chrome", "Stranger Things - Netflix"), "leisure");
});

test("smart video: coding tutorial -> focus, entertainment -> leisure", () => {
  assert.equal(classifyContext("chrome", "React useEffect Tutorial - YouTube"), "focus");
  assert.equal(classifyContext("chrome", "System Design Interview course - YouTube"), "focus");
  assert.equal(classifyContext("chrome", "Funny Cat Compilation - YouTube"), "leisure");
  assert.equal(classifyContext("chrome", "Top 10 goals - YouTube"), "leisure");
});

test("web research (search) -> coding", () => {
  assert.equal(classifyContext("chrome", "typescript generics - Google Search"), "coding");
  assert.equal(classifyContext("firefox", "Array.prototype.reduce - Wikipedia"), "coding");
});

test("unknown -> neutral", () => {
  assert.equal(classifyContext("explorer.exe", "Downloads"), "neutral");
  assert.equal(classifyContext("", ""), "neutral");
});

test("isWorkMode covers focus/coding/ai, not leisure/neutral", () => {
  assert.equal(isWorkMode("focus"), true);
  assert.equal(isWorkMode("coding"), true);
  assert.equal(isWorkMode("ai"), true);
  assert.equal(isWorkMode("leisure"), false);
  assert.equal(isWorkMode("neutral"), false);
});
