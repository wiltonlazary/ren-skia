// The Skia (CanvasKit) renderer with JSX (compiled by ren-core/loader),
// headless in node on an offscreen CanvasKit surface.

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window as HappyWindow } from 'happy-dom';
import { $root, $signal, $read, $write, $flush, $stats, $batch } from 'rrx-core';
import { Show, For, Portal, View, Layout, Scroll, Label, Edit, Action, Shape, Image } from 'ren-core';
import { $skia, render, attach, decode, loadLayout, remoteLayout } from 'ren-skia';
import { serveLayout } from 'ren-canv/worker';
import { closeAfter } from './fixtures/after.js';
import { setFlagsFromString } from 'node:v8';


/** The happy-dom windows this file's tests open, each closed after its test (its window.close() frees nothing). @type {HappyWindow[]} */
const windows = [];
/** happy-dom's Window, tracked for closing. */
class Window extends HappyWindow {
  /** @param {ConstructorParameters<typeof HappyWindow>} args */
  constructor(...args) {
    super(...args);
    windows.push(this);
  }
}
afterEach(async () => {
  for (const window of windows.splice(0)) await window.happyDOM.close();
});

/** The layout engine (Taffy's WebAssembly), once, before any renderer. */
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

const make = (width = 200, height = 200) => $skia(kit, { font, width, height });
/** The strings of a frame's text commands, in drawing order. */
const texts = skia => skia.commands().filter(c => c[0] === 'text').map(c => c[1]);
const ACCENT = 0xff325842;
const CANVAS = 0xfff5f5ef;
/** The theme's line height: text 17 × leading 1.4, down to a 64th of a pixel as Blink lays it out (ren-canv). */
const L = Math.floor(17 * 1.4 * 64) / 64;
/**
 * The middle of the `n`th press or focus target of a kind (4 Edit, 5 Action),
 * where the renderer last drew it.
 * @returns {[number, number]}
 */
const spot = (skia, kind, n = 0) => {
  skia.present();
  const hits = skia.painter.hits;
  for (let i = 0, k = 0; i < hits.n; i++)
    if (hits.items[i].kind === kind && k++ === n) {
      const b = hits.box;
      return [(b[i * 6] + b[i * 6 + 2]) / 2, (b[i * 6 + 1] + b[i * 6 + 3]) / 2];
    }
  throw new Error(`no target of kind ${kind}`);
};
/** Where a line of text at the theme size sits in a line box from `top`, as Blink sets it: the ascent and descent rounded, half the leading above floored. */
const baseline = (skia, top) => {
  const { ascent, descent } = skia.fonts.metrics(17);
  return top + Math.floor((L - Math.round(ascent) - Math.round(descent)) / 2) + Math.round(ascent);
};

