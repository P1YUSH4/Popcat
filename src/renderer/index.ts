import { Cat } from "./Cat";
import { sound } from "./Sound";
import type { SpriteMeta } from "./types";

async function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function main(): Promise<void> {
  const canvas = document.getElementById("stage") as HTMLCanvasElement;
  const meta = (await fetch("assets/sprites/pao.json").then((r) => r.json())) as SpriteMeta;
  const sheet = await loadImage(`assets/sprites/${meta.image}`);

  const cat = new Cat(canvas, sheet, meta);
  window.cat = cat; // expose public API: window.cat.startThinking() / finishThinking()

  // tray-menu controls (the overlay isn't focusable, so DevTools isn't usable)
  window.bridge.onDo((action) => {
    if (action === "stretch") cat.stretch();
    else if (action === "jump") cat.finishThinking();
    else if (action === "confused") cat.confused();
    else if (action === "angry") cat.angry();
    else if (action === "thinking") cat.thinking();
    else if (action === "answerready") cat.answerReady();
    else if (action === "idle") cat.rest();
    else if (action === "celebrate") cat.celebrate();
    else if (action === "worried") cat.worried();
    else if (action === "hydrate") cat.hydrate();
    else if (action === "pomo:start") cat.startPomodoro();
    else if (action === "pomo:stop") cat.stopPomodoro();
    else if (action === "focus") cat.focusAlert();
    else if (action.startsWith("meeting:")) cat.scheduleMeeting(parseInt(action.split(":")[1], 10) || 0);
    else if (action === "mute:on") sound.muted = true;
    else if (action === "mute:off") sound.muted = false;
  });

  // custom timers from the settings window
  window.bridge.onSetPomodoro((cfg) => cat.configurePomodoro(cfg));
  window.bridge.onSetMeeting((cfg) => cat.scheduleMeeting(cfg.mins, cfg.label));

  // Cap to ~33fps: pixel-art animation timing is frame-duration based, so 33fps
  // looks the same as 60fps but roughly halves idle CPU.
  const MIN_DT = 1000 / 33;
  let last = performance.now();
  function frame(now: number): void {
    requestAnimationFrame(frame);
    const elapsed = now - last;
    if (elapsed < MIN_DT) return;            // skip frames faster than the cap
    last = now;
    cat.update(Math.min(0.05, elapsed / 1000)); // clamp dt (tab stalls)
    cat.render();
  }
  requestAnimationFrame(frame);

  // tiny console helper
  console.log("%cPao is awake 🐾  try: cat.startThinking() / cat.finishThinking()", "color:#7cc4d6");
}

main().catch((err) => console.error("[pao] failed to start", err));
