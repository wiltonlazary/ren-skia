// The Fonts of ren-skia (ren-canv measures text through one): the
// application typeface, a monospace one, typefaces by family name and
// fallback ones when given, as CanvasKit fonts that draw them, measured
// from the font files themselves (ren-canv's Faces over Sfnt), which give
// what they draw: the typefaces' advances, or the glyphs a shaper set
// (joined scripts, clusters, marks), drawn as set.

import { Faces, Sfnt } from 'ren-canv';
import { MONO, RTL, SLOT } from 'ren-canv/backend';

/** @typedef {import('canvaskit-wasm').CanvasKit} Kit */
/** @typedef {import('canvaskit-wasm').Font} Font */
/** @typedef {import('canvaskit-wasm').Typeface} Typeface */

/**
 * The sizes a typeface keeps CanvasKit fonts at. The cache's contract
 * (Replay's image cache evicts at the same point):
 * - a font is kept by the size text is set at (Sfnt's `sized`, a 64th), so
 *   sizes that set the same share it;
 * - nothing is evicted during a frame: a font a frame draws with stays
 *   until the frame ends, however many sizes it draws;
 * - at the end of a frame (`evict`, from Replay's `run`), the least
 *   recently drawn sizes not drawn in that frame go, their CanvasKit fonts
 *   (and styled ones) deleted, until at most FONTS remain per typeface.
 *   Between frames a typeface so holds at most FONTS sizes, or the sizes
 *   the last frame drew when it drew more. A size drawn again is made anew.
 */
const FONTS = 64;

/** A font at one size and its styled variants. */
class Face {
  /** @param {Font} font @param {number} drawn */
  constructor(font, drawn) {
    this.font = font;
    /** The bold, italic and bold italic fonts, by flags, made on first use. @type {(Font | undefined)[]} */
    this.styled = [];
    /** The frame that last drew with it. */
    this.drawn = drawn;
  }

  close() {
    this.font.delete();
    for (const styled of this.styled) styled?.delete();
  }
}

/**
 * The typefaces made, by CanvasKit and by the font's content: one per pair,
 * shared by every renderer, and never deleted. Once text is drawn,
 * CanvasKit's glyph cache keeps a deleted typeface's data alive, so a
 * typeface per renderer grew its memory about 1 MB with every Skia root
 * made again, and so did the same font's bytes read again for each root.
 * The content is found by its length and hash, then compared byte for byte;
 * a bytes object given before finds it at once. The fonts at each size
 * stay each renderer's own.
 * @type {WeakMap<Kit, { given: WeakMap<object, Typeface>, byContent: Map<string, { bytes: Uint8Array, face: Typeface }[]> }>}
 */
const typefaces = new WeakMap();

/** Aligned bytes (their offset a multiple of 4) as 32-bit words, four bytes at a time. @param {Uint8Array} bytes */
const words = bytes => new Int32Array(bytes.buffer, bytes.byteOffset, bytes.length >> 2);

/** A 32-bit FNV-1a hash of aligned bytes, a word at a time. @param {Uint8Array} bytes */
const hash = bytes => {
  const w = words(bytes);
  let h = 0x811c9dc5;
  for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w[i], 0x01000193);
  for (let i = w.length * 4; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return h >>> 0;
};