describe('ren skia', () => {
  it('renders a view headlessly and snapshots its command buffer', () => {
    const skia = make();
    const dispose = render(() => (
      <Layout fill={0xff336699} pad={10}>
        <Label text="Hi" />
      </Layout>
    ), skia);
    assert.equal(skia.frames, 1);
    // The page has no inset (as the DOM); the Layout fills its box, as high
    // as its padding and one line of text (43.8), and pads its label by 10.
    // Boxes snap to pixels as a browser paints them; text keeps its place.
    assert.deepEqual(skia.commands(), [
      ['save'], ['clip', 0, 0, 200, 200],
      ['rect', 0, 0, 200, 44, '#ff336699'],
      ['save'], ['clip', 10, 10, 190, 34],
      ['text', 'Hi', 10, baseline(skia, 10), 17, '#ff263e34', 0],
      ['restore'],
      ['restore'],
      ['save'], ['clip', 0, 0, 200, 200], ['restore'],
    ]);
    assert.deepEqual(decode(skia.frame), skia.commands());
    // Pixels: the Layout fill, and the page background below it.
    assert.equal(skia.pixel(5, 5), 0xff336699);
    assert.equal(skia.pixel(195, 40), 0xff336699);
    assert.equal(skia.pixel(100, 60), CANVAS);
    dispose();
    skia.close();
  });

  it("draws a family's typeface, a fallback typeface per character, and a right-to-left run reversed from its left edge", () => {
    // The monospace file has no Hebrew; the application one has.
    const mono = readFileSync(new URL('../assets/mono.ttf', import.meta.url));
    const skia = $skia(kit, { font: mono, families: { Sans: font }, fallback: [font], width: 300, height: 100 });
    /** @type {[string, number, any][]} */
    const drawn = [];
    const drawText = kit.Canvas.prototype.drawText;
    kit.Canvas.prototype.drawText = function (/** @type {any[]} */ ...args) {
      drawn.push([args[0], args[1], args[4]]);
      return drawText.apply(this, args);
    };
    try {
      render(() => (
        <View style={{ align: 'start' }}>
          <Label text={'ab \u05d0\u05d1'} />
          <Label text="ab" style={{ fontFamily: 'Sans, monospace' }} />
        </View>
      ), skia);
      skia.present();
    } finally {
      kit.Canvas.prototype.drawText = drawText;
    }
    const fonts = /** @type {any} */ (skia).fonts;
    const lead = fonts.width('ab ', 17);
    const run = fonts.width('\u05d0\u05d1', 17);
    // The Hebrew: the fallback's (slot 2: after the one named typeface), right to left (8).
    assert.deepEqual(texts(skia), ['ab ', '\u05d0\u05d1', 'ab']);
    assert.deepEqual(skia.commands().filter(c => c[0] === 'text').map(c => c[6]), [0, 8 | (2 << 4), 4 | (1 << 4)], 'Sans before monospace: its slot (with the monospace bit, which the slot outranks)');
    const once = drawn.filter((d, i) => i === 0 || d[0] !== drawn[i - 1][0]);
    assert.deepEqual(once.map(d => [d[0], d[1]]), [['ab ', 0], ['\u05d1\u05d0', lead], ['ab', 0]], 'the run reversed (its visual order), from its left edge');
    assert.ok(Math.abs(run - (fonts.width('\u05d0', 17) + fonts.width('\u05d1', 17))) < 1e-9);
    assert.equal(once[1][2], fonts.font(17, 2 << 4), 'in the fallback typeface');
    assert.equal(once[2][2], fonts.font(17, 1 << 4), 'in the typeface named Sans');
    assert.notEqual(once[0][2], once[2][2], 'the root typeface for the rest');
    skia.close();
  });

  it('draws a right-to-left paragraph from its right: a right-to-left run reversed at its left, the Latin after it', () => {
    const skia = make(300, 100);
    /** @type {[string, number][]} */
    const drawn = [];
    const drawText = kit.Canvas.prototype.drawText;
    kit.Canvas.prototype.drawText = function (/** @type {any[]} */ ...args) {
      drawn.push([args[0], args[1]]);
      return drawText.apply(this, args);
    };
    try {
      render(() => (
        <View dir="rtl" style={{ width: 300 }}>
          <Label text={'ab \u05d0\u05d1'} />
        </View>
      ), skia);
      skia.present();
    } finally {
      kit.Canvas.prototype.drawText = drawText;
    }
    const fonts = /** @type {any} */ (skia).fonts;
    const run = fonts.width(' \u05d0\u05d1', 17);
    const whole = run + fonts.width('ab', 17);
    // Right to left, the space between ab and the Hebrew runs with the Hebrew; the row sits at the right (start).
    assert.deepEqual(texts(skia), [' \u05d0\u05d1', 'ab']);
    const once = drawn.filter((d, i) => i === 0 || d[0] !== drawn[i - 1][0]);
    const near = (/** @type {number} */ a, /** @type {number} */ b) => Math.abs(a - b) < 1e-6;
    assert.equal(once.length, 2);
    assert.equal(once[0][0], '\u05d1\u05d0 ', 'the run reversed (its visual order)');
    assert.ok(near(once[0][1], 300 - whole) && near(once[1][1], 300 - whole + run), JSON.stringify(once));
    assert.equal(once[1][0], 'ab');
    skia.close();
  });

  it('draws shaped text as the glyphs it was measured as: Arabic joined, from its left edge', () => {
    const skia = make(300, 100);
    /** @type {[number[], number[], number][]} */
    const drawn = [];
    const drawGlyphs = kit.Canvas.prototype.drawGlyphs;
    kit.Canvas.prototype.drawGlyphs = function (/** @type {any[]} */ ...args) {
      drawn.push([[...args[0]], [...args[1]], args[2]]);
      return drawGlyphs.apply(this, args);
    };
    try {
      render(() => (
        <View style={{ align: 'start' }}>
          <Label text={'سلام'} />
        </View>
      ), skia);
      skia.present();
    } finally {
      kit.Canvas.prototype.drawGlyphs = drawGlyphs;
    }
    const fonts = /** @type {any} */ (skia).fonts;
    const sfnt = fonts.sfnt;
    const shaped = sfnt.shaped('سلام', true);
    const isolated = [...'سلام'].map(c => sfnt.glyph(c.codePointAt(0)));
    assert.ok(drawn.length >= 1, 'drawn as glyphs');
    const [ids, places, x] = drawn[0];
    assert.deepEqual(ids, [...shaped.ids], 'the shaped glyphs');
    assert.equal(ids.length, 3, 'lam-alef as one glyph');
    assert.notEqual(ids[2], isolated[0], 'seen in its initial form');
    const width = fonts.width('سلام', 17);
    const command = /** @type {any[]} */ (skia.commands().find(c => c[0] === 'text'));
    assert.equal(command[2], width, 'a right-to-left command: x its right edge');
    assert.ok(Math.abs(x) < 1e-9, 'drawn from its left edge');
    assert.equal(places.length, 6, 'a place per glyph');
    assert.ok(Math.abs((shaped.advance * sfnt.sized(17)) / sfnt.units - width) < 1e-9, 'as wide as measured');
    // Latin is drawn as its characters, at its advances.
    assert.equal(fonts.glyphs('office', 17), null);
    skia.close();
  });

  it('paints actions, edits and shapes into pixels', () => {
    const skia = make(200, 300);
    render(() => (
      <View>
        <Action text="Go" />
        <Edit label="Name" value="x" />
        <Shape height={40} shapes={[{ kind: 'rect', x: 0, y: 0, right: 20, bottom: 20, color: 0xffff0000 }, { kind: 'line', x: 0, y: 30, right: 100, bottom: 30, color: 0xff0000ff, stroke: 4 }]} />
      </View>
    ), skia);
    const commands = skia.commands();
    // The Action is a field high (38) and stretched; the Edit below it, a field high with its border; the Shape at 76.
    assert.deepEqual(commands.find(c => c[0] === 'round' && c[5] === '#ff325842'), ['round', 0, 0, 200, 38, '#ff325842', 6]);
    assert.deepEqual(commands.find(c => c[0] === 'border'), ['border', 0, 38, 200, 76, '#ffcbd4c3', 6, 1]);
    assert.ok(commands.some(c => c[0] === 'text' && c[1] === 'Go'));
    assert.ok(!commands.some(c => c[0] === 'text' && c[1] === 'Name'), 'a label shows only while the Edit is empty (a placeholder)');
    assert.equal(skia.pixel(160, 20), ACCENT, 'the Action background');
    assert.equal(skia.pixel(160, 57), 0xffffffff, 'the Edit field');
    assert.equal(skia.pixel(10, 86), 0xffff0000, 'the Shape rect');
    assert.equal(skia.pixel(60, 106), 0xff0000ff, 'the Shape line');
    assert.equal(skia.pixel(160, 100), CANVAS, 'the Shape is the media width (120), not stretched');
    assert.ok(commands.some(c => c[0] === 'line' && c[6] === 4));
    // An empty Edit shows its label, muted.
    const empty = make(200, 100);
    render(() => <Edit label="Name" value="" />, empty);
    assert.equal(empty.commands().find(c => c[0] === 'text')?.[1], 'Name');
    assert.equal(empty.commands().find(c => c[0] === 'text')?.[5], '#ff637460');
    empty.close();
    skia.close();
  });

  it('repaints after a flush, and not after an unchanged one', () => {
    const skia = make();
    const root = $root('app');
    const text = $signal(root, 'one');
    const other = $signal(root, 0);
    render(() => <View><Label text={text} /><Label>n {other}</Label></View>, skia, { root, auto: false });
    assert.equal(skia.frames, 1);
    $write(text, 'two');
    assert.equal(skia.frames, 1, 'nothing paints before the flush');
    assert.deepEqual(texts(skia), ['one', 'n 0']);
    $flush(root);
    assert.equal(skia.frames, 2);
    assert.deepEqual(texts(skia), ['two', 'n 0']);
    $batch(root, () => $write(other, 1));
    assert.equal(skia.frames, 3, 'a batch flushes once and paints once');
    assert.deepEqual(texts(skia), ['two', 'n 1'], 'text children of a Label update in place');
    const unseen = $signal(root, 0);
    $batch(root, () => $write(unseen, 1));
    $flush(root);
    assert.equal(skia.frames, 3, 'a flush that changes nothing shown does not repaint');
    assert.equal(skia.present(), false);
    skia.close();
  });

  it('presses an Action whose handler changes a Label', () => {
    const skia = make();
    const root = $root('app');
    const count = $signal(root, 0);
    render(() => (
      <View>
        <Action text="Add" onPress={() => $write(count, $read(count) + 1)} />
        <Label text={() => `count ${$read(count)}`} />
      </View>
    ), skia, { root });
    assert.deepEqual(texts(skia), ['Add', 'count 0']);
    assert.equal(skia.press(...spot(skia, 5)), true);
    assert.equal($read(count), 1);
    assert.deepEqual(texts(skia), ['Add', 'count 1']);
    assert.equal(skia.press(100, 180), false, 'a press outside every target misses');
    skia.key('Tab');
    skia.key('Enter');
    assert.equal($read(count), 2, 'Enter presses the focused Action');
    skia.close();
  });

  it('focuses an Edit, types into it and round-trips its value', () => {
    const skia = make(300, 300);
    const root = $root('app');
    const value = $signal(root, 'ab');
    const log = [];
    render(() => (
      <View>
        <Edit
          label="Name"
          value={value}
          onChange={e => $write(value, e.value)}
          onFocus={() => log.push('focus')}
          onBlur={() => log.push('blur')}
          onKey={e => log.push(`key ${e.key}`)}
          onSubmit={e => log.push(`submit ${e.value}`)}
        />
        <Label text={() => `= ${$read(value)}`} />
      </View>
    ), skia, { root });
    skia.press(250, spot(skia, 4)[1]);
    assert.equal(skia.focused?.kind, 4);
    assert.deepEqual(log, ['focus']);
    assert.equal(skia.caret, 2, 'a press past the text puts the caret at its end');
    assert.ok(skia.commands().some(c => c[0] === 'border' && c[5] === '#ff4b5367' && c[7] === 2), 'the focus ring');
    assert.ok(skia.commands().some(c => c[0] === 'rect' && c[5] === '#ff1e4191'), 'the caret');
    skia.type('cd');
    assert.equal($read(value), 'abcd');
    assert.deepEqual(texts(skia).slice(-1), ['= abcd']);
    skia.key('Backspace');
    skia.key('ArrowLeft');
    skia.key('X');
    assert.equal($read(value), 'abXc');
    skia.key('Home');
    skia.key('Delete');
    assert.equal($read(value), 'bXc');
    // A value written by the app shows in the field.
    $write(value, 'reset');
    assert.ok(texts(skia).includes('reset'));
    skia.key('Enter');
    assert.deepEqual(log.slice(-2), ['key Enter', 'submit reset']);
    skia.press(250, 250);
    assert.equal(skia.focused, null);
    assert.equal(log.at(-1), 'blur');
    // A press near the start places the caret there.
    skia.press(12, spot(skia, 4)[1]);
    assert.equal(skia.caret, 0);
    skia.close();
  });

  it('edits multi-line values in soft-wrapped rows', () => {
    const skia = make(300, 300);
    const root = $root('app');
    const value = $signal(root, 'one\ntwo');
    render(() => <Edit lines={3} value={value} onChange={e => $write(value, e.value)} />, skia, { root });
    const rows = () => skia.commands().filter(c => c[0] === 'text').map(c => [c[1], c[3]]);
    // The first row sits where a one-line field's text does (its padding in whole 64ths, as Blink
    // lays out the DOM's calc); the rest follow a line apart.
    const first = baseline(skia, 1 + Math.trunc(((38 - L) / 2 - 1) * 64) / 64);
    assert.deepEqual(rows(), [['one', first], ['two', first + L]], 'rows are a line apart');
    // The field is a field high plus a line for each more row.
    assert.ok(skia.commands().some(c => c[0] === 'round' && c[2] === 0 && c[4] === Math.round(38 + 2 * L)));
    skia.press(200, (38 - L) / 2 + L * 1.5);
    assert.equal(skia.caret, 7, 'a press on the second row places the caret in it');
    skia.key('Enter');
    skia.type('three');
    assert.equal($read(value), 'one\ntwo\nthree');
    assert.deepEqual(rows().map(r => r[0]), ['one', 'two', 'three']);
    skia.close();
  });

  it('composes IME text into an Edit and sends one change when it ends', () => {
    const skia = make(300, 300);
    const root = $root('app');
    const value = $signal(root, 'ab');
    const changes = [];
    render(() => <Edit value={value} onChange={e => { changes.push(e.value); $write(value, e.value); }} />, skia, { root });
    skia.press(250, spot(skia, 4)[1]);
    assert.equal(skia.composing, false);
    skia.compose('k');
    skia.compose('ka');
    assert.equal(skia.composing, true);
    assert.equal(skia.focused.draft, 'abka', 'the preedit shows in the field');
    assert.deepEqual(changes, [], 'nothing is sent while composing');
    const underline = () => skia.commands().filter(c => c[0] === 'line');
    assert.equal(underline().length, 1, 'the preedit is underlined');
    assert.equal(skia.key('Enter'), false, 'keys belong to the IME while it composes');
    assert.equal(skia.key('x'), false);
    assert.equal(skia.focused.draft, 'abka');
    skia.compose('か');
    skia.commit('日本');
    assert.deepEqual(changes, ['ab日本'], 'one change at compositionend');
    assert.equal($read(value), 'ab日本');
    assert.equal(skia.caret, 4);
    assert.equal(underline().length, 0);
    // A composition replaces the selection, even one that ends empty.
    skia.select(0, 2);
    skia.compose('x');
    assert.equal(skia.focused.draft, 'x日本');
    skia.commit('');
    assert.equal(skia.focused.draft, '日本');
    assert.deepEqual(changes, ['ab日本', '日本']);
    skia.select(1, 1);
    skia.compose('q');
    skia.commit('');
    assert.equal(skia.focused.draft, '日本');
    assert.equal(changes.length, 2, 'an empty composition changes nothing');
    // The app writes a value during a composition: it becomes the base, and the preedit stays.
    skia.select(2, 2);
    skia.compose('z');
    $write(value, 'AB');
    assert.equal(skia.focused.draft, 'ABz');
    skia.commit('Z');
    assert.deepEqual(changes.at(-1), 'ABZ');
    // Focus leaving an Edit commits its composition first.
    skia.compose('w');
    skia.press(250, 250);
    assert.equal(changes.at(-1), 'ABZw');
    assert.equal(skia.composing, false);
    skia.close();
  });

  it('selects text by key and natively, and replaces the selection', () => {
    const skia = make(300, 300);
    const root = $root('app');
    const value = $signal(root, 'hello');
    render(() => <Edit value={value} onChange={e => $write(value, e.value)} />, skia, { root });
    skia.press(250, spot(skia, 4)[1]);
    skia.key('ArrowLeft', true);
    skia.key('ArrowLeft', true);
    assert.deepEqual([skia.anchor, skia.caret], [5, 3]);
    const selection = () => skia.commands().filter(c => c[0] === 'rect' && c[5] === '#ffaae4f5');
    assert.equal(selection().length, 1, 'the selection is drawn');
    skia.type('p!');
    assert.equal($read(value), 'help!');
    assert.equal(selection().length, 0);
    skia.select(0, 4);
    skia.key('Backspace');
    assert.equal($read(value), '!');
    skia.select(1, 0);
    skia.key('ArrowRight');
    assert.deepEqual([skia.anchor, skia.caret], [1, 1], 'an arrow collapses the selection at its end');
    skia.key('Home', true);
    skia.key('x');
    assert.equal($read(value), 'x');
    // A native input: the whole value and selection.
    assert.equal(skia.input('xyz', 1, 3), true);
    assert.equal($read(value), 'xyz');
    assert.deepEqual([skia.anchor, skia.caret], [1, 3]);
    assert.equal(skia.input('xyz', 0, 0), true);
    assert.deepEqual([skia.anchor, skia.caret], [0, 0], 'the same value only selects');
    // A surrogate pair is one character to Backspace and the arrows.
    skia.input('a😀', 3, 3);
    skia.key('ArrowLeft');
    assert.equal(skia.caret, 1);
    skia.key('End');
    skia.key('Backspace');
    assert.equal($read(value), 'a');
    assert.equal(skia.key('F5'), false, 'a key the renderer does not act on is left to the host');
    skia.close();
  });

  it('mirrors a native textarea over the focused Edit through attach', () => {
    const window = new Window();
    const document = window.document;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const canvas = document.createElement('canvas');
    host.appendChild(canvas);
    const skia = make(300, 300);
    const root = $root('app');
    const value = $signal(root, 'ab');
    const log = [];
    render(() => (
      <View>
        <Edit label="Name" value={value} onChange={e => { log.push(`change ${e.value}`); $write(value, e.value); }} onSubmit={e => log.push(`submit ${e.value}`)} />
        <Action text="Go" onPress={() => log.push('press')} />
      </View>
    ), skia, { root });
    const detach = attach(skia, canvas);
    const area = host.querySelector('textarea');
    assert.ok(area !== null, 'attach adds the native entry beside the canvas');
    assert.ok(area.parentNode === host);
    canvas.focus();
    skia.press(250, spot(skia, 4)[1]);
    assert.ok(document.activeElement === area, 'a focused Edit moves the DOM focus to the entry');
    // A press on the focused Edit that changes nothing drawn (the host focused
    // the canvas on pointerdown) still gives the entry the focus back.
    canvas.focus();
    skia.press(250, spot(skia, 4)[1]);
    assert.ok(document.activeElement === area, 'a second press keeps the entry focused');
    assert.equal(area.value, 'ab');
    assert.equal(area.getAttribute('aria-label'), 'Name');
    assert.match(area.getAttribute('style'), /left:0px;top:0px;width:300px;height:38px;font-size:17px/);
    const fire = (name, props = {}) => {
      const event = new window.Event(name, { bubbles: true, cancelable: true });
      Object.assign(event, props);
      area.dispatchEvent(event);
      return event;
    };
    // A composition: the draft follows the preedit, one change at the end.
    fire('compositionstart', { data: '' });
    fire('compositionupdate', { data: 'n' });
    area.value = 'abn';
    fire('input', { isComposing: true, inputType: 'insertCompositionText' });
    fire('compositionupdate', { data: 'に' });
    assert.equal(skia.focused.draft, 'abに');
    assert.deepEqual(log, []);
    fire('compositionend', { data: '日' });
    assert.deepEqual(log, ['change ab日']);
    assert.equal(area.value, 'ab日');
    // A virtual keyboard edits natively: keydown 229, then input.
    assert.equal(fire('keydown', { key: 'Unidentified', keyCode: 229 }).defaultPrevented, false);
    area.value = 'ab日!';
    area.setSelectionRange(4, 4);
    fire('input', { inputType: 'insertText', data: '!' });
    assert.deepEqual(log.at(-1), 'change ab日!');
    // A native selection is mirrored.
    area.setSelectionRange(0, 2, 'backward');
    assert.deepEqual([skia.anchor, skia.caret], [2, 0]);
    // Keys the renderer edits are cancelled and mirrored back into the entry.
    assert.equal(fire('keydown', { key: 'x' }).defaultPrevented, true);
    assert.equal(area.value, 'x日!');
    assert.deepEqual([area.selectionStart, area.selectionEnd], [1, 1]);
    assert.equal(fire('keydown', { key: 'Dead' }).defaultPrevented, false, 'a dead key is left to the platform');
    assert.equal(fire('keydown', { key: 'v', ctrlKey: true }).defaultPrevented, false, 'shortcuts stay native');
    // A line break on a one-line Edit submits.
    assert.equal(fire('beforeinput', { inputType: 'insertLineBreak' }).defaultPrevented, true);
    assert.equal(log.at(-1), 'submit x日!');
    // Tab to the Action gives the DOM focus back to the canvas.
    fire('keydown', { key: 'Tab' });
    assert.ok(document.activeElement === canvas);
    detach();
    assert.equal(host.querySelector('textarea'), null);
    skia.close();
  });

  it('mirrors the scene for assistive technology, incrementally', async () => {
    const window = new Window();
    const document = window.document;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const canvas = document.createElement('canvas');
    host.appendChild(canvas);
    const skia = $skia(kit, { font, width: 300, height: 300, aria: true });
    const root = $root('app');
    const title = $signal(root, 'Title');
    const rows = $signal(root, [1, 2, 3].map(id => ({ id, label: $signal(root, `row ${id}`) })));
    const open = $signal(root, true);
    const pressed = [];
    render(() => (
      <View>
        <Label text={title} />
        <For each={rows}>{row => <Layout layout="row"><Label>#{row().id} {row().label}</Label><Action text="x" onPress={() => pressed.push(row().id)} /></Layout>}</For>
        <Edit label="Name" value="v" />
        <Label text="note" hidden={() => !$read(open)} />
      </View>
    ), skia, { root });
    const detach = attach(skia, canvas);
    const box = host.querySelector('[data-ren-aria]');
    assert.ok(box !== null, 'the mirror sits beside the canvas');
    const labels = () => [...box.querySelectorAll('p')].map(p => p.textContent);
    assert.deepEqual(labels(), ['Title', '#1 row 1', '#2 row 2', '#3 row 3', 'note']);
    assert.deepEqual([...box.querySelectorAll('button')].map(b => b.textContent), ['x', 'x', 'x']);
    const edit = box.querySelector('[role="textbox"]');
    assert.equal(edit.getAttribute('aria-label'), 'Name');
    assert.equal(edit.textContent, 'v');
    // A change writes only its own item.
    const written = [];
    const flush = skia.mirror.flush.bind(skia.mirror);
    skia.mirror.flush = () => {
      written.push(skia.mirror.queue.length);
      flush();
    };
    $write($read(rows)[1].label, 'second');
    assert.deepEqual(labels()[2], '#2 second');
    assert.deepEqual(written, [1], 'one item written, no walk over the others');
    // A keyed move is DOM moves, and no writes.
    const list = box.firstChild.firstChild;
    const records = [];
    const observer = new window.MutationObserver(r => records.push(...r));
    observer.observe(list, { childList: true });
    $write(rows, [$read(rows)[2], $read(rows)[1], $read(rows)[0]]);
    records.push(...observer.takeRecords());
    observer.disconnect();
    assert.deepEqual(labels(), ['Title', '#3 row 3', '#2 second', '#1 row 1', 'note']);
    assert.equal(written.length, 1, 'a move writes no text');
    assert.ok(records.filter(r => r.addedNodes.length > 0).length <= 2, `${records.length} DOM moves`);
    $write(open, false);
    assert.equal(box.querySelectorAll('p')[4].hidden, true);
    // Activating a mirrored Action presses it; focusing a mirrored Edit focuses it.
    box.querySelectorAll('button')[0].click();
    assert.deepEqual(pressed, [3]);
    edit.focus();
    assert.equal(skia.focused?.kind, 4);
    assert.ok(document.activeElement === host.querySelector('textarea'), 'the native entry takes the focus');
    skia.type('w');
    assert.equal(edit.textContent, 'vw');
    $write(rows, []);
    assert.deepEqual(labels(), ['Title', 'note']);
    detach();
    assert.equal(host.querySelector('[data-ren-aria]'), null);
    assert.equal(skia.mirror, null);
    skia.close();
  });

  it('builds the mirror on demand from a hidden button', () => {
    const window = new Window();
    const document = window.document;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const canvas = document.createElement('canvas');
    host.appendChild(canvas);
    const skia = $skia(kit, { font, width: 200, height: 200, aria: 'demand' });
    render(() => <Label text="hello" />, skia);
    const detach = attach(skia, canvas);
    assert.equal(host.querySelector('[data-ren-aria]'), null, 'no mirror until asked');
    const enable = host.querySelector('[data-ren-aria-enable]');
    assert.equal(enable.textContent, 'Enable accessibility');
    enable.click();
    assert.equal(host.querySelector('[data-ren-aria-enable]'), null);
    assert.equal(host.querySelector('[data-ren-aria] p').textContent, 'hello');
    detach();
    assert.equal(host.children.length, 1, 'only the canvas is left');
    const off = $skia(kit, { font, width: 100, height: 100, aria: false });
    const stop = attach(off, canvas);
    assert.equal(host.querySelector('[data-ren-aria-enable]'), null);
    stop();
    off.close();
    const on = $skia(kit, { font, width: 100, height: 100 });
    const mirrored = attach(on, canvas);
    assert.ok(host.querySelector('[data-ren-aria]') !== null, 'the mirror is built by default');
    mirrored();
    on.close();
    skia.close();
  });

  it('moves focus with Tab and Shift+Tab', () => {
    const skia = make(300, 400);
    const log = [];
    render(() => (
      <View>
        <Edit label="A" onFocus={() => log.push('A')} />
        <Show when={false}><Edit label="absent" /></Show>
        <Edit label="hidden" hidden />
        <Edit label="B" onFocus={() => log.push('B')} />
        <Action text="C" onFocus={() => log.push('C')} />
      </View>
    ), skia);
    skia.key('Tab');
    skia.key('Tab');
    skia.key('Tab');
    assert.deepEqual(log, ['A', 'B', 'C']);
    // Keyboard focus rings the Action: 2 outside its box (0..300, 76..114).
    assert.ok(skia.commands().some(c => c[0] === 'border' && c[1] === -2 && c[2] === 74 && c[5] === '#ff4b5367'));
    skia.key('Tab');
    skia.key('Tab', true);
    assert.deepEqual(log, ['A', 'B', 'C', 'A', 'C']);
    skia.close();
  });

  it('inserts, moves and removes Show and For regions', () => {
    const skia = make(300, 800);
    const root = $root('app');
    const items = $signal(root, ['a', 'b', 'c']);
    const open = $signal(root, true);
    render(() => (
      <View>
        <Show when={open} fallback={<Label text="closed" />}><Label text="open" /></Show>
        <For each={items}>{item => <Label text={item} />}</For>
        <Label text="end" />
      </View>
    ), skia, { root });
    assert.deepEqual(texts(skia), ['open', 'a', 'b', 'c', 'end']);
    $write(items, ['c', 'a', 'd']);
    assert.deepEqual(texts(skia), ['open', 'c', 'a', 'd', 'end']);
    $write(open, false);
    assert.deepEqual(texts(skia), ['closed', 'c', 'a', 'd', 'end']);
    $write(items, []);
    assert.deepEqual(texts(skia), ['closed', 'end']);
    // Labels stack a line apart: the second one starts below the first.
    const ys = skia.commands().filter(c => c[0] === 'text').map(c => c[3]);
    // Taffy lays out in 32-bit floats: a line of 23.8 comes back as 23.7999992.
    assert.ok(Math.abs(ys[1] - ys[0] - L) < 1e-4, `labels ${ys[1] - ys[0]} apart`);
    skia.close();
  });

  it('scrolls regions and the page, and wraps labels', () => {
    const skia = make(300, 300);
    const rows = Array.from({ length: 20 }, (_, i) => `row ${i}`);
    render(() => (
      <View>
        <Scroll height={100}>{rows.map(r => <Label text={r} />)}</Scroll>
        <Label wrap text="a long label that wraps across more than one line of this narrow page" />
        {rows.map(r => <Label text={r} />)}
      </View>
    ), skia);
    /** The texts drawn inside the region, before the wrapped label. */
    const region = () => {
      const all = texts(skia);
      return all.slice(0, all.findIndex(t => t.startsWith('a long')));
    };
    /** The rows a 100-high region shows from `offset`: those a line box reaches into. */
    const visible = offset => rows.filter((_, i) => (i + 1) * L > offset && i * L < offset + 100);
    assert.deepEqual(region(), visible(0), 'the region clips its rows');
    const wrapped = texts(skia).filter(t => t.startsWith('a long') || t.includes('narrow'));
    assert.equal(wrapped.length, 2, 'the label wraps into lines of its own');
    assert.equal(skia.wheel(100, 60, 170), true);
    assert.deepEqual(region(), visible(170), 'the region scrolled');
    const frames = skia.frames;
    assert.equal(skia.wheel(100, 60, 0), false);
    assert.equal(skia.frames, frames, 'no scroll, no repaint');
    // Below the region, the wheel scrolls the page.
    assert.equal(skia.wheel(100, 250, 100), true);
    assert.equal(skia.page, 100);
    assert.ok(skia.commands().some(c => c[0] === 'rect' && c[1] === 292), 'the page bar');
    skia.close();
  });

  it('draws only what is in view of a long page and region', () => {
    const skia = make(300, 400);
    const pressed = [];
    const n = Array.from({ length: 500 }, (_, i) => i);
    render(() => (
      <View>
        <Scroll height={150}>{n.map(i => <Label text={`r${i}`} />)}</Scroll>
        {n.map(i => <Action text={`a${i}`} onPress={() => pressed.push(i)} />)}
      </View>
    ), skia);
    const all = texts(skia);
    /** The rows a 150-high region shows from `offset`. */
    const visible = offset => n.filter(i => (i + 1) * L > offset && i * L < offset + 150).map(i => `r${i}`);
    assert.deepEqual(all.filter(t => t[0] === 'r'), visible(0));
    assert.ok(all.length < 25, `${all.length} texts drawn`);
    skia.wheel(100, 100, 3400);
    assert.deepEqual(texts(skia).filter(t => t[0] === 'r'), visible(3400), 'the region scrolled by 3400');
    skia.wheel(100, 300, 20000);
    const shown = skia.commands().filter(c => c[0] === 'text');
    assert.ok(shown.length < 12, `${shown.length} texts drawn after the page scrolled`);
    const [, label, , y] = shown[2];
    skia.press(100, y - 6);
    assert.deepEqual(pressed, [Number(label.slice(1))], 'hit regions follow what is drawn');
    skia.close();
  });

  // The image cache's contract (replay.js, above IMAGES), a case each, with damage repaint on.
  /**
   * A renderer counting loads, drawing a label, a row of images and, with `box`, one small box's image.
   * @param {{ box?: boolean, image?: (source: string) => any }} [options]
   */
  const gallery = ({ box = false, image } = {}) => {
    const made = kit.MakeSurface(2, 2);
    const shot = made.makeImageSnapshot();
    const png = shot.encodeToBytes();
    shot.delete();
    made.delete();
    const counted = { loads: 0 };
    const skia = $skia(kit, { font, width: 400, height: 400, image: image ?? (() => (counted.loads++, png)) });
    assert.equal(skia.partial, true);
    const root = $root('app');
    const text = $signal(root, 'frame 0');
    const sources = $signal(root, forty);
    const thumb = $signal(root, 'thumb.png');
    render(() => (
      <View>
        <Label text={text} />
        <View height={200} />
        <Layout layout="row"><For each={sources}>{source => <Image source={source()} width={8} height={8} />}</For></Layout>
        {box ? <Image source={thumb} width={8} height={8} /> : null}
      </View>
    ), skia, { root });
    /** Presents a frame drawn whole. */
    const whole = () => {
      skia.full = true;
      skia.damage = true;
      skia.present();
      assert.equal(skia.repaint, 'full');
    };
    /** Presents after `write`, a damage-only frame. @param {() => void} write */
    const damaged = write => {
      write();
      $flush(root);
      skia.present();
      assert.equal(skia.repaint, 'damage');
    };
    return { skia, root, text, sources, thumb, counted, whole, damaged };
  };
  const forty = Array.from({ length: 40 }, (_, k) => `${k}.png`);

  it('image cache (a) steady: 40 images over several whole frames load 40 times', () => {
    const { skia, counted, whole } = gallery();
    for (let n = 0; n < 5; n++) whole();
    assert.equal(counted.loads, 40);
    skia.close();
  });

  it('image cache (b) prepend: a new image drawn first loads once more, evicting nothing mid-frame', () => {
    const { skia, root, sources, counted, whole } = gallery();
    whole();
    $write(sources, ['new.png', ...forty]);
    $flush(root);
    whole();
    assert.equal(counted.loads, 41, 'only the new image loads');
    whole();
    assert.equal(counted.loads, 41, 'and none the frame after');
    skia.close();
  });

  it('image cache (c) shrink: fewer drawn whole, back to at most the cache size, keeping those drawn', () => {
    const { skia, root, sources, counted, whole } = gallery();
    whole();
    $write(sources, forty.slice(0, 5));
    $flush(root);
    whole();
    assert.ok(skia.replay.images.size <= 32, `${skia.replay.images.size} cached`);
    for (const source of forty.slice(0, 5)) assert.ok(skia.replay.images.has(source), `${source} kept`);
    assert.equal(counted.loads, 40);
    skia.close();
  });

  it('image cache (d) damage-only frame: images it does not reach stay, still on screen', () => {
    const { skia, text, counted, whole, damaged } = gallery();
    whole();
    assert.equal(counted.loads, 40);
    // Only the label changes: its damage leaves the images undrawn, yet shown.
    damaged(() => $write(text, 'frame 1'));
    assert.equal(skia.replay.images.size, 40, 'none evicted while on screen');
    whole();
    assert.equal(counted.loads, 40, 'the next whole repaint reloads none');
    skia.close();
  });

  it('image cache (e) scroll-box churn: 500 damage-only frames of a new image each stay bounded', () => {
    const { skia, thumb, counted, whole, damaged } = gallery({ box: true });
    whole();
    let most = 0;
    for (let k = 0; k < 500; k++) {
      // A small box scrolls through thumbnails beside the 40, one new each frame.
      damaged(() => $write(thumb, `thumb${k}.png`));
      most = Math.max(most, skia.replay.images.size);
      for (const source of forty) assert.ok(skia.replay.images.has(source), `${source} on screen, kept`);
      assert.ok(skia.replay.images.has(`thumb${k}.png`), 'the one in the box kept');
    }
    // Past what a whole repaint kept (the 40 and the box's one) by the cache size, a frame is drawn whole.
    assert.ok(most <= 41 + 32 + 1, `at most ${most} cached`);
    assert.equal(counted.loads, 541, 'no image on screen reloads');
    skia.close();
  });

  it('image cache (e) with no more than the cache size on screen: at most 2 × 32 + 1', () => {
    const { skia, root, sources, thumb, whole, damaged } = gallery({ box: true });
    $write(sources, []);
    $flush(root);
    whole();
    let most = 0;
    for (let k = 0; k < 500; k++) {
      damaged(() => $write(thumb, `thumb${k}.png`));
      most = Math.max(most, skia.replay.images.size);
      assert.ok(skia.replay.images.has(`thumb${k}.png`));
    }
    assert.ok(most <= 2 * 32 + 1, `at most ${most} cached`);
    skia.close();
  });

  it('frees each surface\'s pixels: 100 renderers made, drawn and closed, and 100 resizes, keep CanvasKit\'s memory flat, drawing the same', () => {
    const pixels = s => Buffer.from(s.surface.getCanvas().readPixels(0, 0, { width: s.width, height: s.height, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB }));
    const view = () => <View style={{ padding: 8 }}><Label text="Pixels freed" /><Label text="bold" style={{ fontWeight: 'bold' }} /></View>;
    const cycle = () => {
      const skia = $skia(kit, { font, width: 640, height: 480 });
      const dispose = render(view, skia);
      skia.present();
      const drawn = pixels(skia);
      dispose();
      skia.close();
      return drawn;
    };
    const first = cycle();
    const before = kit.HEAPU8.length;
    let last = first;
    for (let k = 0; k < 100; k++) last = cycle();
    assert.ok(last.equals(first), 'the same pixels');
    // Each surface holds 640 × 480 × 4 bytes (1.2 MB) of pixels: kept after close, 100 grew it by over 100 MB.
    const grown = kit.HEAPU8.length - before;
    assert.ok(grown <= 8 << 20, `CanvasKit's memory grew ${(grown / 1048576).toFixed(1)} MB over 100 renderers`);
    // A resize makes a new surface: the old one's pixels go too.
    const skia = $skia(kit, { font, width: 640, height: 480 });
    render(view, skia);
    const start = kit.HEAPU8.length;
    for (let k = 0; k < 100; k++) {
      skia.resize(640 + (k % 2), 480);
      skia.present();
    }
    const resized = kit.HEAPU8.length - start;
    assert.ok(resized <= 8 << 20, `CanvasKit's memory grew ${(resized / 1048576).toFixed(1)} MB over 100 resizes`);
    skia.close();
  });

  it('tells an Image that reaches a source that already failed, at mount or on a change, with no load again', async () => {
    /** @type {string[]} */
    const heard = [];
    let loads = 0;
    const skia = $skia(kit, { font, width: 120, height: 60, image: () => {
      loads++;
      throw new Error('404');
    } });
    const root = $root('app');
    const second = $signal(root, false);
    const source = $signal(root, 'gone.png');
    render(() => (
      <View style={{ direction: 'row' }}>
        <Image source={() => $read(source)} width={20} height={20} onError={() => heard.push('A')} />
        <Show when={() => $read(second)}><Image source="gone.png" width={20} height={20} onError={() => heard.push('B')} /></Show>
      </View>
    ), skia, { root });
    /** A frame, then the microtasks that tell its failures. */
    const frame = async () => {
      $flush(root);
      skia.present();
      for (let k = 0; k < 3; k++) await Promise.resolve();
    };
    await frame();
    assert.deepEqual(heard, ['A']);
    $write(second, true);
    await frame();
    assert.deepEqual(heard, ['A', 'B'], 'an Image mounted on a source that failed hears error');
    assert.equal(loads, 1, 'and it is not loaded again');
    $write(source, 'here.png');
    await frame();
    $write(source, 'gone.png');
    await frame();
    assert.deepEqual(heard, ['A', 'B', 'A', 'A'], 'back on the failed source, it hears error again');
    assert.equal(loads, 2, 'here.png once, gone.png never again');
    skia.close();
  });

  it('forgets a failed source the cache evicted: loaded again, a success is no error', async () => {
    const made = kit.MakeSurface(2, 2);
    const shot = made.makeImageSnapshot();
    const png = shot.encodeToBytes();
    shot.delete();
    made.delete();
    let flaky = 0;
    /** @type {string[]} */
    const heard = [];
    const skia = $skia(kit, { font, width: 400, height: 200, image: (/** @type {string} */ source) => {
      if (source !== 'flaky.png') return png;
      if (++flaky === 1) throw new Error('503');
      return png;
    } });
    const root = $root('app');
    const sources = $signal(root, ['flaky.png']);
    render(() => (
      <Layout layout="row">
        <For each={sources}>{source => <Image source={source()} width={4} height={4} onError={() => heard.push(source())} />}</For>
      </Layout>
    ), skia, { root });
    const frame = async () => {
      $flush(root);
      skia.full = true;
      skia.damage = true;
      skia.present();
      for (let k = 0; k < 3; k++) await Promise.resolve();
    };
    await frame();
    assert.deepEqual(heard, ['flaky.png']);
    // Whole repaints of 40 others push the failed entry out of the cache.
    for (let f = 0; f < 3; f++) {
      $write(sources, Array.from({ length: 40 }, (_, i) => `ok${f}-${i}.png`));
      await frame();
    }
    assert.equal(skia.broken.has('flaky.png'), false, 'the replay reported it forgotten');
    $write(sources, ['flaky.png']);
    await frame();
    assert.equal(flaky, 2, 'loaded again');
    assert.deepEqual(heard, ['flaky.png'], 'and it loaded: no error this time');
    skia.close();
  });

  it('shares one typeface per font: 100 roots made, drawn and closed keep CanvasKit\'s memory flat', () => {
    const a = $skia(kit, { font, width: 10, height: 10 });
    const b = $skia(kit, { font, width: 10, height: 10 });
    // A typeface stays alive in CanvasKit's glyph cache once text is drawn in it, about 1 MB each:
    // one made and deleted per root would grow without bound.
    assert.equal(a.fonts.regular.face, b.fonts.regular.face, 'one typeface for the same font');
    a.close();
    b.close();
    const cycle = () => {
      const skia = $skia(kit, { font, width: 120, height: 90 });
      const dispose = render(() => <View><Label text="shared" /></View>, skia);
      skia.present();
      dispose();
      skia.close();
    };
    cycle();
    const before = kit.HEAPU8.length;
    for (let k = 0; k < 100; k++) cycle();
    const grown = kit.HEAPU8.length - before;
    assert.ok(grown <= 4 << 20, `CanvasKit's memory grew ${(grown / 1048576).toFixed(1)} MB over 100 roots (bound 4 MB)`);
    const c = $skia(kit, { font, width: 10, height: 10 });
    assert.equal(c.fonts.regular.face, a.fonts.regular.face, 'the typeface outlives its renderers');
    c.close();
  });

  it('shares one typeface per font content: the same bytes read again for each root keep CanvasKit\'s memory flat', () => {
    const copies = [
      new Uint8Array(font),
      font.buffer.slice(font.byteOffset, font.byteOffset + font.byteLength),
      new Uint8Array(new Uint8Array(font.byteLength + 1).fill(0).buffer, 1, font.byteLength),
    ];
    copies[2].set(font);
    const first = $skia(kit, { font, width: 10, height: 10 });
    for (const bytes of copies) {
      const other = $skia(kit, { font: bytes, width: 10, height: 10 });
      assert.equal(other.fonts.regular.face, first.fonts.regular.face, `a fresh ${bytes.constructor.name} of the same font shares its typeface`);
      other.close();
    }
    first.close();
    const cycle = () => {
      // Read again for each root: a new object every time, the same content.
      const skia = $skia(kit, { font: new Uint8Array(font), width: 120, height: 90 });
      const dispose = render(() => <View><Label text="read again" /></View>, skia);
      skia.present();
      dispose();
      skia.close();
    };
    cycle();
    const before = kit.HEAPU8.length;
    for (let k = 0; k < 100; k++) cycle();
    const grown = kit.HEAPU8.length - before;
    // By the object given, each copy made a typeface CanvasKit kept: 25.6 MB over 200 roots.
    assert.ok(grown <= 4 << 20, `CanvasKit's memory grew ${(grown / 1048576).toFixed(1)} MB over 100 roots (bound 4 MB)`);
  });

  it('font cache: an animated font size keeps a bounded number of CanvasKit fonts and draws right', () => {
    const view = size => () => <View><Label text="Sizes" style={() => ({ fontSize: $read(size), color: '#000', fontWeight: 'bold' })} /></View>;
    const skia = make(120, 40);
    const root = $root('app');
    const size = $signal(root, 12);
    render(view(size), skia, { root });
    const deleted = { n: 0 };
    let last = 0;
    for (let k = 0; k < 500; k++) {
      last = 12 + k * 0.01;
      $write(size, last);
      $flush(root);
      skia.present();
      for (const face of skia.fonts.regular.sizes.values())
        if (face.font.delete.counted !== true) {
          const del = face.font.delete.bind(face.font);
          face.font.delete = Object.assign(() => (deleted.n++, del()), { counted: true });
        }
    }
    const kept = skia.fonts.regular.sizes.size;
    assert.ok(kept <= 64, `${kept} CanvasKit font sizes held`);
    assert.ok(skia.fonts.sfnt.sizes.size <= 64, `${skia.fonts.sfnt.sizes.size} width caches`);
    assert.ok(deleted.n > 0, 'evicted fonts are deleted');
    // Keyed by the size text is set at: 500 sizes a hundredth apart set at fewer.
    assert.ok([...skia.fonts.regular.sizes.keys()].every(s => s === skia.fonts.sfnt.sized(s)));
    // What it draws is what a fresh renderer draws at the last size.
    const fresh = make(120, 40);
    const other = $root('app');
    render(view($signal(other, last)), fresh, { root: other });
    fresh.present();
    const pixels = s => Buffer.from(s.surface.getCanvas().readPixels(0, 0, { width: s.width, height: s.height, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB }));
    skia.full = true;
    skia.damage = true;
    skia.present();
    assert.ok(pixels(skia).equals(pixels(fresh)), 'the same pixels');
    assert.ok(pixels(skia).some((v, k) => k % 4 === 0 && v < 128), 'text drawn');
    fresh.close();
    skia.close();
  });

  it('font cache: a frame drawing more sizes than the bound keeps them all until it ends', () => {
    // Tall enough that all 70 lines are on the page, so the frame draws each.
    const skia = make(100, 2400);
    const root = $root('app');
    const count = $signal(root, 70);
    render(() => (
      <View>
        <For each={() => Array.from({ length: $read(count) }, (_, k) => k)}>{k => <Label text="s" style={{ fontSize: 8 + k() * 0.25 }} />}</For>
      </View>
    ), skia, { root });
    skia.present();
    assert.equal(skia.fonts.regular.sizes.size, 70, 'none evicted while that frame drew them');
    $write(count, 3);
    $flush(root);
    skia.full = true;
    skia.damage = true;
    skia.present();
    assert.equal(skia.fonts.regular.sizes.size, 64, 'back to the bound, after the frame');
    for (const s of [8, 8.25, 8.5]) assert.ok(skia.fonts.regular.sizes.has(s), `${s} drawn last, kept`);
    skia.close();
  });

  it('image cache (f) a throwing, rejecting or null loader marks its entry failed, without aborting the frame', async () => {
    /** @type {string[]} */
    const failed = [];
    const { skia, root, sources, whole } = gallery({ image: source => {
      if (source === '0.png') throw new Error('no such image');
      if (source === '1.png') return Promise.reject(new Error('404'));
      if (source === '2.png') return null;
      return new Uint8Array([1, 2, 3]);
    } });
    /** @type {() => void} */
    let heard = () => {};
    const reported = new Promise(resolve => (heard = () => resolve(undefined)));
    skia.failed = source => {
      failed.push(source);
      if (forty.slice(0, 4).every(s => failed.includes(s))) heard();
    };
    $write(sources, forty.slice(0, 4));
    $flush(root);
    whole();
    assert.ok(skia.commands().some(c => c[0] === 'text' && c[1] === 'frame 0'), 'the frame went on past the images');
    assert.equal(failed.length, 0, 'told after the frame');
    // Each reported, 3.png for bytes that do not decode.
    await reported;
    for (const source of forty.slice(0, 4)) {
      const entry = skia.replay.images.get(source);
      assert.ok(entry && entry.image === null && !entry.loading, `${source} failed, kept`);
    }
    skia.close();
  });

  it('repaints only damaged rectangles, with the pixels of a full repaint', async () => {
    // An image whose load finishes later: its pixels change with no command changing.
    const made = kit.MakeSurface(8, 8);
    made.getCanvas().drawColorInt(0xffcc2200, kit.BlendMode.Src);
    const shot = made.makeImageSnapshot();
    const png = shot.encodeToBytes();
    shot.delete();
    made.delete();
    const run = partial => {
      const loads = [];
      const skia = $skia(kit, { font, width: 300, height: 400, image: () => {
        /** @type {(bytes: any) => void} */
        let resolve = () => {};
        const loading = new Promise(r => (resolve = r));
        // Finishes the load; resolves once the renderer took it (its `then` came first).
        loads.push(() => (resolve(png), loading));
        return loading;
      } });
      skia.partial = partial;
      const root = $root('app');
      const rows = $signal(root, Array.from({ length: 30 }, (_, i) => ({ id: i, label: $signal(root, `row ${i}`) })));
      const value = $signal(root, 'v');
      const fill = $signal(root, 0xff336699);
      const open = $signal(root, false);
      const hide = $signal(root, false);
      render(() => (
        <View>
          <Layout fill={fill} pad={4}><Label text="head" /></Layout>
          <Edit label="Name" value={value} onChange={e => $write(value, e.value)} />
          <Image source="a.png" height={20} />
          <Label text="hideable" hidden={hide} />
          <Scroll height={100}><For each={rows}>{row => <Label text={row().label} />}</For></Scroll>
          <For each={rows}>{row => <Layout layout="row"><Label text={row().label} /><Action text="x" onPress={() => {}} /></Layout>}</For>
          <Show when={open}><Portal><Label text="over" fill={0xffeeeeee} /></Portal></Show>
        </View>
      ), skia, { root });
      const swap = () => {
        const list = $read(rows).slice();
        [list[1], list[28]] = [list[28], list[1]];
        $write(rows, list);
      };
      const steps = [
        () => $write($read(rows)[0].label, 'changed'),
        swap,
        swap,
        () => $write(fill, 0xff993366),
        () => skia.press(...spot(skia, 4)),
        () => skia.type('abc'),
        () => skia.key('ArrowLeft', true),
        () => skia.compose('ka'),
        () => skia.commit('か'),
        () => $write(hide, true),
        () => $write(hide, false),
        () => $write(open, true),
        () => $write(open, false),
        () => skia.wheel(100, 160, 60),
        () => skia.wheel(100, 380, 200),
        () => skia.wheel(100, 380, -200),
        () => Promise.all(loads.splice(0).map(load => load())),
        () => $write(rows, $read(rows).slice(3)),
        () => skia.resize(280, 380),
        () => $write($read(rows)[3].label, 'again'),
      ];
      return { skia, steps };
    };
    const full = run(false);
    const part = run(true);
    const pixels = skia => Buffer.from(skia.surface.getCanvas().readPixels(0, 0, { width: skia.width, height: skia.height, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB }));
    const kinds = [];
    for (let i = 0; i < full.steps.length; i++) {
      await Promise.all([full.steps[i](), part.steps[i]()]);
      full.skia.present();
      part.skia.present();
      kinds.push(part.skia.repaint);
      const p = pixels(part.skia);
      const q = pixels(full.skia);
      if (!p.equals(q)) {
        // Where they differ, for the message.
        let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
        const w = part.skia.width;
        for (let k = 0; k < p.length; k += 4)
          if (p[k] !== q[k] || p[k + 1] !== q[k + 1] || p[k + 2] !== q[k + 2]) {
            const x = (k / 4) % w, y = Math.floor(k / 4 / w);
            x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
          }
        assert.fail(`step ${i} (${part.skia.repaint}): pixels differ in ${x0},${y0}..${x1},${y1}`);
      }
    }
    assert.equal(full.skia.repaint, 'full');
    assert.equal(kinds[0], 'damage', 'a label change repaints its rectangle');
    assert.ok(kinds.filter(k => k === 'damage').length >= 10, kinds.join(' '));
    full.skia.close();
    part.skia.close();
  });

  it('renders portals over the page and resizes', () => {
    const skia = make(200, 200);
    const root = $root('app');
    const open = $signal(root, true);
    render(() => <View><Label text="page" /><Show when={open}><Portal><Label text="over" /></Portal></Show></View>, skia, { root });
    assert.deepEqual(texts(skia), ['page', 'over']);
    $write(open, false);
    assert.deepEqual(texts(skia), ['page']);
    skia.resize(400, 100);
    assert.deepEqual(skia.commands()[1], ['clip', 0, 0, 400, 100]);
    assert.equal(skia.pixel(399, 99), skia.pixel(399, 99));
    skia.close();
  });

  it('routes canvas events through attach', () => {
    const skia = make();
    const listeners = new Map();
    const canvas = {
      tabIndex: -1,
      addEventListener: (name, fn) => listeners.set(name, fn),
      removeEventListener: name => listeners.delete(name),
    };
    let pressed = 0;
    render(() => <Action text="Go" onPress={() => pressed++} />, skia);
    const detach = attach(skia, canvas);
    let prevented = 0;
    const preventDefault = () => prevented++;
    listeners.get('pointerdown')({ offsetX: 100, offsetY: 20, button: 0, preventDefault });
    assert.equal(pressed, 1);
    listeners.get('keydown')({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault });
    assert.equal(pressed, 2);
    assert.equal(prevented, 2);
    assert.equal(canvas.tabIndex, 0);
    detach();
    assert.equal(listeners.size, 0);
    skia.close();
  });

  it('shows the cursor through attach, on a move and after a frame under a still pointer', () => {
    const skia = make();
    const listeners = new Map();
    const canvas = {
      tabIndex: -1,
      style: { cursor: '' },
      addEventListener: (name, fn) => listeners.set(name, fn),
      removeEventListener: name => listeners.delete(name),
    };
    const root = $root('app');
    const tool = $signal(root, 'grab');
    render(() => <View><View style={() => ({ height: 50, cursor: $read(tool) })} /></View>, skia, { root });
    const detach = attach(skia, canvas);
    listeners.get('pointermove')({ offsetX: 10, offsetY: 10 });
    assert.equal(canvas.style.cursor, 'grab');
    $write(tool, 'crosshair');
    skia.present();
    assert.equal(canvas.style.cursor, 'crosshair', 'a redraw shows the new cursor with no move');
    detach();
    skia.close();
  });

  it("behaves as an application through attach by default: Ctrl+A and the browser's context menu stay away; as a page with behavior: 'page'", () => {
    for (const behavior of /** @type {const} */ ([undefined, 'page'])) {
      const skia = $skia(kit, { font, width: 200, height: 200, behavior });
      const listeners = new Map();
      /** @type {Map<string, string>} */
      const props = new Map();
      const canvas = {
        tabIndex: -1,
        style: { cursor: '', setProperty: (/** @type {string} */ name, /** @type {string} */ value) => void props.set(name, value), getPropertyValue: (/** @type {string} */ name) => props.get(name) ?? '', removeProperty: (/** @type {string} */ name) => void props.delete(name) },
        addEventListener: (/** @type {string} */ name, /** @type {any} */ fn) => listeners.set(name, fn),
        removeEventListener: (/** @type {string} */ name) => listeners.delete(name),
      };
      render(() => <View><Label text="loose text" /></View>, skia);
      const detach = attach(skia, canvas);
      const app = behavior === undefined;
      let prevented = false;
      const preventDefault = () => void (prevented = true);
      listeners.get('keydown')({ key: 'a', shiftKey: false, ctrlKey: true, metaKey: false, altKey: false, preventDefault });
      assert.equal(prevented, true, 'Ctrl+A: the app\'s nothing, or the page\'s text');
      assert.equal(skia.copied(), app ? '' : 'loose text');
      prevented = false;
      listeners.get('contextmenu')({ offsetX: 10, offsetY: 10, preventDefault });
      assert.equal(prevented, app, 'the context menu over text');
      prevented = false;
      listeners.get('contextmenu')({ offsetX: 150, offsetY: 150, preventDefault });
      assert.equal(prevented, app, 'the context menu over nothing');
      assert.equal(props.get('-webkit-touch-callout'), app ? 'none' : undefined);
      detach();
      assert.equal(props.size, 0);
      skia.close();
    }
  });

  it('disposes every binding and scene node with the view', () => {
    const skia = make();
    const root = $root('app');
    const items = $signal(root, [1, 2, 3]);
    const before = $stats(root).nodes;
    const dispose = render(() => (
      <View>
        <For each={items}>{item => <Action text={() => String(item())} onPress={() => {}} />}</For>
        <Edit value={() => String($read(items).length)} />
      </View>
    ), skia, { root });
    $write(items, [3, 4]);
    skia.press(100, 20);
    dispose();
    assert.equal(skia.root.first, null, 'the page is empty');
    assert.equal(skia.focused, null, 'focus leaves a removed item');
    assert.deepEqual(skia.commands(), [['save'], ['clip', 0, 0, 200, 200], ['restore'], ['save'], ['clip', 0, 0, 200, 200], ['restore']], 'the empty page and overlay');
    assert.equal($stats(root).nodes, before, 'no node outlives the view');
    assert.equal($stats(root).effects, 0);
    skia.close();
    assert.equal(skia.present(), false, 'a closed renderer does not paint');
  });

  it('selects text with the pointer and paints the selection', () => {
    // A page's: loose text selects.
    const skia = $skia(kit, { font, width: 300, height: 100, behavior: 'page' });
    render(() => <View><Label text="select me please" /></View>, skia);
    skia.press(2, L / 2);
    skia.move(200, L / 2);
    skia.release(200, L / 2);
    assert.equal(skia.copied(), 'select me please');
    const [x0, , x1] = skia.commands().find(c => c[0] === 'rect' && c[5] === '#ffaae4f5').slice(1);
    // Under the text's first glyphs, between their strokes: the selection color shows.
    const y = Math.round(L - 3);
    assert.ok([...Array(Math.floor(x1 - x0 - 2)).keys()].some(i => skia.pixel(x0 + 1 + i, y) === 0xffaae4f5), 'the selection is painted');
    skia.close();
  });

  it('rejects elements outside the ren-core primitives', () => {
    const skia = make();
    assert.throws(() => render(() => <div />, skia), /unsupported element <div>/);
    skia.close();
  });

  it('lays out in a layout worker and paints the same pixels once it answers', { timeout: 30000 }, async t => {
    const channel = new MessageChannel();
    const stop = serveLayout(channel.port2);
    const layout = remoteLayout(channel.port1);
    const view = () => (
      <View style={{ padding: 8, gap: 6 }}>
        <Label wrap text="Laid out elsewhere: the worker sends the boxes, this thread paints them." />
        <View style={{ display: 'grid', columns: '1fr 1fr', gap: 4 }}>
          <Action text="One" />
          <Action text="Two" />
        </View>
      </View>
    );
    const here = make(200, 200);
    const there = $skia(kit, { font, width: 200, height: 200, layout });
    // Closed after the test however it ends, a timeout too (a finally would wait on the hung await).
    closeAfter(t, () => {
      here.close();
      there.close();
      layout.close();
      stop();
      channel.port1.close();
    });
    render(view, here);
    render(view, there);
    assert.equal(there.frames, 0, 'nothing is painted before the answer');
    // It paints once the worker answers (`framed`, after each frame).
    assert.ok(there.boxes.engine.busy);
    await new Promise(resolve => (there.framed = resolve));
    assert.equal(there.frames, 1);
    assert.deepEqual(there.commands(), here.commands());
    for (const [x, y] of [[20, 20], [60, 110], [150, 110], [100, 190]]) assert.equal(there.pixel(x, y), here.pixel(x, y), `pixel ${x}, ${y}`);
  });

  it('draws through WebGL only on a GPU: software WebGL takes CanvasKit\'s raster', () => {
    /** A page whose WebGL renderer has the given name; returns the renderer and whether it asked CanvasKit for WebGL. */
    const on = (/** @type {string} */ name) => {
      let asked = false;
      const gl = { RENDERER: 1, getExtension: (/** @type {string} */ n) => (n === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 2 } : null), getParameter: (/** @type {number} */ p) => (p === 2 ? name : 'WebKit WebGL') };
      const page = { createElement: () => ({ getContext: () => gl }) };
      const canvas = { width: 0, height: 0, ownerDocument: page, getContext: () => null };
      const fake = Object.create(kit);
      fake.GetWebGLContext = () => ((asked = true), 0);
      fake.MakeSWCanvasSurface = (/** @type {any} */ c) => kit.MakeSurface(c.width, c.height);
      const skia = $skia(fake, { font, width: 40, height: 30, canvas: /** @type {any} */ (canvas) });
      return { skia, asked };
    };
    const soft = on('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)');
    assert.equal(soft.asked, false, 'no WebGL context on SwiftShader');
    assert.equal(soft.skia.gpu, false);
    const hard = on('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060, OpenGL 4.5)');
    assert.equal(hard.asked, true, 'WebGL on a GPU');
    soft.skia.close();
    hard.skia.close();
  });

  it('loses the WebGL context it made when it closes', () => {
    let lost = 0;
    const context = { getExtension: (/** @type {string} */ n) => (n === 'WEBGL_lose_context' ? { loseContext: () => void lost++ } : null) };
    const probe = { RENDERER: 1, getExtension: () => null, getParameter: () => 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060, OpenGL 4.5)' };
    const canvas = { width: 0, height: 0, ownerDocument: { createElement: () => ({ getContext: () => probe }) }, getContext: () => context };
    const fake = Object.create(kit);
    fake.GetWebGLContext = () => 1;
    fake.MakeWebGLContext = () => ({ delete() {} });
    fake.MakeOnScreenGLSurface = (/** @type {any} */ _gl, /** @type {number} */ w, /** @type {number} */ h) => kit.MakeSurface(w, h);
    const skia = $skia(fake, { font, width: 40, height: 30, canvas: /** @type {any} */ (canvas) });
    assert.equal(skia.gpu, true);
    skia.close();
    assert.equal(lost, 1);
  });

  it('asks a document whether it draws once, and loses the probe\'s WebGL context', () => {
    let probes = 0;
    let lost = 0;
    const gl = { getExtension: (/** @type {string} */ n) => (n === 'WEBGL_lose_context' ? { loseContext: () => void lost++ } : null) };
    const doc = {
      createElement: () => ({ style: {}, getContext: (/** @type {string} */ kind) => (kind === 'webgl2' ? (probes++, gl) : null) }),
    };
    const element = { ownerDocument: doc, appendChild() {} };
    const a = /** @type {any} */ ($skia(kit, { font, width: 20, height: 10 }));
    const b = /** @type {any} */ ($skia(kit, { font, width: 20, height: 10 }));
    // Only the probe is counted here; what canvasFor does after it on these
    // fake canvases may throw, which this test leaves aside.
    try { a.canvasFor(element); } catch {}
    try { b.canvasFor(element); } catch {}
    assert.equal(probes, 1, 'one probe per document');
    assert.equal(lost, 1, 'its context lost at once');
    a.close();
    b.close();
  });

  it('repaints a moved piece that reaches past the canvas edge (the damage pass ends)', () => {
    const skia = make(200, 100);
    const root = $root('app');
    const x = $signal(root, 5);
    render(() => <View><Label text="a label as wide as the canvas and more" style={() => ({ width: '100%', translate: [$read(x), 0] })} /></View>, skia, { root });
    skia.present();
    $write(x, 10);
    $flush(root);
    skia.present();
    assert.ok(skia.repaint === 'damage' || skia.repaint === 'full', 'the frame was drawn');
    assert.deepEqual(skia.commands().filter((/** @type {any[]} */ c) => c[0] === 'transform')[0].slice(-2), [10, 0], 'moved');
    skia.close();
  });
});

