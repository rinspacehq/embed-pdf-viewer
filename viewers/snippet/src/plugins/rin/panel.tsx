// SPDX-License-Identifier: MIT
import { h, Fragment } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { usePlugin } from '@embedpdf/core/preact';
import { UIPlugin } from '@embedpdf/plugin-ui';
import { RinPlugin } from './plugin';
import { renderRinMarkdown } from './markdown';
import { RinPictureInPicture } from './picture-in-picture';
import { RinLessonContent } from './lesson-content';
import type { RinCapability, RinConversationHistory, RinSnapshot } from './types';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Dialog } from '@/components/ui/dialog';

export function RinPanel({ documentId }: { documentId: string }) {
  const home = useRef<HTMLDivElement>(null);
  const controller = useRef<RinPictureInPicture>();
  const content = useMemo(() => {
    const element = document.createElement('div');
    element.style.cssText = 'height:100%;min-height:0';
    return element;
  }, []);
  const [supported, setSupported] = useState(false);
  const [poppedOut, setPoppedOut] = useState(false);
  const [error, setError] = useState('');
  useLayoutEffect(() => {
    if (!home.current) return;
    home.current.append(content);
    const pip = new RinPictureInPicture(home.current, content, setPoppedOut);
    controller.current = pip;
    setSupported(pip.supported);
    setPoppedOut(false);
    setError('');
    return () => { pip.dispose(); controller.current = undefined; };
  }, [content, documentId]);
  return <>
    <div ref={home} className="h-full min-h-0">
      {poppedOut && <div className="flex h-full items-center justify-center p-3">
        <Button onClick={() => controller.current?.close()}>返回侧栏</Button>
      </div>}
    </div>
    {createPortal(<RinPanelContent documentId={documentId} pipSupported={supported} poppedOut={poppedOut} pipError={error}
      openPiP={() => { setError(''); void controller.current?.open().catch(() => setError('无法打开画中画，请重试。')); }}
      closePiP={() => controller.current?.close()} />, content)}
  </>;
}

