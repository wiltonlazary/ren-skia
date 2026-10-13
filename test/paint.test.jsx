// Paint on a CanvasKit surface as CSS draws it: content clipped to rounded
// corners, per-corner radii, per-side borders and their styles, gradients,
// transforms and an Image's fit, checked in pixels.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { $root, $signal, $read, $write, $batch } from 'rrx-core';
import { View, Label, Shape, Image } from 'ren-core';
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

describe('ren skia paint', () => {
  it('clips content to rounded corners, as the DOM does', () => {
    const skia = $skia(kit, { font, width: 120, height: 80, background: 0xffffffff });
    render(() => (
      <View style={{ padding: 10 }}>
        <View style={{ width: 100, height: 60, radius: 20, overflow: 'hidden' }}>
          <View style={{ height: 60, background: '#ff0000' }} />
        </View>
      </View>
    ), skia);
    skia.present();
    assert.deepEqual(at(skia, 12, 12), [255, 255, 255], 'the corner is outside the curve');
    assert.deepEqual(at(skia, 60, 12), [255, 0, 0], 'the edge between the corners is inside');
    assert.deepEqual(at(skia, 60, 40), [255, 0, 0]);
    skia.close();
  });

  it('hints text to the pixel rows as Chrome sets it: the top of an x solid, not faded', () => {
    for (const size of [13, 14, 15]) {
      const skia = $skia(kit, { font, width: 40, height: 40, background: 0xffffffff });
      render(() => <Label text="x" style={{ fontSize: size, color: '#000' }} />, skia);
      skia.present();
      const p = pixels(skia);
      let top = 0;
      for (let y = 0; y < 40 && top === 0; y++) for (let x = 0; x < 40; x++) top = Math.max(top, 255 - p[(y * 40 + x) * 4]);
      assert.ok(top > 150, `${size}px: the x-height's first row has ${top} of 255`);
      skia.close();
    }
  });

  it("weighs text as Chrome's DOM does: dark text gets Skia's contrast, light text none", () => {
    // Chrome's DOM text inks about a quarter more than CanvasKit's single
    // pass for black (0.79 of it, README §Layout); the same text drawn once
    // straight on a CanvasKit surface is the control.
    const text = 'The quick brown fox 0123';
    /** The ink of a surface's pixels against its background. @param {Uint8Array} p @param {number} bg */
    const ink = (p, bg) => {
      let sum = 0;
      for (let k = 0; k < p.length; k += 4) sum += Math.abs(p[k + 1] - bg);
      return sum;
    };
    for (const [color, background, lift] of /** @type {const} */ ([['#000000', 0xffffffff, [1.2, 1.35]], ['#666666', 0xffffffff, [1.05, 1.2]], ['#ffffff', 0xff000000, [1, 1]]])) {
      const skia = $skia(kit, { font, width: 200, height: 30, background });
      render(() => <Label text={text} style={{ fontSize: 14, color }} />, skia);
      skia.present();
      const drawn = ink(pixels(skia), background & 255);
      const surface = kit.MakeSurface(200, 30);
      const canvas = surface.getCanvas();
      canvas.clear(kit.Color((background >>> 16) & 255, (background >>> 8) & 255, background & 255, 1));
      const paint = new kit.Paint();
      paint.setAntiAlias(true);
      paint.setColor(kit.parseColorString(color));
      canvas.drawText(text, 0, 20, paint, skia.fonts.font(14));
      const once = ink(Buffer.from(canvas.readPixels(0, 0, { width: 200, height: 30, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB })), background & 255);
      paint.delete();
      surface.delete();
      const ratio = drawn / once;
      assert.ok(ratio >= lift[0] - 0.01 && ratio <= lift[1] + 0.01, `${color}: ${ratio.toFixed(3)} of a single pass's ink`);
      skia.close();
    }
  });

  it('draws text at the size it is set at, down to a 64th, as it is measured', () => {
    // Chrome sets 10.4px text at 10.390625 (FreeType's 26.6 sizes); ren-canv's Sfnt measures it so.
    const skia = $skia(kit, { font, width: 40, height: 40 });
    assert.equal(skia.fonts.font(10.4).getSize(), 10.390625);
    assert.equal(skia.fonts.font(10.4, 1).getSize(), 10.390625, 'bold too');
    assert.equal(skia.fonts.font(16).getSize(), 16);
    skia.close();
  });

  it("draws shifted by the Document's shift, a fraction of a device pixel", () => {
    const skia = $skia(kit, { font, width: 40, height: 40, background: 0xffffffff });
    render(() => <View style={{ padding: [10, 0, 0, 10] }}><View style={{ width: 10, height: 10, background: '#000' }} /></View>, skia);
    skia.present();
    assert.deepEqual(at(skia, 12, 10), [0, 0, 0], 'on whole pixels: the box starts at row 10');
    skia.shift(0, 0.5);
    assert.deepEqual([skia.shiftX, skia.shiftY], [0, 0.5]);
    const half = at(skia, 12, 10)[0];
    assert.ok(half > 64 && half < 192, `row 10 half covered: ${half}`);
    assert.deepEqual(at(skia, 12, 15), [0, 0, 0], 'inside, whole');
    skia.close();
  });

  it('draws a gradient opaque after a translucent fill: the paint takes no alpha from before', () => {
    for (const first of ['#ff000020', '#ff0000']) {
      const skia = $skia(kit, { font, width: 100, height: 60, background: 0xffffffff });
      render(() => (
        <View>
          <View style={{ height: 20, width: 20, background: first }} />
          <View style={{ height: 20, background: { linear: 90, stops: [[0, '#000000'], [1, '#000000']] } }} />
        </View>
      ), skia);
      skia.present();
      assert.deepEqual(at(skia, 50, 30), [0, 0, 0], `black after ${first}`);
      skia.close();
    }
  });

  it("copies a damaged area to the page's canvas where the shift drew it, a fraction of a pixel off", (/** @type {import('node:test').TestContext} */ t) => {
    // CanvasKit copies a software surface's flushed rectangle with putImageData: this canvas records what shows.
    const globals = /** @type {any} */ (globalThis);
    const saved = [globals.HTMLCanvasElement, globals.ImageData];
    t.after(() => void ([globals.HTMLCanvasElement, globals.ImageData] = saved));
    globals.HTMLCanvasElement = class {};
    globals.ImageData = class {
      /** @param {Uint8ClampedArray} data @param {number} width @param {number} height */
      constructor(data, width, height) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    };
    const W = 200;
    const H = 100;
    const shown = new Uint8ClampedArray(W * H * 4);
    const canvas = Object.assign(new globals.HTMLCanvasElement(), {
      width: 0,
      height: 0,
      getContext: () => ({
        putImageData(/** @type {any} */ image, /** @type {number} */ _dx, /** @type {number} */ _dy, x = 0, y = 0, w = image.width, h = image.height) {
          for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) for (let k = 0; k < 4; k++) shown[(r * W + c) * 4 + k] = image.data[(r * image.width + c) * 4 + k];
        },
      }),
    });
    for (const shift of [0, 0.3, -0.3]) {
      shown.fill(0);
      const skia = $skia(kit, { font, width: W, height: H, background: 0xffffffff, canvas, gpu: false });
      const root = $root('flush');
      const on = $signal(root, false);
      skia.partial = true;
      render(() => <View style={{ direction: 'row', height: 20 }}><View style={{ width: 40 }} /><View style={() => ({ width: 20, background: $read(on) ? '#000000' : '#ffffff' })} /></View>, skia, { root });
      skia.shift(shift, 0);
      skia.present();
      $write(on, true);
      skia.present();
      const surface = pixels(skia);
      /** @type {number[]} */
      const stale = [];
      for (let c = 0; c < W; c++) if (surface[(10 * W + c) * 4] !== shown[(10 * W + c) * 4]) stale.push(c);
      assert.deepEqual(stale, [], `shifted ${shift}: the columns the canvas shows stale`);
      skia.close();
    }
  });

  it('outlines a stroked Shape rect as the DOM does', () => {
    const skia = $skia(kit, { font, width: 60, height: 60, background: 0xffffffff });
    render(() => <Shape style={{ width: 60, height: 60 }} shapes={[{ kind: 'rect', x: 10, y: 10, right: 50, bottom: 50, stroke: 4, color: '#000' }]} />, skia);
    skia.present();
    assert.deepEqual(at(skia, 30, 30), [255, 255, 255], 'not filled');
    assert.deepEqual(at(skia, 30, 10), [0, 0, 0], 'the edge is drawn');
    assert.deepEqual(at(skia, 30, 6), [255, 255, 255]);
    skia.close();
  });

  it('draws a border per side, and a dashed one with gaps', () => {
    const skia = $skia(kit, { font, width: 120, height: 80, background: 0xffffffff });
    render(() => (
      <View style={{ padding: 10, gap: 10 }}>
        <View style={{ width: 100, height: 20, borderBottom: 4, borderLeft: 4, borderColor: '#0000ff', borderLeftColor: '#ff0000' }} />
        <View style={{ width: 100, height: 20, border: 4, borderColor: '#000', borderStyle: 'dashed' }} />
      </View>
    ), skia);
    skia.present();
    assert.deepEqual(at(skia, 60, 28), [0, 0, 255], 'the bottom side');
    assert.deepEqual(at(skia, 12, 20), [255, 0, 0], 'the left side');
    assert.deepEqual(at(skia, 60, 11), [255, 255, 255], 'no top side');
    // Dashes 12 long from the corner, gaps 12 long.
    assert.deepEqual(at(skia, 16, 42), [0, 0, 0], 'a dash');
    assert.deepEqual(at(skia, 28, 42), [255, 255, 255], 'a gap');
    skia.close();
  });

  it('paints linear and radial gradients', () => {
    const skia = $skia(kit, { font, width: 100, height: 60, background: 0xffffffff });
    render(() => (
      <View>
        <View style={{ height: 20, background: { linear: 90, stops: [[0, '#ff0000'], [1, '#0000ff']] } }} />
        <View style={{ height: 20, background: { linear: 180, stops: [[0, '#000000'], [1, '#ffffff']] } }} />
        <View style={{ height: 20, background: { radial: true, stops: [[0, '#00ff00'], [1, '#000000']] } }} />
      </View>
    ), skia);
    skia.present();
    const [lr, , lb] = at(skia, 1, 10);
    const [rr, , rb] = at(skia, 98, 10);
    assert.ok(lr > 240 && lb < 15 && rr < 15 && rb > 240, 'red on the left, blue on the right');
    assert.ok(at(skia, 50, 21)[0] < 30 && at(skia, 50, 38)[0] > 225, 'down: dark to light');
    const [, center] = at(skia, 50, 50);
    const [, corner] = at(skia, 1, 41);
    assert.ok(center > 240 && corner < 20, 'radial: the first stop at the center');
    skia.close();
  });

  it("fills Shape figures with their fill: a gradient over each's bounds, or a color", () => {
    const skia = $skia(kit, { font, width: 100, height: 60, background: 0xffffffff });
    render(() => (
      <Shape
        style={{ width: 100, height: 60 }}
        shapes={[
          { kind: 'rect', x: 0, y: 0, right: 100, bottom: 20, fill: { linear: 90, stops: [[0, '#ff0000'], [1, '#0000ff']] } },
          { kind: 'oval', x: 0, y: 20, right: 40, bottom: 60, fill: { radial: true, stops: [[0, '#00ff00'], [1, '#000000']] } },
          { kind: 'path', points: [50, 20, 100, 20, 100, 60, 50, 60], closed: true, fill: '#ff00ff', color: '#000' },
        ]}
      />
    ), skia);
    skia.present();
    const [lr, , lb] = at(skia, 1, 10);
    const [rr, , rb] = at(skia, 98, 10);
    assert.ok(lr > 240 && lb < 15 && rr < 15 && rb > 240, 'the rect: red on the left, blue on the right');
    assert.ok(at(skia, 20, 40)[1] > 240, "the oval: the first stop at its center");
    assert.deepEqual(at(skia, 1, 21), [255, 255, 255], 'and nothing outside its curve');
    assert.deepEqual(at(skia, 75, 40), [255, 0, 255], 'the path: its color fill');
    skia.close();
  });

  it('repaints two changes across a column edge as damage, with the pixels of a full repaint', () => {
    for (const scale of [1, 1.5, 2]) {
      const run = (/** @type {boolean} */ partial) => {
        const skia = /** @type {any} */ ($skia(kit, { font, width: 200, height: 120, scale, background: 0xffffffff }));
        skia.partial = partial;
        const root = $root('busy');
        const left = $signal(root, 'tick 1');
        const right = $signal(root, 'hover a');
        render(() => (
          <View style={{ direction: 'row', height: 120 }}>
            <View style={{ width: 100, background: '#eeeeee', align: 'end', padding: 3 }}>
              <Label text={left} style={{ color: '#000' }} />
            </View>
            <View style={{ width: 100, background: '#cccccc', align: 'start', padding: 3 }}>
              <Label text={right} style={{ radius: 4, background: '#ffffff', color: '#000' }} />
            </View>
          </View>
        ), skia, { root });
        skia.present();
        $batch(root, () => {
          $write(left, 'tick 22');
          $write(right, 'hover bb');
        });
        skia.present();
        return skia;
      };
      const full = run(false);
      const part = run(true);
      assert.equal(part.repaint, 'damage', `scale ${scale}: the columns stay out of the damage`);
      const read = (/** @type {any} */ skia) => Buffer.from(skia.surface.getCanvas().readPixels(0, 0, { width: skia.surface.width(), height: skia.surface.height(), colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB }));
      assert.ok(read(part).equals(read(full)), `scale ${scale}: the pixels of a full repaint`);
      full.close();
      part.close();
    }
  });

  it('paints a skew as the transform leans it', () => {
    const skia = $skia(kit, { font, width: 100, height: 60, background: 0xffffffff });
    render(() => (
      <View style={{ padding: 20, align: 'start' }}>
        <View style={{ width: 40, height: 20, skewX: 45, background: '#0000ff' }} />
      </View>
    ), skia);
    skia.present();
    // About its center (40, 30): its top edge 10 left, its bottom 10 right.
    assert.deepEqual(at(skia, 13, 21), [0, 0, 255], 'the top leans left of its layout box');
    assert.deepEqual(at(skia, 57, 21), [255, 255, 255], 'leaving its top right corner');
    assert.deepEqual(at(skia, 67, 38), [0, 0, 255], 'the bottom leans right');
    skia.close();
  });

  it('paints a transform, and repaints a change of it as a full repaint would', () => {
    const run = (/** @type {boolean} */ partial) => {
      const skia = $skia(kit, { font, width: 120, height: 120, background: 0xffffffff });
      skia.partial = partial;
      const root = $root('turn');
      const turn = $signal(root, 0);
      render(() => (
        <View style={{ padding: 30, align: 'start' }}>
          <View style={() => ({ width: 60, height: 60, background: '#0000ff', rotate: $read(turn) })} />
          <Label text="up" style={{ rotate: -90, color: '#000' }} />
        </View>
      ), skia, { root });
      skia.present();
      return { skia, turn };
    };
    const full = run(false);
    const part = run(true);
    assert.deepEqual(at(part.skia, 32, 32), [0, 0, 255], 'square: its corner');
    $write(full.turn, 45);
    $write(part.turn, 45);
    full.skia.present();
    part.skia.present();
    assert.deepEqual(at(part.skia, 32, 32), [255, 255, 255], 'turned: the corner moved');
    assert.deepEqual(at(part.skia, 60, 22), [0, 0, 255], 'and a corner is up there now');
    assert.ok(pixels(part.skia).equals(pixels(full.skia)), 'the damage repaint has the pixels of a full one');
    full.skia.close();
    part.skia.close();
  });

  it('draws a monospace family in the mono typeface, measured by it', () => {
    const mono = readFileSync(new URL('../assets/mono.ttf', import.meta.url));
    const skia = $skia(kit, { font, mono, width: 200, height: 60, background: 0xffffffff });
    /** @type {any} */
    const refs = {};
    render(() => (
      <View style={{ align: 'start' }}>
        <Label ref={(/** @type {any} */ n) => (refs.code = n)} text="iiii" style={{ fontFamily: 'monospace', fontSize: 20 }} />
        <Label ref={(/** @type {any} */ n) => (refs.prose = n)} text="iiii" style={{ fontSize: 20 }} />
      </View>
    ), skia);
    skia.present();
    const code = refs.code.getBoundingClientRect().width;
    const prose = refs.prose.getBoundingClientRect().width;
    assert.ok(Math.abs(code - 4 * 20 * 0.602) < 0.5, `a monospace advance per character (${code})`);
    assert.ok(prose < code * 0.6, 'narrow i in the regular face');
    const dark = (/** @type {number} */ y0) => {
      let n = 0;
      for (let x = 0; x < 60; x++) for (let y = y0; y < y0 + 26; y++) if (at(skia, x, y)[0] < 128) n++;
      return n;
    };
    assert.ok(dark(0) > 0 && dark(28) > 0, 'both drawn');
    skia.close();
  });

  it('fits an Image as object-fit asks, and tells it a source that fails', async () => {
    // A 40 × 20 red picture.
    const made = kit.MakeSurface(40, 20);
    made.getCanvas().drawColorInt(0xffff0000, kit.BlendMode.Src);
    const shot = made.makeImageSnapshot();
    const png = shot.encodeToBytes();
    shot.delete();
    made.delete();
    /** @type {string[]} */
    const heard = [];
    const skia = $skia(kit, { font, width: 120, height: 60, background: 0xffffffff, image: source => (source === 'red.png' ? png : null) });
    render(() => (
      <View style={{ direction: 'row' }}>
        <Image source="red.png" style={{ width: 40, height: 40, objectFit: 'contain' }} />
        <Image source="red.png" style={{ width: 40, height: 40, objectFit: 'cover' }} />
        <Image source="gone.png" style={{ width: 40, height: 40 }} onError={(/** @type {any} */ e) => heard.push(e.type)} />
      </View>
    ), skia);
    // After a translucent fill (an Avatar's light background), a picture keeps its own alpha.
    const over = $skia(kit, { font, width: 40, height: 40, background: 0xffffffff, image: source => (source === 'red.png' ? png : null) });
    render(() => (
      <View style={{ width: 40, height: 40, background: '#0000001a' }}>
        <Image source="red.png" style={{ width: 40, height: 20 }} />
      </View>
    ), over);
    over.present();
    assert.deepEqual(at(over, 20, 10), [255, 0, 0], 'drawn whole, not at the fill\'s alpha');
    over.close();
    skia.present();
    assert.deepEqual(at(skia, 20, 5), [255, 255, 255], 'contain: bands above and below');
    assert.deepEqual(at(skia, 20, 20), [255, 0, 0]);
    assert.deepEqual(at(skia, 60, 5), [255, 0, 0], 'cover: the box filled');
    await Promise.resolve();
    assert.deepEqual(heard, ['error']);
    skia.close();
  });

  it('paints an empty box\'s opacity as a layer would', () => {
    const skia = $skia(kit, { font, width: 100, height: 40, background: 0xffffffff });
    render(() => (
      <View style={{ direction: 'row' }}>
        <View style={{ width: 40, height: 40, background: '#3366cc', opacity: 0.4 }} />
        <View style={{ width: 40, height: 40, background: '#3366cc', opacity: 0.4 }}>
          <View style={{ width: 0, height: 0 }} />
        </View>
      </View>
    ), skia);
    skia.present();
    const folded = at(skia, 20, 20);
    const layered = at(skia, 60, 20);
    assert.ok(folded.every((v, k) => Math.abs(v - layered[k]) <= 1), `${folded} ${layered}`);
    skia.close();
  });

  it('dashes a Shape line', () => {
    const skia = $skia(kit, { font, width: 60, height: 20, background: 0xffffffff });
    render(() => <Shape style={{ width: 60, height: 20 }} shapes={[{ kind: 'line', x: 0, y: 10, right: 60, bottom: 10, stroke: 4, color: '#000', dash: [10, 10] }]} />, skia);
    skia.present();
    assert.deepEqual(at(skia, 5, 10), [0, 0, 0], 'on');
    assert.deepEqual(at(skia, 15, 10), [255, 255, 255], 'off');
    assert.deepEqual(at(skia, 25, 10), [0, 0, 0], 'on again');
    skia.close();
  });

  it('draws and clips each corner with its own radius', () => {
    const skia = $skia(kit, { font, width: 120, height: 150, background: 0xffffffff });
    render(() => (
      <View style={{ padding: 10, gap: 10 }}>
        <View style={{ width: 100, height: 60, radius: [20, 0, 20, 0], background: '#0000ff' }} />
        <View style={{ width: 100, height: 60, radius: [0, 20, 0, 20], overflow: 'hidden' }}>
          <View style={{ height: 60, background: '#ff0000' }} />
        </View>
      </View>
    ), skia);
    skia.present();
    assert.deepEqual(at(skia, 11, 11), [255, 255, 255], 'a rounded corner');
    assert.deepEqual(at(skia, 108, 11), [0, 0, 255], 'a square corner');
    assert.deepEqual(at(skia, 108, 68), [255, 255, 255]);
    assert.deepEqual(at(skia, 11, 81), [255, 0, 0], 'clipped square here');
    assert.deepEqual(at(skia, 108, 81), [255, 255, 255], 'clipped round there');
    skia.close();
  });
});
