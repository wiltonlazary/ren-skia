// Placement and stacking on a CanvasKit surface: absolute items painted
// and pressed in z order, a change of order alone repainted by damage with
// the pixels of a full repaint, an item's getBoundingClientRect, and an
// Action holding content painted inside it.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { $root, $signal, $read, $write } from 'rrx-core';
import { View, Label, Action } from 'ren-core';
import { $skia, render, loadLayout } from 'ren-skia';
import { setFlagsFromString } from 'node:v8';

// Each WebAssembly memory reserves its whole range up front: 1 GB each (Taffy's, CanvasKit's) keeps
// the process under the address cap the tests run with (.ai/config/resources.md, from the rui root).
setFlagsFromString('--wasm-max-mem-pages=16384');
await loadLayout();

const font = readFileSync(new URL('../assets/font.ttf', import.meta.url));
/** @type {any} */
let kit;

before(async () => {
  const CanvasKitInit = (await import('canvaskit-wasm')).default;
  kit = await CanvasKitInit();
});

/** The RGBA pixels of a renderer's surface. @param {any} skia */
const pixels = skia => Buffer.from(skia.surface.getCanvas().readPixels(0, 0, { width: skia.width, height: skia.height, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB }));
/** The color at a point, as [r, g, b]. @param {any} skia @param {number} x @param {number} y */
const at = (skia, x, y) => {
  const p = pixels(skia);
  const k = (y * skia.width + x) * 4;
  return [p[k], p[k + 1], p[k + 2]];
};

describe('ren skia placement and stacking', () => {
  it('paints and presses overlapping items in z order, and repaints a change of order alone as a full repaint would', () => {
    const run = (/** @type {boolean} */ partial) => {
      const skia = $skia(kit, { font, width: 200, height: 150 });
      skia.partial = partial;
      const root = $root('app');
      const z = $signal(root, 1);
      /** @type {string[]} */
      const pressed = [];
      const box = { position: 'absolute', top: 20, width: 60, height: 60 };
      render(() => (
        <View style={{ height: 150 }}>
          <View style={() => ({ ...box, left: 20, zIndex: $read(z), background: '#ff0000' })} onPress={() => pressed.push('red')} />
          <View style={{ ...box, left: 50, zIndex: 2, background: '#0000ff' }} onPress={() => pressed.push('blue')} />
          <Label text="under" style={{ margin: [100, 0, 0, 0] }} />
        </View>
      ), skia, { root });
      return { skia, z, pressed };
    };
    const full = run(false);
    const part = run(true);
    assert.deepEqual(at(part.skia, 65, 50), [0, 0, 255], 'blue (2) over red (1)');
    part.skia.press(65, 50);
    assert.deepEqual(part.pressed, ['blue']);
    $write(full.z, 3);
    $write(part.z, 3);
    full.skia.present();
    part.skia.present();
    assert.equal(part.skia.repaint, 'damage');
    assert.deepEqual(at(part.skia, 65, 50), [255, 0, 0], 'red (3) over blue now');
    assert.ok(pixels(part.skia).equals(pixels(full.skia)), 'the damage repaint has the pixels of a full one');
    part.skia.press(65, 50);
    assert.deepEqual(part.pressed, ['blue', 'red']);
    const red = /** @type {any} */ (part.skia.root.first?.first);
    assert.deepEqual(red.getBoundingClientRect(), { x: 20, y: 20, left: 20, top: 20, right: 80, bottom: 80, width: 60, height: 60 });
    full.skia.close();
    part.skia.close();
  });

  it('paints what an Action holds inside it, and presses the Action from it', () => {
    const skia = $skia(kit, { font, width: 200, height: 100 });
    let presses = 0;
    /** @type {any} */
    let label = null;
    render(() => (
      <View style={{ align: 'start', padding: 10 }}>
        <Action onPress={() => presses++}>
          <Label ref={(/** @type {any} */ n) => (label = n)} text="inside action" />
        </Action>
      </View>
    ), skia);
    assert.ok(skia.commands().some((/** @type {any[]} */ c) => c[0] === 'text' && c[1] === 'inside action'));
    const r = label.getBoundingClientRect();
    // Its text is painted in the Action's paper color on its accent fill.
    const p = pixels(skia);
    let light = 0;
    for (let y = Math.ceil(r.top); y < Math.floor(r.bottom); y++)
      for (let x = Math.ceil(r.left); x < Math.floor(r.right); x++) {
        const k = (y * skia.width + x) * 4;
        if (p[k] > 200 && p[k + 1] > 200 && p[k + 2] > 200) light++;
      }
    assert.ok(light > 20, `text pixels inside the Action (${light})`);
    skia.press(r.left + r.width / 2, r.top + r.height / 2);
    assert.equal(presses, 1);
    skia.close();
  });
});