function RinPanelContent({ documentId, pipSupported, poppedOut, pipError, openPiP, closePiP }: {
  documentId: string;
  pipSupported: boolean;
  poppedOut: boolean;
  pipError: string;
  openPiP(): void;
  closePiP(): void;
}) {
  const { plugin } = usePlugin<RinPlugin>('rin');
  const { plugin: ui } = usePlugin<UIPlugin>('ui');
  const capability = plugin?.provides();
  const [, refresh] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const follows = useRef(true);
  const accountId = capability?.session().accountId;
  useEffect(() => capability?.subscribe(() => refresh(value => value + 1)), [capability]);
  useLayoutEffect(() => {
    const viewport = scroll.current, content = transcript.current;
    if (!viewport || !content) return;
    follows.current = true;
    const observer = new ResizeObserver(() => { if (follows.current) viewport.scrollTop = viewport.scrollHeight; });
    observer.observe(content);
    return () => observer.disconnect();
  }, [documentId, accountId, capability]);
  if (!capability) return null;
  const record = capability.snapshot(documentId);
  const session = capability.session();
  return <section className="flex h-full min-h-0 flex-col text-fg-primary" aria-label="琳">
    <div className="border-border-default flex items-center justify-between border-b p-3 font-semibold"><span>琳</span>
      <div className="flex gap-1">
        <RinDelete documentId={documentId} capability={capability} pending={record.deletionPending}
          cloud={Boolean(record.deletionPending || capability.canCheck(documentId) || record.messages.some(message => message.lesson))} />
        {capability.canStartConversation(documentId) && <Button type="button" aria-label="新对话" tooltip="新对话" onClick={() => { void capability.newConversation(documentId); }}><Icon icon="plus" size={18} /></Button>}
        {pipSupported && !poppedOut && <Button type="button" aria-label="画中画" tooltip="画中画" onClick={openPiP}><Icon icon="externalLink" size={18} /></Button>}
        <Button type="button" aria-label={poppedOut ? '返回侧栏' : '收起琳'} tooltip={poppedOut ? '返回侧栏' : '收起琳'}
          onClick={() => poppedOut ? closePiP() : ui?.provides().forDocument(documentId).closeSidebarSlot('right', 'main')}><Icon icon={poppedOut ? 'arrowBackUp' : 'x'} size={18} /></Button>
      </div>
    </div>
    <div ref={scroll} className="min-h-0 flex-1 overflow-auto p-3" aria-live="polite" onScroll={event => {
      const target = event.currentTarget; follows.current = target.scrollHeight - target.scrollTop - target.clientHeight < 72;
    }}><div ref={transcript}>
      {capability.history(documentId).length > 0 && <details className="mb-4 text-sm">
        <summary className="cursor-pointer text-fg-secondary" onClick={() => { follows.current = false; }}>以往对话</summary>
        {capability.history(documentId).map(item => <RinHistory key={`${session.accountId}:${item.id}`} documentId={documentId} item={item} capability={capability} />)}
      </details>}
      {record.messages.map((message, index) => <article key={index} className="mb-4">
        <div className="mb-1 text-xs text-fg-secondary">{message.role === 'user' ? '你' : '琳'}</div>
        {message.role === 'assistant'
          ? message.lesson ? <RinLessonContent lesson={message.lesson} voice={capability.voice(documentId)} tools={capability.tools(documentId)} disabled={record.running || record.recoverable} />
            : <div className="rin-markdown select-text break-words text-sm" dangerouslySetInnerHTML={{ __html: renderRinMarkdown(message.text) }} />
          : <div className="select-text whitespace-pre-wrap break-words text-sm">{message.text}</div>}
        {message.lesson && capability.canCheck(documentId) && <div className="mt-2 flex flex-wrap gap-2">
          {message.lesson.view.steps.filter(step => step.checkId).map((step, questionIndex, questions) => <div key={step.checkId} className="flex flex-wrap gap-1" role="group" aria-label={questions.length > 1 ? `第 ${questionIndex + 1} 题` : '练习操作'}>
            <Button type="button" disabled={record.running || record.recoverable} onClick={() => capability.selectCheck(documentId, { kind: 'attempt', checkId: step.checkId! })}>{questions.length > 1 ? `回答第 ${questionIndex + 1} 题` : '作答'}</Button>
            <Button type="button" disabled={record.running || record.recoverable || !capability.canHint(documentId,step.checkId!)} onClick={() => { follows.current = true; void capability.check(documentId, { kind: 'hint', checkId: step.checkId! }); }}>提示</Button>
            <Button type="button" disabled={record.running || record.recoverable} onClick={() => { follows.current = true; void capability.check(documentId, { kind: 'reveal', checkId: step.checkId! }); }}>看答案</Button>
            <Button type="button" disabled={record.running || record.recoverable} onClick={() => { follows.current = true; void capability.check(documentId, { kind: 'skip', checkId: step.checkId! }); }}>跳过</Button>
          </div>)}
          {message.lesson.view.assessment && <div className="flex flex-wrap items-center gap-2 text-xs text-fg-secondary">
            <span>琳的判断：{({ correct: '正确', 'partially-correct': '部分正确', incorrect: '需要修改', uncertain: '暂不能确认' })[message.lesson.view.assessment.verdict]}</span>
            {message.lesson.view.assessment.assisted && <span>已使用帮助</span>}
            <Button type="button" disabled={record.running || record.recoverable} onClick={() => capability.selectCheck(documentId, { kind: 'challenge', checkId: message.lesson!.view.assessment!.checkId })}>质疑反馈</Button>
          </div>}
        </div>}
        {message.pages?.map(page => <button key={page} type="button" className="mr-2 mt-2 rounded border px-2 py-1 text-xs" onClick={() => capability.tools(documentId).navigate(page)}>第 {page} 页</button>)}
      </article>)}
      {record.running && <p role="status" className="text-sm text-fg-secondary">正在阅读…</p>}
      {record.error && <p role="alert" className="mt-2 text-sm">{record.error}</p>}
      {pipError && <p role="alert" className="mt-2 text-sm">{pipError}</p>}
    </div></div>
    <form className="border-border-default border-t p-3" onSubmit={event => { event.preventDefault(); follows.current = true; void capability.send(documentId); }}>
      {record.draftAction && <div className="mb-2 flex items-center justify-between text-xs text-fg-secondary">
        <span>{record.draftAction.kind === 'challenge' ? '质疑反馈' : '作答'}</span>
        <Button type="button" aria-label="取消作答模式" onClick={() => capability.selectCheck(documentId)}><Icon icon="x" size={14} /></Button>
      </div>}
      {record.regions?.length ? <div className="mb-2 flex flex-wrap gap-1">{record.regions.map(region =>
        <span key={region.id} className="border-border-default inline-flex items-center gap-1 rounded border px-2 py-1 text-xs">
          第 {region.page} 页区域
          <Button type="button" aria-label={`移除第 ${region.page} 页区域`} disabled={record.running} onClick={() => capability.removeRegion(documentId, region.id)}><Icon icon="x" size={12} /></Button>
        </span>)}</div> : null}
      <textarea className="border-border-default bg-bg-surface w-full resize-none rounded border p-2 text-sm" rows={3} maxLength={8000} aria-label="发给琳的消息" disabled={record.deletionPending} value={record.draft} onInput={event => capability.draft(documentId, event.currentTarget.value)} />
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
        {capability.canCaptureRegion(documentId) && <Button type="button" aria-label="引用原文区域" tooltip="引用原文区域" disabled={record.running || record.deletionPending}
          onClick={() => { if (poppedOut) closePiP(); requestAnimationFrame(() => capability.beginRegionCapture(documentId)); }}><Icon icon="screenshot" size={16} /></Button>}
        <RinVoiceInput documentId={documentId} capability={capability} />
        {record.costSG !== undefined && <details className="text-xs text-fg-secondary"><summary>实扣 {Number(record.costSG.toFixed(6))} 善功</summary>
          {record.usage && <p className="mt-2">输入 {record.usage.inputTokens} token · 输出 {record.usage.outputTokens} token</p>}
        </details>}</div>
        <div className="flex gap-2">
          {(record.running || record.recoverable) && <Button type="button" onClick={() => { void capability.stop(documentId); }}>停止</Button>}
          {!record.running && <Button disabled={record.deletionPending || !capability.ready(documentId) || session.status === 'loading' || !record.draft.trim() && !record.pendingRequest} type="submit">{session.status === 'anonymous' ? '登录' : record.recoverable ? '继续' : record.draftAction ? record.draftAction.kind === 'challenge' ? '提交质疑' : '提交作答' : '发送'}</Button>}
        </div>
      </div>
    </form>
  </section>;
}

