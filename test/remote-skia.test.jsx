// The worker mode on the Skia renderer: the same components rendered direct
// into one Renderer and through serve/connect into another must paint the same
// command buffers and pixels after every step; input the renderer routes
// (press, key, type, focus) crosses to the worker and back.

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { $root, $signal, $read, $write, $defer } from 'rrx-core';
import { Show, For, Portal, Choose, When, View, Layout, Scroll, Label, Edit, Action, Shape } from 'ren-core';
import { $skia, render, loadLayout } from 'ren-skia';
import { serve } from 'ren-core/worker';
import { connect } from 'ren-core/remote';
import { setFlagsFromString } from 'node:v8';

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

/** @type {(() => void)[]} */
let closing = [];
afterEach(() => {
  for (const close of closing) close();
  closing = [];
});

const texts = skia => skia.commands().filter(c => c[0] === 'text').map(c => c[1]);

const pair = (scenario, { width = 300, height = 400, serve: served = {} } = {}) => {
  const direct = $skia(kit, { font, width, height });
  const remote = $skia(kit, { font, width, height });
  const a = $root('app');
  const b = $root('app');
  const left = scenario(a);
  const right = scenario(b);
  render(left.view, direct, { root: a });
  const { port1, port2 } = new MessageChannel();
  const connection = connect(port2, remote, remote.root, { schedule: 'now' });
  const session = serve(right.view, { port: port1, root: b, ...served });
  closing.push(() => {
    connection.close();
    session.close();
    port1.close();
    port2.close();
    direct.close();
    remote.close();
  });
  const same = async label => {
    await connection.idle();
    assert.deepEqual(remote.commands(), direct.commands(), label);
  };
  /** The same input on both renderers. */
  const both = fn => {
    fn(direct);
    fn(remote);
  };
  return { direct, remote, left, right, connection, session, same, both };
};

