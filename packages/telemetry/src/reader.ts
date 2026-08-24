/**
 * Random-access byte source. Everything in this package reads through this
 * interface so the same parser runs against a browser `File` (File System
 * Access API) and a Node file descriptor.
 */
export interface ByteReader {
  /** Total size of the underlying resource, in bytes. */
  readonly size: number;
  /** Read `length` bytes starting at `offset`. May return fewer at EOF. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** Wraps a browser `File`/`Blob`. Slicing a File does not load it into memory. */
export function blobReader(blob: Blob): ByteReader {
  return {
    size: blob.size,
    async read(offset, length) {
      const end = Math.min(offset + length, blob.size);
      if (end <= offset) return new Uint8Array(0);
      return new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    },
  };
}
