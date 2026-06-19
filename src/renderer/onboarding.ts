// First-run onboarding: pick fur color, bell color, and a name, with a live
// preview. Each change is pushed via setConfig so the real overlay cat also
// updates live in the background; "Adopt" marks firstRunDone and closes.
import { recolorSheet, FUR_PRESETS, BELL_COLORS, type RGB } from "./recolor";
import type { SpriteMeta } from "./types";

const sel = { name: "Pao", furId: "classic", bellColor: "gold" };

const nameEl = document.getElementById("name") as HTMLInputElement;
const furBox = document.getElementById("fur") as HTMLElement;
const bellBox = document.getElementById("bell") as HTMLElement;
const canvas = document.getElementById("preview") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

let sheetImg: HTMLImageElement | null = null;
let idleRect = { x: 0, y: 0, w: 64, h: 64 };

const rgbCss = (c: RGB | null) => (c ? `rgb(${c[0]},${c[1]},${c[2]})` : "#fff");

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function push(): void {
  window.bridge.setConfig({ name: sel.name, furId: sel.furId, bellColor: sel.bellColor });
}

function draw(): void {
  if (!sheetImg) return;
  const recolored = recolorSheet(sheetImg, sel.furId, sel.bellColor);
  const scale = 2, size = 64 * scale;                     // 128px sprite
  const dx = (canvas.width - size) / 2, dy = (canvas.height - size) / 2 + 6;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(recolored, idleRect.x, idleRect.y, 64, 64, dx, dy, size, size);
}

function renderSwatches(): void {
  furBox.innerHTML = "";
  for (const p of FUR_PRESETS) {
    const b = document.createElement("button");
    b.className = "sw" + (p.id === sel.furId ? " on" : "");
    b.style.background = rgbCss(p.body);
    b.title = p.label;
    b.addEventListener("click", () => { sel.furId = p.id; renderSwatches(); draw(); push(); });
    furBox.appendChild(b);
  }
  bellBox.innerHTML = "";
  for (const c of BELL_COLORS) {
    const b = document.createElement("button");
    const on = c.id === sel.bellColor ? " on" : "";
    if (c.rgb === null) { b.className = "sw none" + on; b.textContent = "∅"; }
    else { b.className = "sw" + on; b.style.background = rgbCss(c.rgb); }
    b.title = c.label;
    b.addEventListener("click", () => { sel.bellColor = c.id; renderSwatches(); draw(); push(); });
    bellBox.appendChild(b);
  }
}

nameEl.addEventListener("input", () => { sel.name = nameEl.value.trim() || "Pao"; push(); });

document.getElementById("adopt")!.addEventListener("click", () => {
  sel.name = nameEl.value.trim() || "Pao";
  window.bridge.setConfig({ name: sel.name, furId: sel.furId, bellColor: sel.bellColor, firstRunDone: true });
  window.bridge.onboardingDone();
});

function applyConfig(cfg: import("./types").PaoConfig): void {
  sel.name = cfg.name || "Pao";
  sel.furId = cfg.furId || "classic";
  sel.bellColor = cfg.bellColor || "gold";
  if (document.activeElement !== nameEl) nameEl.value = cfg.name === "Pao" ? "" : cfg.name;
  renderSwatches(); draw();
}

async function init(): Promise<void> {
  const meta = (await fetch("assets/sprites/pao.json").then((r) => r.json())) as SpriteMeta;
  idleRect = meta.animations.idle.frames[0].rect;
  sheetImg = await loadImage(`assets/sprites/${meta.image}`);
  window.bridge.getConfig().then(applyConfig);
  window.bridge.onConfig(applyConfig);
  renderSwatches();
  draw();
}

init().catch((err) => console.error("[pao] onboarding failed", err));
