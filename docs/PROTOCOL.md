# TD ⇄ Web protocol (version 2)

One WebSocket per browser client, served by the COMP's Web Server DAT at
`ws://127.0.0.1:<Port>/ws`. Text messages are JSON; binary WebSocket messages are COMPOSITE frames
(web → TD) only. **TD → web image data (BASE frames) is never written to the WebSocket**: TD announces
it with a tiny JSON `base` notice and the web client pulls it with `GET /base` (§4). Version 2 replaced the
version 1 banded WebSocket BASE frames and their `ack`, because `webSocketSendBinary` blocks TD's cook thread
when a peer stops reading, while HTTP responses are written on the server's own threads.
Both sides MUST ignore unknown JSON message types and unknown fields.

Implementations: `web/src/bridge/codec.ts` and `td/raster_editor/protocol.py`.
Shared fixtures: `docs/fixtures/*.bin` + `docs/fixtures/fixtures.json` (both test suites
decode the same bytes and assert the same fields).

## 1. Binary frame messages

Little-endian. 24-byte header followed by the payload.

| Offset | Type | Field | Notes |
| --- | --- | --- | --- |
| 0 | 4 bytes | magic | ASCII `REF1` |
| 4 | u8 | type | `1` = BASE (TD → web, delivered as the body of `GET /base`), `2` = COMPOSITE (web → TD, WebSocket) |
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
  frame never overlap. COMPOSITE senders keep each WebSocket message ≤ 2 MB payload (split by rows).
  A BASE frame fetched over HTTP is always **one band covering the whole document** (`x=y=0`,
  `w=docW`, `h=docH`, `FRAME_END` set) of any size.
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
| `ready` | `protocol: 2`, `client: "panel" \| "external"`, `version: string`, `token: string` | first message after open. `token` is the value of the page's own `token` URL query parameter (`new URLSearchParams(location.search).get('token')`, sent verbatim; the Dev URL workflow carries it too). TD rejects a missing or wrong token with `error` and closes the socket. It is regenerated on every COMP start, so a stale tab must be reopened (Open in Browser) and a page that reconnects after a restart reads it again only on reload |
| `takeover` | — | this client wants to become the active editor |
| `requestBase` | — | announce the stored base frame again (a `base` notice), even if it was fetched already |
| `log` | `level: "info" \| "warn" \| "error"`, `msg: string` | forwarded console errors / `window.onerror`; TD prints to the textport, rate-limited to 20/s |

### TD → Web

| `t` | Fields | Meaning |
| --- | --- | --- |
| `hello` | `protocol: 2`, `doc: {w, h}`, `hasInput: bool`, `maxSendFps: number`, `active: bool`, `clientId: string` | reply to `ready`. `clientId` is an opaque per-connection id the client passes to `GET /base` |
| `base` | `frameId`, `docW`, `docH`, `x: 0`, `y: 0`, `w`, `h` (= doc size) | a newer BASE frame can be fetched with `GET /base` (§4). Sent only when the client has no un-fetched notice |
| `docSize` | `w`, `h`, `hasInput` | document size changed (input connected/disconnected/resized or Docw/Doch changed). Web resizes (anchor top-left), clears history, then TD sends a `base` notice for the new size (any earlier notice is void) |
| `active` | `active: bool` | this client became / stopped being the active editor |
| `error` | `msg` | protocol error reported to the client (shown in status bar) |

`protocol` mismatch or bad/missing `token` → TD replies `error` and closes the socket. Connections from non-loopback peers are closed immediately. The token stops other local web pages from driving the editor through a cross-site WebSocket to `127.0.0.1`.

## 3. Session flow

1. Web opens socket, sends `ready`.
2. TD replies `hello`. If no client is active, this client becomes active (`active: true`).
   The Web Render TOP client (`client: "panel"`) always takes priority on first connect
   after a COMP (re)start.
3. If the doc has an input, TD sends a `base` notice; the client fetches the frame (§4).
4. Active client sends a full COMPOSITE frame, then dirty-rect frames at ≤ `maxSendFps`.
5. TD ignores COMPOSITE frames from non-active clients.
6. A standby client shows an overlay "Editing in another window" with a **Take over**
   button → `takeover` → TD sets it active, sends `active:false` to the previous one,
   `active:true` to the new one, which then sends a full COMPOSITE frame. Standby clients
   keep their own document; nothing is discarded.
7. Input change in TD: if size changed → `docSize`, then a `base` notice once the new frame is
   converted; otherwise a `base` notice for the whole new frame (TD does not diff input),
   rate-limited to `Maxinputfps`.
8. Disconnect: TD keeps the last composite on its output. Web reconnects with backoff and
   restarts at step 1 (it keeps its layers; if hello's doc size matches it keeps history).

## 4. BASE delivery: notice + HTTP pull

TD → web image data never goes through the WebSocket (a blocked WebSocket write freezes TouchDesigner).

- TD keeps only the **newest** converted input frame, as one immutable binary message (24-byte header +
  `docW*docH*4` payload, type BASE, `FRAME_END`, rect = whole document, `frameId` = that frame's id).
- TD sends `{t:"base", frameId, docW, docH, x:0, y:0, w, h}` to each ready client (active and standby), **at most
  one un-fetched notice per client**: after sending one it sends no further notice to that client until that
  client has fetched. Newer input frames replace the stored frame meanwhile.
- The client fetches `GET /base?token=<token>&client=<hello.clientId>&frameId=<notice.frameId>` on the panel's own
  origin (e.g. `fetch(new URL('/base', location.href) + qs)` then `arrayBuffer()`); `token` is the same value as in
  `ready.token`. The response is `200 application/octet-stream` with the frame message of the **newest** stored
  frame (its header `frameId` may be newer than the notice's; the `frameId` query parameter is informational),
  `404` if TD has no frame (e.g. just after a resize; ignore it, a `base` notice will follow), `403` for a bad
  token or a non-loopback caller. Fetching marks the notice as fetched for that `clientId`; if TD has a newer
  frame it then sends the next notice (typically within a TD frame). Decode it with the normal frame codec;
  apply the stale-document rule (`docW/docH` ≠ current → drop); it replaces the base layer.
- A client that has not fetched its notice for 10 s is *stalled*: TD sends it no further notices until it
  fetches (the COMP's Status shows the stalled count). TD never closes a stalled socket from its cook thread.
- `docSize` voids all outstanding notices (clients should fetch only after the notice that follows it).
- HTTP responses are written on the server's own threads: a client that issues `GET /base` and never reads
  the body does not block TouchDesigner (measured: 32 MB response, TD responsive for 30 s, then reset).
- Typical cost: an 8 MB 1080p frame fetches in about 30 ms.
- COMPOSITE frames (web → TD) stay on the WebSocket, banded ≤ 2 MB as before, and are not acked.
