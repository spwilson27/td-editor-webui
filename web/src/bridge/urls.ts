// v10: page URL hash (`#token=…&e=<editorId>`) and the `editor=<id>` parameter of every WebSocket / HTTP request. Pure; no sockets.

export interface PageNav { token: string; editor: string }

/** `#token=<t>&e=<editorId>` (also the `#/e/<editorId>` deep link of DESIGN_V8). Missing parts are ''. */
/** decodeURIComponent that never throws: a malformed escape (`%E0%A4%A`, a lone `%`) leaves the raw text. */
function safeDecode(v: string): string {
  try { return decodeURIComponent(v); } catch { return v; }
}

export function parseHash(hash: string): PageNav {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const deep = /^\/e\/([^&?#/]+)/.exec(raw);
  const p = new URLSearchParams(deep ? raw.slice(deep[0].length).replace(/^[&?]/, '') : raw);
  return { token: p.get('token') ?? '', editor: deep ? safeDecode(deep[1]) : (p.get('e') ?? '') };
}

/** The hash for a page state; '' parts are omitted (and an empty result is ''). */
export function buildHash(nav: PageNav): string {
  const p = new URLSearchParams();
  if (nav.token) p.set('token', nav.token);
  if (nav.editor) p.set('e', nav.editor);
  const s = p.toString();
  return s ? `#${s}` : '';
}

/** Adds / replaces `editor=<id>` on a WebSocket (or any) URL; an empty id leaves the URL untouched (= the master's own editor). */
export function withEditor(url: string, editor: string): string {
  if (!editor) return url;
  const u = new URL(url);
  u.searchParams.set('editor', editor);
  return u.toString();
}

export interface RequestIdentity { token: string; client: string; editor: string }

/** The shared query of every per-editor HTTP route: `token`, `client` and (when known) `editor`, then `extra` (already `&`-prefixed). */
export function requestQuery(id: RequestIdentity, extra = ''): string {
  return `token=${encodeURIComponent(id.token)}&client=${encodeURIComponent(id.client)}${id.editor ? `&editor=${encodeURIComponent(id.editor)}` : ''}${extra}`;
}

/** `GET /editors?token=` (not per editor: no `client` / `editor`). */
export function editorsUrl(origin: string, token: string): string {
  return `${origin}/editors?token=${encodeURIComponent(token)}`;
}
