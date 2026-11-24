// SPDX-License-Identifier: MIT
import { PdfEngine, browserImageDataToBlobConverter } from '@embedpdf/engines/pdfium';
import { PdfErrorCode, Task } from '@embedpdf/models';
import { RemoteExecutor } from '../../../packages/engines/src/lib/orchestrator/remote-executor.ts';

export function createReaderRangedEngine(wasmUrl, source, onError) {
  const { url: input, ...metadata } = source;
  const url = new URL(input, window.location.href);
  if (url.origin !== window.location.origin || url.username || url.password || url.hash) {
    throw new Error('PDF range source must be same-origin');
  }
  const worker = new Worker(new URL('./reader-range-worker.js', import.meta.url), { type: 'module' });
  const executor = new RemoteExecutor(worker, { wasmUrl, fontFallback: null });
  const engine = new PdfEngine(executor, { imageConverter: browserImageDataToBlobConverter });
  const fixedSource = { ...metadata, url: url.href };
  engine.openDocumentUrl = (file, options) => {
    if (file.url !== url.href) {
      const task = new Task();
      task.reject({ code: PdfErrorCode.NotSupport, message: 'Unexpected PDF range source' });
      return task;
    }
    return executor.openDocumentRange(file.id, fixedSource, options ?? {}, onError);
  };
  return engine;
}
