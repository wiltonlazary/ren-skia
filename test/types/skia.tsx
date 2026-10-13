// ren-skia as a TypeScript consumer sees it: a Skia root beside the others.
// skipLibCheck (test/types/tsconfig.json): canvaskit-wasm pulls in @webgpu/types,
// which redeclares what TypeScript 7's lib.dom already has; this file's own
// uses of ren-skia are still checked.
import { Root, $signal, $read, $dispose, View, Label, Action } from 'ren-core';
import { $skia, render, attach, decode, Theme } from 'ren-skia';

declare const kit: any;
declare const font: ArrayBuffer;
declare const canvas: HTMLCanvasElement;
const skia = $skia(kit, { font, width: 320, height: 200, theme: { canvas: 0xff000000 } });
const root = Root({ id: 'paint', renderer: skia, children: () => <App /> });
const count = $signal(root, 0);
const App = () => (
  <View>
    <Label text={() => `count ${$read(count)}`} />
    <Action text="add" onPress={() => {}} />
  </View>
);
const stop: () => void = attach(skia, canvas);
const dispose: () => void = render(() => <Label text="x" />, $skia(kit, { font, width: 10, height: 10 }));
const theme: Theme = new Theme();
void decode, stop, dispose, theme;
$dispose(root);
