// SPDX-License-Identifier: MIT
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';

export interface HttpRangeSource {
  url: string;
  bytes: number;
  etag: string;
  headers?: Record<string, string>;
}

const chunkSize = 128 * 1024;
const maxChunks = 20;
const fileAccessBytes = 12;

export function openHttpRangeFile(
  { pdfium }: WrappedPdfiumModule,
  source: HttpRangeSource,
  onError: (status: number) => void,
): { pointer: number; dispose(): void } {
  // PDFium's file access callback is synchronous. This transport runs only in
  // the dedicated Reader worker, which the caller terminates on close.
  if (typeof document !== 'undefined') throw new Error('PDF byte ranges require a worker');
  const url = new URL(source.url);
  const { bytes, etag } = source;
  if (
    url.origin !== self.location.origin || url.username || url.password || url.hash ||
    !/^https?:$/.test(url.protocol) ||
    !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 0xffffffff ||
    !/^"[\x21\x23-\x7e]+"$/.test(etag)
  ) throw new Error('Invalid PDF byte-range source');

  const headers = new Headers(source.headers);
  headers.set('Accept', 'application/pdf');
  headers.set('If-Match', etag);
  const chunks = new Map<number, Uint8Array>();
  let failed = false;
  let disposed = false;
  const fail = (status: number) => {
    if (!failed) {
      failed = true;
      chunks.clear();
      onError(status);
    }
    return 0;
  };

  function readChunk(start: number): Uint8Array | null {
    const cached = chunks.get(start);
    if (cached) {
      chunks.delete(start);
      chunks.set(start, cached);
      return cached;
    }

    const end = Math.min(start + chunkSize, bytes) - 1;
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url.href, false);
    xhr.timeout = 15_000;
    xhr.responseType = 'arraybuffer';
    headers.forEach((value, key) => {
      if (key !== 'range') xhr.setRequestHeader(key, value);
    });
    xhr.setRequestHeader('Range', `bytes=${start}-${end}`);
    xhr.send(null);

    if (
      xhr.status !== 206 || xhr.responseURL !== url.href ||
      xhr.getResponseHeader('ETag') !== etag ||
      xhr.getResponseHeader('Content-Range') !== `bytes ${start}-${end}/${bytes}` ||
      xhr.response?.byteLength !== end - start + 1
    ) {
      fail(xhr.status === 206 ? 0 : xhr.status);
      return null;
    }
    const data = new Uint8Array(xhr.response);
    chunks.set(start, data);
    if (chunks.size > maxChunks) {
      const oldest = chunks.keys().next();
      if (!oldest.done) chunks.delete(oldest.value);
    }
    return data;
  }

  const callback = pdfium.addFunction(
    (_param: number, rawPosition: number, rawDestination: number, rawSize: number) => {
      if (failed || disposed) return 0;
      const position = rawPosition >>> 0;
      const destination = rawDestination >>> 0;
      const size = rawSize >>> 0;
      if (position + size > bytes || destination + size > pdfium.HEAPU8.length) return fail(0);
      try {
        let supplied = 0;
        while (supplied < size) {
          const offset = position + supplied;
          const start = Math.floor(offset / chunkSize) * chunkSize;
          const chunk = readChunk(start);
          if (!chunk) return 0;
          const skip = offset - start;
          const piece = chunk.subarray(skip, skip + size - supplied);
          pdfium.HEAPU8.set(piece, destination + supplied);
          supplied += piece.length;
        }
        return 1;
      } catch {
        return fail(0);
      }
    },
    'iiiii',
  );
  const pointer = pdfium._malloc(fileAccessBytes);
  if (!pointer) {
    pdfium.removeFunction(callback);
    throw new Error('Unable to allocate PDFium file access');
  }

  // wasm32 FPDF_FILEACCESS: byte length, m_GetBlock function, m_Param.
  pdfium.setValue(pointer, bytes, 'i32');
  pdfium.setValue(pointer + 4, callback, 'i32');
  pdfium.setValue(pointer + 8, 0, 'i32');
  return {
    pointer,
    dispose() {
      if (disposed) return;
      disposed = true;
      chunks.clear();
      pdfium.removeFunction(callback);
      pdfium._free(pointer);
    },
  };
}