describe('ren-core worker mode (Skia)', () => {
  it('paints the same scene, pixels included', { timeout: 30000 }, async () => {
    const t = pair(() => ({
      view: () => (
        <View>
          <Layout fill={0xff336699} pad={10}><Label text="Hi" /></Layout>
          <Action text="Go" />
          <Edit label="Name" value="x" />
          <Shape height={40} shapes={[{ kind: 'rect', x: 0, y: 0, right: 20, bottom: 20, color: 0xffff0000 }]} />
        </View>
      ),
    }));
    await t.same('initial');
    for (const [x, y] of [[5, 5], [30, 40], [160, 120], [30, 230]]) assert.equal(t.remote.pixel(x, y), t.direct.pixel(x, y), `pixel ${x},${y}`);
  });

  it('updates regions and lists like direct: Show, For, For by position, Choose, Portal', { timeout: 30000 }, async () => {
    const t = pair(root => {
      const items = $signal(root, ['a', 'b', 'c']);
      const open = $signal(root, true);
      const n = $signal(root, 1);
      return {
        items,
        open,
        n,
        view: () => (
          <View>
            <Show when={open} fallback={<Label text="closed" />}><Label text="open" /></Show>
            <For each={items}>{item => <Label text={item} />}</For>
            <For by="position" each={items}>{(item, i) => <Label text={() => `${i}:${item()}`} />}</For>
            <Choose fallback={<Label text="other" />}><When when={() => $read(n) === 1}><Label text="one" /></When></Choose>
            <Show when={open}><Portal><Label text="over" /></Portal></Show>
            <Label text="end" />
          </View>
        ),
      };
    });
    await t.same('initial');
    const steps = [
      s => $write(s.items, ['c', 'a', 'd']),
      s => $write(s.open, false),
      s => $write(s.n, 2),
      s => $write(s.items, []),
      s => $write(s.items, ['z']),
      s => $write(s.open, true),
    ];
    for (let i = 0; i < steps.length; i++) {
      steps[i](t.left);
      steps[i](t.right);
      await t.same(`step ${i}`);
    }
    assert.deepEqual(texts(t.remote), ['open', 'z', '0:z', 'other', 'end', 'over']);
  });

  it('routes presses and keys to the worker and paints the answer', { timeout: 30000 }, async () => {
    const t = pair(root => {
      const count = $signal(root, 0);
      return {
        count,
        view: () => (
          <View>
            <Action text="Add" onPress={() => $write(count, $read(count) + 1)} />
            <Label text={() => `count ${$read(count)}`} />
          </View>
        ),
      };
    });
    await t.same('initial');
    t.both(s => assert.equal(s.press(100, 19), true));
    await t.same('pressed');
    t.both(s => {
      s.key('Tab');
      s.key('Enter');
    });
    await t.same('Enter presses the focused Action');
    assert.equal($read(t.right.count), 2);
    assert.deepEqual(texts(t.remote), ['Add', 'count 2']);
  });

  it('types into an Edit, with the app transforming the value', { timeout: 30000 }, async () => {
    const t = pair(root => {
      const value = $signal(root, 'ab');
      const log = [];
      return {
        value,
        log,
        view: () => (
          <View>
            <Edit
              label="Name"
              value={value}
              onChange={e => $write(value, e.value.toUpperCase())}
              onFocus={() => log.push('focus')}
              onKey={e => log.push(`key ${e.key}`)}
              onSubmit={e => log.push(`submit ${e.value}`)}
            />
            <Label text={() => `= ${$read(value)}`} />
          </View>
        ),
      };
    });
    await t.same('initial');
    t.both(s => s.press(250, 19));
    await t.same('focused');
    t.both(s => s.type('cd'));
    await t.same('typed');
    assert.equal($read(t.right.value), 'ABCD');
    t.both(s => {
      s.key('Backspace');
      s.key('x');
    });
    await t.same('edited in one burst');
    assert.equal($read(t.right.value), 'ABCX');
    t.both(s => s.key('Enter'));
    await t.same('submitted');
    assert.deepEqual(t.right.log, t.left.log);
    assert.deepEqual(t.right.log.slice(-2), ['key Enter', 'submit ABCX']);
  });

  it('composes IME text and mirrors selection and native input like direct', { timeout: 30000 }, async () => {
    const t = pair(root => {
      const value = $signal(root, 'ab');
      const log = [];
      return {
        value,
        log,
        view: () => (
          <View>
            <Edit value={value} onChange={e => { log.push(e.value); $write(value, e.value.toUpperCase()); }} />
            <Label text={() => `= ${$read(value)}`} />
          </View>
        ),
      };
    });
    await t.same('initial');
    t.both(s => s.press(250, 19));
    await t.same('focused');
    t.both(s => {
      s.compose('k');
      s.compose('ka');
    });
    await t.same('composing');
    assert.deepEqual(t.right.log, [], 'no change crosses while composing');
    assert.equal(t.remote.focused.draft, 'abka');
    t.both(s => s.commit('か'));
    await t.same('committed');
    assert.deepEqual(t.right.log, ['abか'], 'one change at compositionend');
    assert.deepEqual(t.left.log, t.right.log);
    assert.equal($read(t.right.value), 'ABか');
    t.both(s => s.select(1, 3));
    await t.same('selected');
    assert.ok(t.remote.commands().some(c => c[0] === 'rect' && c[5] === '#ffaae4f5'), 'the selection is drawn');
    t.both(s => s.input('xyz', 3, 3));
    await t.same('native input');
    assert.equal($read(t.right.value), 'XYZ');
    assert.deepEqual(t.right.log, t.left.log);
  });

  it('repaints damaged rectangles in worker mode with the pixels of a direct full repaint', { timeout: 30000 }, async () => {
    const t = pair(root => {
      const rows = $signal(root, Array.from({ length: 20 }, (_, i) => ({ id: i, label: $signal(root, `row ${i}`) })));
      const value = $signal(root, 'ab');
      return {
        rows,
        view: () => (
          <View>
            <Edit value={value} onChange={e => $write(value, e.value.toUpperCase())} />
            <Label text={() => `= ${$read(value)}`} />
            <Scroll height={120}><For each={rows}>{row => <Label text={row().label} />}</For></Scroll>
            <For each={rows}>{row => <Layout layout="row"><Label text={row().label} /><Action text="x" onPress={() => {}} /></Layout>}</For>
          </View>
        ),
      };
    });
    t.direct.partial = false;
    const pixels = skia => Buffer.from(skia.surface.getCanvas().readPixels(0, 0, { width: skia.width, height: skia.height, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB }));
    const swap = s => {
      const list = $read(s.rows).slice();
      [list[1], list[18]] = [list[18], list[1]];
      $write(s.rows, list);
    };
    const steps = [
      [s => $write($read(s.rows)[0].label, 'changed'), null],
      [swap, null],
      [null, r => r.press(250, 19)],
      [null, r => r.type('cd')],
      [null, r => r.compose('x')],
      [null, r => r.commit('y')],
      [null, r => r.select(0, 2)],
      [null, r => r.wheel(100, 160, 50)],
      [swap, null],
    ];
    await t.same('initial');
    const kinds = [];
    for (let i = 0; i < steps.length; i++) {
      const [app, input] = steps[i];
      if (app !== null) {
        app(t.left);
        app(t.right);
      }
      if (input !== null) t.both(input);
      await t.same(`step ${i}`);
      t.direct.present();
      t.remote.present();
      kinds.push(t.remote.repaint);
      assert.ok(pixels(t.remote).equals(pixels(t.direct)), `step ${i}: worker damage repaint differs from direct full repaint`);
    }
    assert.ok(kinds.includes('damage'), kinds.join(' '));
  });

  it('keeps typed text while the worker answers an older edit', { timeout: 30000 }, async () => {
    const t = pair(root => {
      const value = $signal(root, '');
      return { value, view: () => <View><Edit value={value} onChange={e => $write(value, e.value)} /><Label text={value} /></View> };
    });
    await t.same('initial');
    for (let y = 20; y < 120 && t.remote.focused === null; y += 4) t.remote.press(150, y);
    assert.notEqual(t.remote.focused, null, 'the Edit took focus');
    const shown = [];
    t.connection.applied = () => shown.push(t.remote.focused.draft);
    t.remote.key('a');
    await Promise.resolve();
    t.remote.key('b');
    t.remote.key('c');
    await t.connection.idle();
    assert.ok(!shown.includes('a'), `the echo of 'a' never replaces 'abc' (${shown.join(',')})`);
    assert.equal(t.remote.focused.draft, 'abc');
    assert.equal($read(t.right.value), 'abc');
  });

  it('publishes deferred rows in slices and paints the same final frame', { timeout: 30000 }, async () => {
    const t = pair(root => {
      const items = $signal(root, []);
      return { root, items, view: () => <Scroll height={300}><For each={items}>{item => <Label text={() => `row ${item()}`} />}</For></Scroll> };
    }, { serve: { budget: 1e-6 } });
    await t.same('initial');
    const rows = Array.from({ length: 200 }, (_, i) => i);
    $defer(t.left.root, () => $write(t.left.items, rows));
    $defer(t.right.root, () => $write(t.right.items, rows));
    await t.same('all rows');
    assert.ok(t.connection.totals.messages > 3, `several messages (${t.connection.totals.messages})`);
  });

  it('disposes the view and empties the page', { timeout: 30000 }, async () => {
    const t = pair(root => {
      const items = $signal(root, [1, 2, 3]);
      return { items, view: () => <View><For each={items}>{item => <Action text={() => String(item())} onPress={() => {}} />}</For></View> };
    });
    await t.same('initial');
    t.session.dispose();
    await t.connection.idle();
    assert.equal(t.remote.root.first, null);
    assert.deepEqual(t.remote.commands(), [['save'], ['clip', 0, 0, 300, 400], ['restore'], ['save'], ['clip', 0, 0, 300, 400], ['restore']]);
  });

  it('reports a host failure on the main thread', { timeout: 30000 }, async () => {
    const errors = [];
    const remote = $skia(kit, { font, width: 100, height: 100 });
    const { port1, port2 } = new MessageChannel();
    const connection = connect(port2, remote, remote.root, { schedule: 'now', error: e => errors.push(e.message) });
    const session = serve(() => <div />, { port: port1 });
    closing.push(() => {
      connection.close();
      session.close();
      port1.close();
      port2.close();
      remote.close();
    });
    await connection.idle();
    assert.match(errors[0], /unsupported element <div>/);
  });

  it('forwards pointer events to handlers in the worker, as they run direct', { timeout: 30000 }, async () => {
    const t = pair(root => {
      const seen = $signal(root, '-');
      const note = (/** @type {any} */ e) => $write(seen, `${e.type} ${Math.round(e.x)},${Math.round(e.y)}${e.shiftKey ? ' shift' : ''}`);
      return {
        view: () => (
          <View>
            <View style={{ height: 60 }} onPointerDown={note} onPointerMove={note} onPointerUp={note} />
            <Label text={() => $read(seen)} />
          </View>
        ),
      };
    });
    await t.same('first render');
    t.both(r => r.press(30, 20, 1, false, { shiftKey: true }));
    await t.same('pointerdown');
    assert.ok(texts(t.remote).includes('pointerdown 30,20 shift'), texts(t.remote).join(' | '));
    // Inside the view (a worker cannot capture the pointer, as on the DOM).
    t.both(r => r.move(200, 40));
    await t.same('pointermove');
    assert.ok(texts(t.remote).includes('pointermove 200,40'));
    t.both(r => r.release(200, 40));
    await t.same('pointerup');
    assert.ok(texts(t.remote).includes('pointerup 200,40'));
  });
});
