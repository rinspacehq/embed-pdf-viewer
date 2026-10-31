# Rinspace EmbedPDF fork

This is the public fork of embedpdf/embed-pdf-viewer. Preserve upstream history,
licenses and notices. The reviewed starting point is v2 commit
dfb2df818065c704a0241beb0791e2fd0d55a10e (MIT), not the experimental v3 main.

Rinspace additions are the browser-only Rin plugin and minimal generic viewer
hooks. The Reader library, local persistence and account host belong to
rinspacehq/rinspace-web. Backend identity, model credentials, authoritative
billing, product integration and deployment belong to rinspacehq/rinspace.

Keep model keys, cookies, private configuration, user documents and billing
records out of this tree. Do not copy AGPL editor source into MIT plugin code.
Upstream is fetch-only. Check both remote URLs before remote operations.
Use a named branch and preserve unrelated work. Build only the affected viewer
and run one worker at a time in the maintainer workspace.

Public contributions need isolated checks without production credentials.
Product consumption requires a reviewed immutable release and exact integrity;
creating this fork does not activate it in production. In the maintainer
workspace also read /home/ubuntu/WORKSPACE.md and /home/ubuntu/AGENTS.md.
