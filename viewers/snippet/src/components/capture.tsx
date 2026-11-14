import { h, Fragment } from 'preact';
import { useCaptureCapability } from '@embedpdf/plugin-capture/preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { Dialog } from './ui/dialog';
import { Button } from './ui/button';
import { useTranslations } from '@embedpdf/plugin-i18n/preact';
import { usePlugin } from '@embedpdf/core/preact';
import { RinPlugin } from '../plugins/rin/plugin';

export interface CaptureData {
  pageIndex: number;
  rect: any;
  blob: Blob;
}

export interface CaptureProps {
  documentId: string;
}

export function Capture({ documentId }: CaptureProps) {
  const { provides: capture } = useCaptureCapability();
  const { plugin: rinPlugin } = usePlugin<RinPlugin>('rin');
  const [open, setOpen] = useState(false);
  const [captureData, setCaptureData] = useState<CaptureData | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [forRin, setForRin] = useState(false);
  const [transcription, setTranscription] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const urlRef = useRef<string | null>(null);
  const downloadLinkRef = useRef<HTMLAnchorElement>(null);
  const { translate } = useTranslations(documentId);

  const handleClose = () => {
    // Clean up object URLs
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
      setDownloadUrl(null);
    }
    setOpen(false);
    if (forRin) rinPlugin?.provides().cancelRegionCapture(documentId);
    setCaptureData(null);
    setPreviewUrl(null);
    setForRin(false);
    setTranscription('');
    setError('');
    setBusy(false);
  };

  const handleDownload = () => {
    if (!captureData || !downloadLinkRef.current) return;

    // Create download URL and trigger download
    const url = URL.createObjectURL(captureData.blob);
    setDownloadUrl(url);

    // Use the ref to trigger download
    downloadLinkRef.current.href = url;
    downloadLinkRef.current.download = `pdf-capture-page-${captureData.pageIndex + 1}.png`;
    downloadLinkRef.current.click();

    handleClose();
  };

  useEffect(() => {
    if (!capture) return;

    return capture.onCaptureArea(({ documentId: capturedDocument, pageIndex, rect, blob }) => {
      if (capturedDocument !== documentId) return;
      setCaptureData({ pageIndex, rect, blob });
      setForRin(Boolean(rinPlugin?.provides().regionCaptureActive(documentId)));
      setTranscription(''); setError(''); setBusy(false);

      // Create preview URL
      const objectUrl = URL.createObjectURL(blob);
      urlRef.current = objectUrl;
      setPreviewUrl(objectUrl);
      setOpen(true);
    });
  }, [capture, documentId, rinPlugin]);

  const handleRin = async () => {
    if (!captureData || !forRin || busy || !transcription.trim()) return;
    const rin = rinPlugin?.provides();
    if (!rin) return;
    setBusy(true); setError('');
    try {
      const bytes = await captureData.blob.arrayBuffer();
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map(value => value.toString(16).padStart(2, '0')).join('');
      await rin.confirmRegion(documentId, { page: captureData.pageIndex + 1, rect: captureData.rect, imageDigest: digest, text: transcription });
      handleClose();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : '无法加入原文区域。');
      setBusy(false);
    }
  };

  const handleImageLoad = () => {
    // Clean up the object URL after image loads
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={handleClose}
        title={translate('capture.title')}
        className="md:w-[48rem]"
      >
        <div className="space-y-6">
          <div className="flex justify-center">
            {previewUrl && (
              <img
                src={previewUrl}
                onLoad={handleImageLoad}
                alt="Captured PDF area"
                style={{
                  maxWidth: '100%',
                  maxHeight: '400px',
                  border: '1px solid #e5e7eb',
                  borderRadius: '4px',
                  display: 'block',
                }}
              />
            )}
          </div>
          {forRin && <div className="space-y-2">
            <label className="block text-sm" for="rin-region-transcription">核对或录入区域中的公式、图表文字</label>
            <textarea id="rin-region-transcription" className="border-border-default bg-bg-surface w-full resize-y rounded border p-2 text-sm"
              rows={4} maxLength={8000} value={transcription} disabled={busy} onInput={event => setTranscription(event.currentTarget.value)} />
            {error && <p role="alert" className="text-sm">{error}</p>}
          </div>}
          <div className="border-border-subtle flex justify-end space-x-3 border-t pt-4">
            <Button
              onClick={handleClose}
              className="border-border-default bg-bg-surface text-fg-secondary hover:bg-interactive-hover rounded-md border px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              {translate('capture.cancel')}
            </Button>
            <Button
              onClick={handleDownload}
              disabled={!captureData}
              className="bg-accent text-fg-on-accent hover:!bg-accent-hover flex items-center space-x-2 rounded-md border border-transparent px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              {translate('capture.download')}
            </Button>
            {forRin && <Button type="button" onClick={() => { void handleRin(); }} disabled={busy || !transcription.trim()}
              className="bg-accent text-fg-on-accent hover:!bg-accent-hover rounded-md border border-transparent px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50">
              {busy ? '正在加入…' : '加入琳'}
            </Button>}
          </div>
        </div>
      </Dialog>

      {/* Hidden download link */}
      <a ref={downloadLinkRef} style={{ display: 'none' }} href="" download="" />
    </>
  );
}
