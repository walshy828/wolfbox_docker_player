import type { ByteReader } from './reader.ts';

export interface Box {
  type: string;
  /** Absolute offset of the box header. */
  offset: number;
  /** Total box size including the header. */
  size: number;
  /** Header length: 8, or 16 for 64-bit sizes. */
  headerSize: number;
}

export interface Track {
  handler: string;
  /** Sample-entry fourcc from `stsd`, e.g. `hvc1`, `mp4a`, `gpmd`. */
  format: string;
  timescale: number;
  duration: number;
  /** Present for visual tracks. */
  width?: number;
  height?: number;
  /** Absolute file offset and byte length of every sample, in decode order. */
  samples: { offset: number; size: number }[];
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta']);

function fourcc(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
}

/**
 * Walks the top-level box list, skipping `mdat` by its declared size, and
 * returns the `moov` box. WolfBox files put `moov` at the end of the file, so
 * this costs two small reads rather than a scan.
 */
export async function findMoov(reader: ByteReader): Promise<Box | null> {
  let offset = 0;
  while (offset < reader.size) {
    const head = await reader.read(offset, 16);
    if (head.length < 8) return null;
    const view = new DataView(head.buffer, head.byteOffset, head.length);
    let size = view.getUint32(0);
    const type = fourcc(head, 4);
    let headerSize = 8;
    if (size === 1) {
      if (head.length < 16) return null;
      size = Number(view.getBigUint64(8));
      headerSize = 16;
    } else if (size === 0) {
      size = reader.size - offset;
    }
    if (size < headerSize) return null;
    if (type === 'moov') return { type, offset, size, headerSize };
    offset += size;
  }
  return null;
}

/** Parses the children of an in-memory container box. */
function children(buf: Uint8Array, start: number, end: number): Box[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: Box[] = [];
  let o = start;
  while (o + 8 <= end) {
    let size = view.getUint32(o);
    const type = fourcc(buf, o + 4);
    let headerSize = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(o + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < headerSize || o + size > end) break;
    out.push({ type, offset: o, size, headerSize });
    o += size;
  }
  return out;
}

/** Depth-first walk of a container, yielding every descendant box. */
function walk(buf: Uint8Array, box: Box, visit: (b: Box, path: string[]) => void, path: string[] = []) {
  for (const child of children(buf, box.offset + box.headerSize, box.offset + box.size)) {
    visit(child, path);
    if (CONTAINERS.has(child.type)) walk(buf, child, visit, [...path, child.type]);
  }
}

/**
 * Maps samples to absolute file offsets using stsc/stsz/stco, per ISO/IEC 14496-12.
 * The gpmd track stores one sample per chunk, but the general path is cheap.
 */
function sampleOffsets(
  stsc: DataView, stsz: DataView, chunkOffsets: number[],
): { offset: number; size: number }[] {
  const sampleCount = stsz.getUint32(16);
  const uniformSize = stsz.getUint32(12);
  const sizeAt = (i: number) => {
    if (uniformSize !== 0) return uniformSize;
    const at = 20 + 4 * i;
    return at + 4 <= stsz.byteLength ? stsz.getUint32(at) : 0;
  };

  // stsc is run-length encoded: each entry starts a run of chunks that share a
  // samples-per-chunk value, running until the next entry's first_chunk.
  // Layout: size(4) type(4) version+flags(4) entry_count(4), then 12-byte entries.
  const runCount = stsc.getUint32(12);
  const runs: { firstChunk: number; samplesPerChunk: number }[] = [];
  for (let i = 0; i < runCount; i++) {
    const entry = 16 + 12 * i;
    if (entry + 8 > stsc.byteLength) break;
    runs.push({
      firstChunk: stsc.getUint32(entry),
      samplesPerChunk: stsc.getUint32(entry + 4),
    });
  }

  const out: { offset: number; size: number }[] = [];
  let sample = 0;
  for (let run = 0; run < runs.length && sample < sampleCount; run++) {
    const { firstChunk, samplesPerChunk } = runs[run]!;
    const lastChunk = run + 1 < runs.length ? runs[run + 1]!.firstChunk - 1 : chunkOffsets.length;
    for (let chunk = firstChunk; chunk <= lastChunk && sample < sampleCount; chunk++) {
      let offset = chunkOffsets[chunk - 1];
      if (offset === undefined) return out;
      for (let n = 0; n < samplesPerChunk && sample < sampleCount; n++) {
        const size = sizeAt(sample);
        out.push({ offset, size });
        offset += size;
        sample++;
      }
    }
  }
  return out;
}

/** Reads `moov` and returns every track with its sample table resolved. */
export async function parseTracks(reader: ByteReader): Promise<Track[]> {
  const moov = await findMoov(reader);
  if (!moov) return [];
  const buf = await reader.read(moov.offset, moov.size);
  // Re-base the box to the start of the buffer we just read.
  const root: Box = { ...moov, offset: 0 };
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sub = (b: Box) => new DataView(buf.buffer, buf.byteOffset + b.offset, b.size);

  const tracks: Track[] = [];
  let current: Partial<Track> & { stsc?: DataView; stsz?: DataView; chunks?: number[] } = {};

  const flush = () => {
    if (current.format && current.stsc && current.stsz && current.chunks) {
      tracks.push({
        handler: current.handler ?? '',
        format: current.format,
        timescale: current.timescale ?? 0,
        duration: current.duration ?? 0,
        width: current.width,
        height: current.height,
        samples: sampleOffsets(current.stsc, current.stsz, current.chunks),
      });
    }
    current = {};
  };

  walk(buf, root, (box) => {
    switch (box.type) {
      case 'trak':
        flush();
        break;
      case 'mdhd': {
        const d = sub(box);
        const version = d.getUint8(8);
        if (version === 1) {
          current.timescale = d.getUint32(28);
          current.duration = Number(d.getBigUint64(32));
        } else {
          current.timescale = d.getUint32(20);
          current.duration = d.getUint32(24);
        }
        break;
      }
      case 'hdlr':
        current.handler = fourcc(buf, box.offset + 16);
        break;
      case 'stsd': {
        current.format = fourcc(buf, box.offset + 20);
        // VisualSampleEntry: width/height sit 32 bytes into the sample entry.
        // Only visual entries have them; `hdlr` is parsed before `stsd`.
        const entry = box.offset + 16;
        if (current.handler === 'vide' && box.size >= 16 + 36) {
          current.width = view.getUint16(entry + 32);
          current.height = view.getUint16(entry + 34);
        }
        break;
      }
      case 'stsc':
        current.stsc = sub(box);
        break;
      case 'stsz':
        current.stsz = sub(box);
        break;
      case 'stco': {
        const d = sub(box);
        const n = d.getUint32(12);
        const chunks: number[] = [];
        for (let i = 0; i < n; i++) chunks.push(d.getUint32(16 + 4 * i));
        current.chunks = chunks;
        break;
      }
      case 'co64': {
        const d = sub(box);
        const n = d.getUint32(12);
        const chunks: number[] = [];
        for (let i = 0; i < n; i++) chunks.push(Number(d.getBigUint64(16 + 8 * i)));
        current.chunks = chunks;
        break;
      }
    }
  });
  flush();
  return tracks;
}