describe('ren skia WebGL context loss', () => {
  /**
   * The real CanvasKit with its WebGL calls stood in for (node has no
   * WebGL): a GPU surface is a raster one, and each call is logged.
   * @param {string[]} log
   */
  const gpuKit = log => {
    const fake = Object.create(kit);
    let handles = 0;
    fake.GetWebGLContext = () => (log.push('context'), ++handles);
    fake.MakeWebGLContext = (/** @type {number} */ handle) => ({
      releaseResourcesAndAbandonContext: () => log.push(`abandon ${handle}`),
      delete: () => log.push(`delete ${handle}`),
    });
    fake.MakeOnScreenGLSurface = (/** @type {any} */ _gl, /** @type {number} */ w, /** @type {number} */ h) => (log.push(`surface ${w}x${h}`), kit.MakeSurface(w, h));
    fake.deleteContext = (/** @type {number} */ handle) => log.push(`deleteContext ${handle}`);
    return fake;
  };

  /**
   * A canvas whose WebGL context the browser can lose and restore, as the
   * WEBGL_lose_context extension does: the events at the canvas.
   * @param {string[]} log
   */
  const glCanvas = log => {
    const canvas = Object.assign(new EventTarget(), { width: 0, height: 0, getContext: (/** @type {string} */ kind) => (kind === 'webgl2' ? gl : null) });
    const extension = {
      loseContext() {
        log.push('loseContext');
        const event = new Event('webglcontextlost', { cancelable: true });
        canvas.dispatchEvent(event);
        return event;
      },
      restoreContext() {
        canvas.dispatchEvent(new Event('webglcontextrestored'));
      },
    };
    const gl = { getExtension: (/** @type {string} */ name) => (name === 'WEBGL_lose_context' ? extension : null) };
    return { canvas, extension };
  };

  it('stops drawing on a lost context and draws the whole frame on the restored one', () => {
    /** @type {string[]} */
    const log = [];
    const { canvas, extension } = glCanvas(log);
    const skia = $skia(gpuKit(log), { font, width: 40, height: 20, background: 0xffffffff, canvas });
    const root = $root('app');
    const on = $signal(root, false);
    skia.partial = true;
    render(() => <View style={() => ({ width: 60, height: 30, background: $read(on) ? '#000000' : '#ffffff' })} />, skia, { root });
    skia.present();
    assert.equal(skia.pixel(10, 10), 0xffffffff);
    assert.deepEqual(log.splice(0), ['context', 'surface 40x20']);

    const event = extension.loseContext();
    assert.equal(event.defaultPrevented, true, 'the browser may restore it');
    assert.equal(skia.drawing, false);
    assert.deepEqual(log.splice(0), ['loseContext', 'abandon 1', 'delete 1', 'deleteContext 1'], 'the GPU objects are abandoned, then freed');
    $write(on, true);
    $flush(root);
    skia.present();
    skia.resize(60, 30);
    skia.present();
    assert.equal(skia.drawing, false, 'nothing is drawn on a lost context');
    assert.equal(skia.pixel(10, 10), 0);
    assert.deepEqual(log, [], 'no surface while lost');

    extension.restoreContext();
    assert.deepEqual(log.splice(0), ['context', 'surface 60x30'], 'a new context and surface, at the current size');
    assert.equal(skia.drawing, true);
    assert.equal(skia.repaint, 'full', 'the whole frame');
    assert.equal(skia.pixel(10, 10), 0xff000000, 'what changed while lost is shown');
    assert.equal(skia.pixel(55, 25), 0xff000000);
    skia.close();
    assert.deepEqual(log, ['delete 2', 'deleteContext 2', 'loseContext'], 'close frees the context and lets the browser one go');
  });

  it('closes on a lost context without throwing, and lets it go once restored', () => {
    /** @type {string[]} */
    const log = [];
    const { canvas, extension } = glCanvas(log);
    const skia = $skia(gpuKit(log), { font, width: 20, height: 10, canvas });
    render(() => <Label text="a" />, skia);
    skia.present();
    extension.loseContext();
    log.length = 0;
    skia.close();
    assert.deepEqual(log, [], 'nothing left to free');
    extension.restoreContext();
    assert.deepEqual(log, ['loseContext'], 'the restored context is let go at once');
    log.length = 0;
    extension.restoreContext();
    extension.loseContext();
    extension.restoreContext();
    assert.deepEqual(log, ['loseContext'], 'its events unwatched');
  });
});
