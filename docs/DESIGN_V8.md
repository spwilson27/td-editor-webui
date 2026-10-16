# Raster Editor v8 — multiple editors per project (master / slave)

Builds on `DESIGN_V7.md` (tag `v0.7.3`). Protocol: `PROTOCOL.md` §12 (version 10).

## 1. Decisions (design Q&A)

| Topic | Decision |
| --- | --- |
| Self-contained editors | Every Raster Editor COMP is complete on its own (code, UI, document, TD network) and **can become the master**. There is no separate "hub" component. |
| One server per project | Only the **master** runs a web server (Web Server DAT). Slaves run none; the master routes their traffic to them in-process (Python calls, no extra sockets). |
| Becoming master | Pressing **Open in Browser** on any editor: if a live master exists in this TD process, open the browser at the master's URL with this editor's tab selected; otherwise this editor becomes master (starts the server) and opens it. On project load, the editor that was master when the project was saved resumes as master automatically (bookmarked tabs reconnect); no other editor starts a server. |
| Port | The master's `Port` parameter (default 9980). If it is taken (another app / another TD process), the master takes the next free port up to +50 and shows the URL in `Status`. Slaves' `Port` is ignored (greyed note in its help). |
| Failover | If the master is deleted, deactivated (`Active` off), or fails, **another active editor becomes master automatically on the same port** (path order); browsers reconnect with their existing retry logic and keep their tabs. No active editor left → server stops. |
| Tabs | The web UI shows one **tab per editor** in the project (label = component name, tooltip = path; live-updated on create / delete / rename / activate). Clicking a tab switches the editor; the URL hash (`#/e/<editorId>`) deep-links. Creating / deleting / renaming editors happens in TD only. Switching tabs reloads that editor's document and history from TD (only one editor's engine is live in the page at a time). |
| Layer clipboard across tabs | The in-page layer clipboard (`copyLayers` snapshot: RGBA pixels, masks, specs) is engine independent and **survives a tab switch**: copy layers in one editor, switch, paste in another (Cmd/Ctrl+V, Edit ▸ Paste). It follows the cross-document rules of `DESIGN_V7` §6: pasted layers get new ids / slots and `" copy"` names, aux references (`layer:<id>`) to layers that were not copied are dropped, TD Input layers are never copied. The new editor's TD sees ordinary new layers and surfaces. A new copy releases the previous snapshot's memory; the clipboard is page-local (not stored in TD, gone on reload). |
| Leaving an editor | Before a switch the page commits what it holds back (open scrub gesture, floating selection, crop box, Quick Mask, inline text), flushes pending document / surface / history uploads and waits (bounded) for running TOP imports / renders; editing and key handlers are blocked and a "Switching to <name>…" indicator is shown. If TD is not linked and the editor has unsent changes, a dialog offers **Wait** (stay, switch automatically once the changes were sent; clicking the current tab cancels) or **Discard & switch**. A flush that times out switches anyway with a notice; a fallback that drops unsent edits (editor deleted / deactivated / 4404) says so. |
| No editor UI inside TD | The **Web Render TOP panel is removed**. The component's viewer shows its **output TOP**. Editing happens only in an external browser (Open in Browser). Panel-only code (key forwarding, panel query, Reload UI for the panel) is removed or repurposed. |
| Identity | Each editor has a stable `editorId` (stored on the COMP). A **copied / pasted / duplicated** editor detects the copy (stored owner op id ≠ its own `id`) and takes a new `editorId`; its document is copied with it. One **project token** (held by the master, carried over on failover) authenticates all routes. |
| Upgrade all editors | A **Upgrade All Editors** pulse on every editor. It finds all raster editors in the project (v8 tag, or the v0.x signature for older ones), and for each one **older** than itself replaces the code/UI/network templates and parameter pages with its own while **preserving** the document, history, document state, inputs/outputs wiring and parameter values. **Newer** editors are skipped and listed in a warning (`Status` + a TD message). Each upgraded editor re-initialises; affected browser tabs reconnect. |
| Version | Each editor has a read-only `Version` parameter (semver of the build). |

## 2. Architecture

- **Editor session** (every editor, in its extension): the per-editor protocol state that today hangs off the Web Server DAT
  callbacks (doc, surfaces, frames, TOP requests, notices, history persistence) becomes a `Session` object with methods
  `on_ws_open/on_ws_message/on_ws_close` and `on_http(request) -> response`. It is transport-agnostic.
- **Master router** (only the master's Web Server DAT is active): serves the UI page and static routes once, and
  routes `/e/<editorId>/…` HTTP requests and WebSocket connections to the target editor's `Session`
  (`op(path).ext.RasterEditor.session`). It also serves `GET /editors` and pushes `editors` updates.
- **Registry**: editors carry the tag `rasterEditor`; discovery = scan the project for COMPs with the tag (or the
  v0.x signature) — cached and refreshed on create / destroy / rename callbacks and on a slow timer.
- **Master record**: the master path + token + port are kept on the root (`op('/').store`) so that failover and
  project reload can find them; it is validated (op exists, active, server running) before use.

## 3. Validation

`validate_td.py` drives the real page through a **temporary Web Render TOP it creates** (and destroys) pointed at the
master URL, so the existing page helpers keep working. New steps: two and three editors (tabs, independent documents and
outputs, no cross-talk), master election on Open in Browser, failover by deleting / deactivating the master with a page
connected, copy-paste of an editor (new id, same document), project-load resume, Upgrade All Editors from a newer build
over an older v0.7.x component (document preserved, version updated, newer skipped).
