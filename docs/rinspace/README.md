# Rinspace integration

Rinspace maintains EmbedPDF v2 and adds an optional browser-only Rin assistant
plugin. The original viewer remains usable without a Rinspace account.

The host supplies account status and a bounded agent transport; this project
never receives provider keys. The host owns local file persistence and the
Reader library. The service owns authorization, policy and billing.

The baseline is upstream commit dfb2df818065c704a0241beb0791e2fd0d55a10e.
Existing code retains its original MIT and third-party notices. Newly authored
Rin plugin code is MIT. No TeXlyre implementation source is copied here.

The snippet uses exact published 2.15.1 upstream packages, allowing a scoped
build without compiling every framework example or the PDFium engine. Run
`npm ci --prefix viewers/snippet --ignore-scripts --workspaces=false`, then
`npm run build --prefix viewers/snippet`. The package lock is part of the input.
Release metadata must identify this fork's exact commit and artifact digest.

Serve `viewers/snippet/dist` over loopback HTTP and open `/reader-example.html`
for the local-file example. It has no account, secrets or paid model connection.
The maintainer browser test is `node scripts/rinspace/browser-smoke.mjs`, with
`PLAYWRIGHT_MODULE` pointing to the snippet's installed Playwright and
`READER_EVIDENCE_DIR` pointing outside the source tree.

The framework-neutral Reader integration uses the runtime `initReader` export
and types from `@rinspacehq/embedpdf-snippet/dist/reader-api`. It reports view
changes and document readiness to the host; it does not persist files or choose
an account system. Destroy the returned handle on navigation. Assets (including
PDFium) must be served from the same origin and the exact package version.
The normal EmbedPDF `init` API remains available for other integrations.

Rin tools read at most eight pages and 16000 characters per request, expose
selected text and page navigation, and cannot write files or execute code.
Session changes clear plugin memory; the host must namespace persisted state
by account and document version. The host owns request idempotency, recovery,
consent and authoritative billing. Displayed debit is an actual wallet debit,
not a provider cost estimate. The plugin never handles credentials.

The scoped GitHub workflow runs only the snippet build, license coverage and
browser checks, then uploads a SHA-bound archive/manifest. It never publishes
to upstream npm or deploys a product. Promote the tested bytes to an immutable
GitHub Release after integration review; do not rebuild for promotion.
