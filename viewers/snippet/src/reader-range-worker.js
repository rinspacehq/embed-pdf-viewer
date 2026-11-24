// SPDX-License-Identifier: MIT
import { PdfErrorCode } from '@embedpdf/models';
import { PdfiumEngineRunner } from '../../../packages/engines/src/lib/pdfium/runner.ts';

self.onmessage = async ({ data }) => {
  if (data.type !== 'wasmInit') return;
  try {
    const response = await fetch(data.wasmUrl);
    if (!response.ok) throw new Error('PDFium unavailable');
    const runner = new PdfiumEngineRunner(await response.arrayBuffer());
    await runner.prepare();
  } catch {
    self.postMessage({
      id: data.id, type: 'error',
      error: { type: 'reject', reason: { code: PdfErrorCode.Initialization, message: 'PDFium initialization failed' } },
    });
  }
};