/** Whether two runs of aligned bytes hold the same bytes. @param {Uint8Array} a @param {Uint8Array} b */
const same = (a, b) => {
  if (a.length !== b.length) return false;
  const x = words(a);
  const y = words(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  for (let i = x.length * 4; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** The typeface of `bytes` in `kit`, made on first use of their content. @param {Kit} kit @param {ArrayBuffer | Uint8Array} bytes */
function typeface(kit, bytes) {
  let made = typefaces.get(kit);
  if (made === undefined) typefaces.set(kit, (made = { given: new WeakMap(), byContent: new Map() }));
  let face = made.given.get(bytes);
  if (face !== undefined) return face;
  // Read by words: bytes at an odd offset are copied to an aligned run first.
  const view = !(bytes instanceof Uint8Array) ? new Uint8Array(bytes) : bytes.byteOffset % 4 === 0 ? bytes : bytes.slice();
  const key = `${view.byteLength}:${hash(view)}`;
  let alike = made.byContent.get(key);
  if (alike === undefined) made.byContent.set(key, (alike = []));
  face = alike.find(entry => same(entry.bytes, view))?.face;
  if (face === undefined) {
    const buffer = bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
    const fresh = kit.Typeface.MakeFreeTypeFaceFromData(/** @type {ArrayBuffer} */ (buffer));
    if (fresh === null) throw new Error('REN skia: the font could not load');
    face = fresh;
    alike.push({ bytes: view, face });
  }
  made.given.set(bytes, face);
  return face;
}

/** One typeface: CanvasKit's (shared), its file's measure, and its fonts by size. */
class Family {
  /** @param {Kit} kit @param {ArrayBuffer | Uint8Array} bytes */
  constructor(kit, bytes) {
    /** @type {Typeface} */
    this.face = typeface(kit, bytes);
    /** The measure: the same file's advances. */
    this.sfnt = new Sfnt(bytes);
    /** Its fonts by set size (`sized`), the least recently drawn first. @type {Map<number, Face>} */
    this.sizes = new Map();
  }

  /** Over FONTS sizes, deletes the least recently drawn, none drawn in `frame`. @param {number} frame */
  evict(frame) {
    for (const [size, face] of this.sizes) {
      // Least recently drawn first: from the first drawn in this frame on, all were.
      if (this.sizes.size <= FONTS || face.drawn === frame) break;
      face.close();
      this.sizes.delete(size);
    }
  }

  close() {
    // The fonts go; the typeface is shared (see typefaces) and stays.
    for (const face of this.sizes.values()) face.close();
    this.sizes.clear();
  }
}

/** Shaped text's glyphs as CanvasKit draws them: ids, places from the left edge (x, y pairs), and the width. */
class Glyphs {
  /** @param {Uint16Array} ids @param {Float32Array} places @param {number} width @param {number} size */
  constructor(ids, places, width, size) {
    this.ids = ids;
    this.places = places;
    this.width = width;
    /** The size set at (`sized`). */
    this.size = size;
  }
}

/** The glyphs drawn of each shaped text (ren-canv's Sfnt `shaped`), at the size last drawn. @type {WeakMap<object, Glyphs>} */
const drawn = new WeakMap();

/** The application typefaces at every size they are drawn in. */
export class Fonts {
  /**
   * @param {Kit} kit @param {ArrayBuffer | Uint8Array} bytes the root typeface
   * @param {(ArrayBuffer | Uint8Array | null)=} mono a monospace typeface, for text whose family names monospace
   * @param {Record<string, ArrayBuffer | Uint8Array>} [families] typefaces by family name, for text whose family names one
   * @param {(ArrayBuffer | Uint8Array)[]} [fallback] typefaces for the characters a typeface lacks, in order
   */
  constructor(kit, bytes, mono = null, families = {}, fallback = []) {
    this.kit = kit;
    this.regular = new Family(kit, bytes);
    /** @type {Family | null} */
    this.mono = mono == null ? null : new Family(kit, mono);
    const named = Object.entries(families).map(([name, source]) => /** @type {[string, Family]} */ ([name, new Family(kit, source)]));
    const backups = fallback.map(source => new Family(kit, source));
    /** The typefaces by slot, as the measure numbers them: the root one, the named ones, the fallbacks. */
    this.slots = [this.regular, ...named.map(([, family]) => family), ...backups];
    /** The measure: each character in the typeface that has it. */
    this.measure = new Faces({ font: this.regular.sfnt, mono: this.mono?.sfnt ?? null, families: Object.fromEntries(named.map(([name, family]) => [name, family.sfnt])), fallback: backups.map(family => family.sfnt) });
    /** The frame being drawn, its fonts' stamp (see FONTS). */
    this.frame = 0;
  }

  /** The typeface of a face: its slot's, else the monospace one for MONO when there is one. @param {number} flags */
  family(flags) {
    const slot = flags >>> SLOT;
    if (slot > 0 && slot < this.slots.length) return this.slots[slot];
    return (flags & MONO) !== 0 && this.mono !== null ? this.mono : this.regular;
  }

  /** The slot of the typeface a CSS font-family list names (0: the root one). @param {string} family */
  typeface(family) {
    return this.measure.typeface(family);
  }

  /** Where text in a face is set in a fallback typeface (ren-canv's Faces). @param {string} text @param {number} face */
  faces(text, face) {
    return this.measure.faces(text, face);
  }

  /** The measure of the regular typeface. */
  get sfnt() {
    return this.regular.sfnt;
  }

  /** @param {number} size @param {number} [flags] */
  at(size, flags = 0) {
    const family = this.family(flags);
    const set = family.sfnt.sized(size);
    let face = family.sizes.get(set);
    if (face === undefined) {
      face = new Face(this.make(family.face, set), this.frame);
      family.sizes.set(set, face);
    } else if (face.drawn !== this.frame) {
      // Drawn again: last in the order, once a frame.
      face.drawn = this.frame;
      family.sizes.delete(set);
      family.sizes.set(set, face);
    }
    return face;
  }

  /** At the end of a frame: over FONTS sizes a typeface, drops the least recently drawn that this frame did not draw. */
  evict() {
    for (const family of this.slots) family.evict(this.frame);
    this.mono?.evict(this.frame);
    this.frame++;
  }

  /**
   * A font at `size` drawing at the advances the text was measured with:
   * positioned to fractions of a pixel with the font's own (linear)
   * advances, as ren-canv's Sfnt measures them, so it wraps where ren-three
   * (the same measure) wraps it, and where the DOM does for text these
   * typefaces cover; slightly
   * hinted, vertically only, so its stems and x-height land on pixel rows.
   * `size` is the one the text is set at (Sfnt's `sized`: down to a 64th).
   * @param {Typeface} typeface @param {number} size
   * @returns {Font}
   */
  make(typeface, size) {
    const kit = /** @type {any} */ (this.kit);
    const font = new kit.Font(typeface, size);
    font.setHinting(kit.FontHinting.Slight);
    font.setSubpixel(true);
    font.setLinearMetrics(true);
    return font;
  }

  /**
   * The CanvasKit font at `size`, of its typeface (its slot's; MONO: the monospace one),
   * emboldened or slanted as `flags` asks (ren-canv's BOLD 1, ITALIC 2):
   * synthesized as browsers do without a bold or italic face. Advances stay
   * the regular's.
   * @param {number} size @param {number} [flags]
   */
  font(size, flags = 0) {
    const face = this.at(size, flags);
    const style = flags & 3;
    if (style === 0) return face.font;
    let styled = face.styled[style];
    if (styled === undefined) {
      const family = this.family(flags);
      styled = this.make(family.face, family.sfnt.sized(size));
      if ((style & 1) !== 0) styled.setEmbolden(true);
      if ((style & 2) !== 0) styled.setSkewX(-0.25);
      face.styled[style] = styled;
    }
    return styled;
  }

  /** The ascent and descent at `size`, both positive. @param {number} size @param {number} [flags] */
  metrics(size, flags = 0) {
    return this.measure.metrics(size, flags);
  }

  /**
   * The glyphs of shaped text in a face (`flags`: its slot, MONO, RTL: its
   * runs from the right), as the measure set them (ren-canv's Sfnt
   * `shaped`, the same glyphs and advances it measured), placed at `size`;
   * null when the text is not shaped, and drawn as its characters.
   * @param {string} text @param {number} size @param {number} [flags]
   */
  glyphs(text, size, flags = 0) {
    const sfnt = this.family(flags).sfnt;
    const shaped = sfnt.shaped(text, (flags & RTL) !== 0);
    if (shaped === null) return null;
    const set = sfnt.sized(size);
    let found = drawn.get(shaped);
    if (found === undefined || found.size !== set) {
      const scale = set / sfnt.units;
      const ids = new Uint16Array(shaped.count);
      const places = new Float32Array(shaped.count * 2);
      for (let g = 0; g < shaped.count; g++) {
        ids[g] = shaped.ids[g];
        places[g * 2] = shaped.xs[g] * scale;
        places[g * 2 + 1] = -shaped.ys[g] * scale;
      }
      found = new Glyphs(ids, places, (shaped.advance * set) / sfnt.units, set);
      drawn.set(shaped, found);
    }
    return found;
  }

  /**
   * The advance width of `text` at `size`: from the font file itself
   * (ren-canv's Sfnt), in plain JavaScript, at the size text is set at. It
   * equals what these linear-metrics CanvasKit fonts draw (their hinting is
   * vertical only), without a call into CanvasKit.
   * @param {string} text @param {number} size @param {number} [flags]
   */
  width(text, size, flags = 0) {
    return this.measure.width(text, size, flags);
  }

  close() {
    for (const family of this.slots) family.close();
    this.mono?.close();
  }
}