function RinVoiceInput({ documentId, capability }: { documentId: string; capability: RinCapability }) {
  const voice = capability.voice(documentId);
  const account = capability.session().accountId;
  const snapshot = voice?.snapshot();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const committing = useRef(false);
  const owner = useRef(voice); owner.current = voice;
  useEffect(() => { setText(snapshot?.transcript || ''); setError(''); }, [voice, snapshot?.transcript]);
  if (!voice || !snapshot || !voice.available() && snapshot.input === 'idle') return null;
  const run = (operation: () => Promise<void>) => {
    setError('');
    void operation().catch(problem => { if (owner.current === voice) setError(problem instanceof Error ? problem.message : '语音暂时不可用。'); });
  };
  const close = () => { if (!committing.current) run(() => voice.dismissTranscript()); };
  const label = snapshot.input === 'listening' ? '结束语音' : snapshot.input === 'starting' ? '启动语音…' :
    snapshot.input === 'transcribing' ? '取消语音' : snapshot.input === 'stopping' ? '正在停止…' : snapshot.cleanupPending ? '确认停止' : '语音';
  return <>
    <div className="flex items-center gap-1">
      <Button type="button" aria-label={label} disabled={['starting', 'stopping', 'review'].includes(snapshot.input) || !voice.available() && snapshot.input === 'idle'}
        onClick={() => run(() => snapshot.input === 'listening' ? voice.finishInput() : snapshot.input === 'transcribing' || snapshot.cleanupPending ? voice.cancelInput() : voice.startInput())}>{label}</Button>
      {['starting', 'listening'].includes(snapshot.input) && <Button type="button" aria-label="取消语音" tooltip="取消语音" onClick={() => run(() => voice.cancelInput())}><Icon icon="x" size={14} /></Button>}
      {(snapshot.error || error) && <span role="alert" className="text-xs text-fg-secondary">{error || snapshot.error}</span>}
    </div>
    <Dialog open={snapshot.input === 'review'} onClose={close} title={snapshot.limitReached ? '录满一段，请确认文字' : '确认文字'}
      className="w-[min(30rem,calc(100vw-2rem))] max-w-full">
      <div className="space-y-4 p-6 text-sm font-normal">
        <textarea className="border-border-default bg-bg-surface w-full resize-y rounded border p-2 text-sm" rows={5} maxLength={8000} aria-label="语音文字" value={text} disabled={busy} onInput={event => setText(event.currentTarget.value)} />
        {error && <p role="alert" className="text-sm">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" disabled={busy} onClick={close}>取消</Button>
          <Button type="button" disabled={busy || !text.trim()} onClick={() => {
            if (committing.current || capability.session().accountId !== account || capability.voice(documentId) !== voice) return;
            committing.current = true; setBusy(true); setError('');
            void capability.confirmVoiceTranscript(documentId, text).catch(problem => {
              if (owner.current === voice) setError(problem instanceof Error ? problem.message : '结果待确认，请重试。');
            }).finally(() => { committing.current = false; if (owner.current === voice) setBusy(false); });
          }}>加入消息</Button>
        </div>
      </div>
    </Dialog>
  </>;
}

function RinHistory({ documentId, item, capability }: { documentId: string; item: RinConversationHistory; capability: RinCapability }) {
  const [snapshot, setSnapshot] = useState<RinSnapshot>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  useEffect(() => () => { active.current = false; }, []);
  useEffect(() => { if (item.deleting) setSnapshot(undefined); }, [item.deleting]);
  return <details className="mt-3" onToggle={event => {
    if (!event.currentTarget.open || snapshot || busy || item.deleting) return;
    setBusy(true); setError('');
    void capability.readHistory(documentId, item.id).then(value => { if (active.current) setSnapshot(value); })
      .catch(() => { if (active.current) setError('无法读取这段对话。'); })
      .finally(() => { if (active.current) setBusy(false); });
  }}>
    <summary className="cursor-pointer break-words">{item.title}</summary>
    <div className="mt-1 flex justify-end"><RinDelete documentId={documentId} conversationId={item.id} capability={capability} pending={item.deleting} cloud={item.cloud !== false} /></div>
    {busy && <p role="status">正在读取…</p>}
    {error && <p role="alert">{error}</p>}
    {!item.deleting && snapshot?.messages.map((message, index) => <article key={index} className="mt-3">
      <div className="mb-1 text-xs text-fg-secondary">{message.role === 'user' ? '你' : '琳'}</div>
      {message.role === 'assistant' ? message.lesson ? <RinLessonContent lesson={message.lesson} /> :
        <div className="rin-markdown select-text break-words" dangerouslySetInnerHTML={{ __html: renderRinMarkdown(message.text) }} /> :
        <div className="select-text whitespace-pre-wrap break-words">{message.text}</div>}
    </article>)}
    {!item.deleting && snapshot?.draft && <div className="mt-3"><div className="mb-1 text-xs text-fg-secondary">草稿</div><p className="select-text whitespace-pre-wrap break-words">{snapshot.draft}</p></div>}
  </details>;
}

function RinDelete({ documentId, conversationId, capability, pending, cloud }: {
  documentId: string; conversationId?: string; capability: RinCapability; pending?: boolean; cloud: boolean;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = useRef(true), identity = useRef(capability.session().accountId);
  identity.current = capability.session().accountId;
  useEffect(() => () => { active.current = false; }, []);
  useEffect(() => { setOpen(false); setError(''); setBusy(false); }, [documentId, identity.current]);
  const allowed = capability.canDeleteConversation(documentId, conversationId);
  if (!allowed && !open) return null;
  const label = pending ? '确认删除结果' : '删除对话';
  return <>
    <Button type="button" aria-label={label} tooltip={label} disabled={!allowed || busy} onClick={() => { setError(''); setOpen(true); }}><Icon icon="trash" size={18} /></Button>
    <Dialog open={open} title={pending ? '确认删除结果' : '删除这段对话？'} onClose={() => { if (!busy) setOpen(false); }}>
      <div className="p-6 text-sm font-normal">
        <p>{cloud ? '删除本地和云端学习内容，保留 PDF 与账务记录。' : '删除本地对话记录，保留 PDF 与账务记录。'}</p>
        {error && <p role="alert" className="mt-3">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" disabled={busy} onClick={() => setOpen(false)}>取消</Button>
          <Button type="button" disabled={busy || !allowed} onClick={() => {
            if (busy) return;
            const account = identity.current; setBusy(true); setError('');
            void capability.deleteConversation(documentId, conversationId)
              .then(() => { if (active.current && account === identity.current) setOpen(false); })
              .catch(reason => { if (active.current && account === identity.current) setError(reason instanceof Error ? reason.message : '删除结果待确认，请重试。'); })
              .finally(() => { if (active.current && account === identity.current) setBusy(false); });
          }}>{busy ? '正在删除…' : pending ? '确认结果' : '删除'}</Button>
        </div>
      </div>
    </Dialog>
  </>;
}
