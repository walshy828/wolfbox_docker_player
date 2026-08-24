import { open } from 'node:fs/promises';
import type { ByteReader } from '../src/reader.ts';

/** ByteReader over a file on disk, for tests and CLI tools. */
export async function fileReader(path: string): Promise<ByteReader & { close(): Promise<void> }> {
  const handle = await open(path, 'r');
  const { size } = await handle.stat();
  return {
    size,
    async read(offset, length) {
      const buf = new Uint8Array(Math.max(0, Math.min(length, size - offset)));
      if (buf.length === 0) return buf;
      const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
      return buf.subarray(0, bytesRead);
    },
    close: () => handle.close(),
  };
}

/** The reference card this format was decoded from. Tests skip when absent. */
export const CARD = '/Volumes/NO NAME';
export const REFERENCE_CLIP = `${CARD}/front_norm/2026_08_01_112328_00.MP4`;
export const REFERENCE_REAR = `${CARD}/rear_norm/2026_08_01_112328_01_b.MP4`;
