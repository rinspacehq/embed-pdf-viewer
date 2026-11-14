// SPDX-License-Identifier: MIT
import type { RinNarrationSource, RinRenderedLesson } from './types';

/** A voice cursor may control a rendered lesson only when it names the exact
 * final renderer result. An operation can be revised without changing its ID. */
export function narrationMatchesLesson(
  source: RinNarrationSource | undefined,
  lesson: Pick<RinRenderedLesson, 'operationId' | 'resultHash'>,
): boolean {
  return source?.operationId === lesson.operationId && source.lessonResultHash === lesson.resultHash;
}
