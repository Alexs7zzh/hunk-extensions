import { lstat, open, readlink } from "node:fs/promises";

export class PlasticFileTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Plastic file exceeds ${maxBytes} bytes.`);
    this.name = "PlasticFileTooLargeError";
  }
}

/** Read exact bytes without following symlinks or trusting an earlier size check. */
export async function readPlasticFile(
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const info = await lstat(path);
  if (info.size > maxBytes) throw new PlasticFileTooLargeError(maxBytes);
  if (info.isSymbolicLink()) {
    const content = Buffer.from(await readlink(path));
    if (content.length > maxBytes) throw new PlasticFileTooLargeError(maxBytes);
    return content;
  }
  const handle = await open(path, "r");
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, maxBytes + 1 - bytes),
      );
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) return Buffer.concat(chunks, bytes);
      bytes += bytesRead;
      if (bytes > maxBytes) throw new PlasticFileTooLargeError(maxBytes);
      chunks.push(chunk.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}
