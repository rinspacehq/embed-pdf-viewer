// SPDX-License-Identifier: MIT
import { h, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { RinRenderedLesson, RinVoiceControls, RinDocumentTools } from './types';
import { mountRinLesson } from './lesson';
import { narrationMatchesLesson } from './narration';
import { Button } from '@/components/ui/button';

export function RinLessonContent({ lesson, voice, tools, disabled }: { lesson: RinRenderedLesson; voice?: RinVoiceControls; tools?: RinDocumentTools; disabled?: boolean }) {
  const target = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [playError, setPlayError] = useState('');
  const [ready, setReady] = useState('');
  const owner = useRef(voice); owner.current = voice;
  const playback = voice?.snapshot().playback;
  const relevant = narrationMatchesLesson(playback?.source, lesson);
  const resumable = narrationMatchesLesson(playback?.resumeSource, lesson);
  const playing = relevant && ['loading', 'playing', 'stopping'].includes(playback?.state || '');
  useEffect(() => {
    if (!target.current) return;
    const controller = new AbortController();
    setError(''); setPlayError(''); setReady('');
    void mountRinLesson(target.current, lesson, controller.signal).then(() => { if (!controller.signal.aborted) setReady(lesson.resultHash); }).catch(error => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '排版暂不可用。');
    });
    return () => controller.abort();
  }, [lesson]);
  useEffect(() => {
    if (!relevant || !playback?.follow || playback.state !== 'playing' || ready !== lesson.resultHash) return;
    const step = lesson.view.steps.find(step => step.id === playback.source?.stepId);
    if (!step) return;
    const element = target.current?.shadowRoot?.getElementById(`fragment-${step.id}`);
    element?.setAttribute('aria-current', 'step'); element?.scrollIntoView({ block: 'nearest' });
    const page = voice?.evidencePages?.(step.evidenceRefs)[0];
    if (page && tools && tools.info().currentPage !== page) tools.navigate(page);
    return () => element?.removeAttribute('aria-current');
  }, [relevant, playback?.follow, playback?.state, playback?.source?.stepId, ready, lesson, voice, tools]);
  const sources = lesson.view.steps.flatMap(step => step.narration.map((_, narrationIndex) => ({ operationId: lesson.operationId, stepId: step.id, narrationIndex, lessonResultHash: lesson.resultHash })));
  const run = (operation: () => Promise<void>) => {
    setPlayError('');
    void operation().catch(problem => { if (owner.current === voice) setPlayError(problem instanceof Error ? problem.message : '朗读暂时不可用。'); });
  };
  return <>
    {voice?.play && voice.stopPlayback && sources.length > 0 && <div className="mb-2 flex flex-wrap items-center gap-1">
      <Button type="button" disabled={playing ? playback?.state === 'stopping' : disabled || !voice.available() || !['idle', 'error'].includes(voice.snapshot().input)}
        onClick={() => run(() => playing ? voice.stopPlayback!() : voice.play!(sources))}>{playing ? '停止朗读' : resumable ? '继续朗读' : '朗读'}</Button>
      {relevant && playback && voice.setFollow && <Button type="button" aria-pressed={playback.follow} onClick={() => voice.setFollow!(!playback.follow)}>跟随</Button>}
      {relevant && playback?.expired && <Button type="button" disabled={disabled || !voice.available()} onClick={() => run(() => voice.play!(sources, true))}>重新朗读</Button>}
      {(playError || relevant && playback?.error) && <span role="alert" className="text-xs text-fg-secondary">{playError || playback?.error}</span>}
    </div>}
    <div ref={target} className="min-w-0 text-sm" data-rin-operation-id={lesson.operationId} data-rin-result-hash={lesson.resultHash} />{error && <p role="alert" className="text-sm">{error}</p>}
  </>;
}
