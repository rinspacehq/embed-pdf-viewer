// SPDX-License-Identifier: MIT
import type { PdfEngine } from '@embedpdf/models';
import type { ReaderRangeSource } from './reader-api';

export function createReaderRangedEngine(
  wasmUrl: string,
  source: ReaderRangeSource,
  onError: (status: number) => void,
): PdfEngine<Blob>;
