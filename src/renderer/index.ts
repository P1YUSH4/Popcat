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
    else if (action === "pomo:pause") cat.pausePomodoro();
    else if (action === "pomo:resume") cat.resumePomodoro();
    else if (action === "pomo:skip") cat.skipPomodoro();
    else if (action === "focus") cat.focusAlert();
    else if (action.startsWith("meeting:")) cat.scheduleMeeting(parseInt(action.split(":")[1], 10) || 0);
    else if (action === "mute:on") sound.muted = true;
    else if (action === "mute:off") sound.muted = false;
  });

  // custom timers from the settings window
  window.bridge.onSetPomodoro((cfg) => cat.configurePomodoro(cfg));
  window.bridge.onSetMeeting((cfg) => {
    if (typeof cfg.atMs === "number") cat.scheduleMeetingAt(cfg.atMs, cfg.label, cfg.preMin);
    else cat.scheduleMeeting(cfg.mins ?? 0, cfg.label, cfg.preMin);
  });

  // persisted settings: apply on load + on every change
  try { cat.applyConfig(await window.bridge.getConfig()); } catch { /* defaults */ }
  window.bridge.onConfig((cfg) => cat.applyConfig(cfg));

  // dev-tool reactions (git / tests / CI via the `pao` CLI or control server)
  window.bridge.onReact(({ type, msg }) => cat.react(type, msg));

  // unlock audio on the first interaction (autoplay-policy fallback)
  window.addEventListener("mousedown", () => sound.unlock(), { once: true });

  // Adaptive frame rate: ~33fps while the cat is doing something, but drop to
  // ~6fps when it's just sitting/sleeping (pixel-art timing is frame-duration
  // based, so this is invisible) — big idle-CPU saving for an always-on app.
  const DT_ACTIVE = 1000 / 33, DT_CALM = 1000 / 6;
  let last = performance.now();
  function frame(now: number): void {
    requestAnimationFrame(frame);
    const elapsed = now - last;
    const minDt = cat.lowActivity() ? DT_CALM : DT_ACTIVE;
    if (elapsed < minDt) return;             // skip frames faster than the cap
    last = now;
    cat.update(Math.min(0.05, elapsed / 1000)); // clamp dt (tab stalls)
    cat.render();
  }
  requestAnimationFrame(frame);

  // tiny console helper
  console.log("%cPao is awake 🐾  try: cat.startThinking() / cat.finishThinking()", "color:#7cc4d6");
}

main().catch((err) => console.error("[pao] failed to start", err));
