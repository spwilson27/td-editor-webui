# TD ⇄ Web protocol (version 1)

One WebSocket per browser client, served by the COMP's Web Server DAT at
`ws://127.0.0.1:<Port>/ws`. Text messages are JSON; binary messages are image frames.
Both sides MUST ignore unknown JSON message types and unknown fields.

Implementations: `web/src/bridge/codec.ts` and `td/raster_editor/protocol.py`.
Shared fixtures: `docs/fixtures/*.bin` + `docs/fixtures/fixtures.json` (both test suites
decode the same bytes and assert the same fields).

## 1. Binary frame messages

Little-endian. 24-byte header followed by the payload.

| Offset | Type | Field | Notes |
| --- | --- | --- | --- |
| 0 | 4 bytes | magic | ASCII `REF1` |
| 4 | u8 | type | `1` = BASE (TD → web), `2` = COMPOSITE (web → TD) |
| 5 | u8 | flags | bit 0 `FRAME_END`: last band of this frame; other bits 0 |
| 6 | u16 | reserved | 0 |
| 8 | u32 | frameId | increments per frame per sender, wraps at 2^32 |
| 12 | u16 | docW | document width the sender believes is current |
| 14 | u16 | docH | document height |
| 16 | u16 | x | band rect, document pixels, top-left origin |
| 18 | u16 | y | |
| 20 | u16 | w | ≥ 1 |
| 22 | u16 | h | ≥ 1 |
| 24 | bytes | payload | `w*h*4` bytes RGBA8, **straight (non-premultiplied) alpha**, row-major, top row first |

Rules:

- Rect must lie inside `docW × docH`; payload length must equal `w*h*4`. Violations → the
  receiver drops the message and logs once per frameId.
- `docW/docH` different from the receiver's current document → drop silently (stale frame
  from before a resize).
- A frame is one or more bands sharing `frameId`; the last has `FRAME_END`. Bands of one
  frame never overlap. Senders keep each message ≤ 2 MB payload (split by rows).
- Receivers write each band into their buffer immediately but only *publish* (TD: mark
  the Script TOP for cook; web: mark base layer dirty for the compositor) on `FRAME_END`.
- A BASE frame replaces the base layer pixels inside its rect. A COMPOSITE frame replaces
  the output buffer inside its rect. Pixels outside all received rects are unchanged.
- Colour: sRGB 8-bit, as displayed. TD converts premultiplied⇄straight at its edge
  (`Premultiplied` parameter, default on); the web side only ever sees straight alpha.

## 2. JSON messages

All have a string field `t`.

### Web → TD

| `t` | Fields | Meaning |
| --- | --- | --- |
| `ready` | `protocol: 1`, `client: "panel" \| "external"`, `version: string`, `token: string` | first message after open. `token` is the value of the page's own `token` URL query parameter (`new URLSearchParams(location.search).get('token')`, sent verbatim; the Dev URL workflow carries it too). TD rejects a missing or wrong token with `error` and closes the socket. It is regenerated on every COMP start, so a stale tab must be reopened (Open in Browser) and a page that reconnects after a restart reads it again only on reload |
| `takeover` | — | this client wants to become the active editor |
| `requestBase` | — | resend the full base frame (e.g. after local resize handling) |
| `log` | `level: "info" \| "warn" \| "error"`, `msg: string` | forwarded console errors / `window.onerror`; TD prints to the textport, rate-limited to 20/s |

### TD → Web

| `t` | Fields | Meaning |
| --- | --- | --- |
| `hello` | `protocol: 1`, `doc: {w, h}`, `hasInput: bool`, `maxSendFps: number`, `active: bool` | reply to `ready` |
| `docSize` | `w`, `h`, `hasInput` | document size changed (input connected/disconnected/resized or Docw/Doch changed). Web resizes (anchor top-left), clears history, then TD sends a full BASE frame |
| `active` | `active: bool` | this client became / stopped being the active editor |
| `error` | `msg` | protocol error reported to the client (shown in status bar) |

`protocol` mismatch or bad/missing `token` → TD replies `error` and closes the socket. Connections from non-loopback peers are closed immediately. The token stops other local web pages from driving the editor through a cross-site WebSocket to `127.0.0.1`.

## 3. Session flow

1. Web opens socket, sends `ready`.
2. TD replies `hello`. If no client is active, this client becomes active (`active: true`).
   The Web Render TOP client (`client: "panel"`) always takes priority on first connect
   after a COMP (re)start.
3. If the doc has an input, TD sends a full BASE frame (banded).
4. Active client sends a full COMPOSITE frame, then dirty-rect frames at ≤ `maxSendFps`.
5. TD ignores COMPOSITE frames from non-active clients.
6. A standby client shows an overlay "Editing in another window" with a **Take over**
   button → `takeover` → TD sets it active, sends `active:false` to the previous one,
   `active:true` to the new one, which then sends a full COMPOSITE frame. Standby clients
   keep their own document; nothing is discarded.
7. Input change in TD: if size changed → `docSize` then full BASE; else BASE with the
   whole frame (TD does not diff input), rate-limited to `Maxinputfps`.
8. Disconnect: TD keeps the last composite on its output. Web reconnects with backoff and
   restarts at step 1 (it keeps its layers; if hello's doc size matches it keeps history).
