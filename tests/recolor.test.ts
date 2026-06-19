import { test } from "node:test";
import assert from "node:assert/strict";
import { swapPixels, furBellRules, isDefaultLook, clearBellSlits, FUR_PRESETS, BELL_COLORS } from "../src/renderer/recolor";

// Build a tiny RGBA buffer of named pixels so we can assert exact swaps.
function px(...colors: [number, number, number, number][]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(colors.length * 4);
  colors.forEach((c, i) => { d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = c[3]; });
  return d;
}
const at = (d: Uint8ClampedArray, i: number) => [d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4 + 3]];

test("ginger fur + red bell remaps fur/bell, leaves outline & pink alone", () => {
  const d = px(
    [255, 247, 247, 255],  // 0 fur body
    [208, 210, 218, 255],  // 1 fur shadow
    [255, 210, 77, 255],   // 2 bell
    [52, 48, 78, 255],     // 3 outline (untouched)
    [250, 152, 178, 255],  // 4 collar pink (untouched)
    [0, 0, 0, 0],          // 5 transparent (skipped)
  );
  swapPixels(d, furBellRules("ginger", "red"));
  const ginger = FUR_PRESETS.find((p) => p.id === "ginger")!;
  const red = BELL_COLORS.find((b) => b.id === "red")!.rgb!;
  assert.deepEqual(at(d, 0), [...ginger.body, 255]);
  assert.deepEqual(at(d, 1), [...ginger.shadow, 255]);
  assert.deepEqual(at(d, 2), [...red, 255]);
  assert.deepEqual(at(d, 3), [52, 48, 78, 255]);     // outline untouched
  assert.deepEqual(at(d, 4), [250, 152, 178, 255]);  // pink untouched
  assert.deepEqual(at(d, 5), [0, 0, 0, 0]);          // transparent untouched
});

test("hide bell makes the bell pixel transparent", () => {
  const d = px([255, 210, 77, 255]);
  swapPixels(d, furBellRules("classic", "hide"));
  assert.equal(d[3], 0);   // alpha cleared
});

test("classic + gold is the default look (no-op short-circuit)", () => {
  assert.equal(isDefaultLook("classic", "gold"), true);
  assert.equal(isDefaultLook("ginger", "gold"), false);
  assert.equal(isDefaultLook("classic", "red"), false);
  // classic preset must be identity so a default swap changes nothing
  const d = px([255, 247, 247, 255], [255, 210, 77, 255]);
  swapPixels(d, furBellRules("classic", "gold"));
  assert.deepEqual(at(d, 0), [255, 247, 247, 255]);
  assert.deepEqual(at(d, 1), [255, 210, 77, 255]);
});

test("hiding the bell also clears the enclosed outline 'slit' pixel", () => {
  // 3x3: bell ring around a center OUTLINE pixel (the slit), plus a lone outline
  // pixel on the body edge that has only ONE bell neighbour (must survive).
  const B: [number, number, number, number] = [255, 210, 77, 255]; // bell
  const O: [number, number, number, number] = [52, 48, 78, 255];   // outline / slit
  const F: [number, number, number, number] = [255, 247, 247, 255]; // fur
  // 5x3 grid: slit at idx6 enclosed by 4 bell pixels; a lone outline at idx4
  // with 0 bell neighbours (a body-outline pixel) must survive.
  const d = px(
    F, B, F, F, O,   // 0..4
    B, O, B, F, F,   // 5..9   (idx6 = slit)
    F, B, F, F, F,   // 10..14
  );
  clearBellSlits(d, 5);
  assert.equal(at(d, 6)[3], 0);                  // slit cleared (4 bell neighbours)
  assert.deepEqual(at(d, 4), [52, 48, 78, 255]); // body outline untouched
  // then the normal hide pass clears the bell pixels themselves
  swapPixels(d, furBellRules("classic", "hide"));
  assert.equal(at(d, 1)[3], 0);
});

test("unknown ids fall back to classic / gold", () => {
  const d = px([255, 247, 247, 255]);
  swapPixels(d, furBellRules("nope", "nope"));
  assert.deepEqual(at(d, 0), [255, 247, 247, 255]);   // unchanged (classic)
});
