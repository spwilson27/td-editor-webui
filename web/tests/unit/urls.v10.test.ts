import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, decodeEditorList, decodeTdMessage, decodeWebMessage, encodeMessage, readEditorList } from '../../src/bridge/codec';
import { buildHash, editorsUrl, parseHash, requestQuery, withEditor } from '../../src/bridge/urls';

describe('v10 codec', () => {
  it('is protocol 11; ready is external only', () => {
    expect(PROTOCOL_VERSION).toBe(11);
    expect(decodeWebMessage(encodeMessage({ t: 'ready', protocol: 11, client: 'external', version: '1', token: 't', fresh: true }))).toMatchObject({ t: 'ready', protocol: 11, client: 'external' });
    expect(decodeWebMessage('{"t":"ready","protocol":11,"client":"panel","version":"1"}')).toBeNull(); // the panel client is gone
  });

  it('decodes the editors message; incomplete entries are dropped, defaults filled', () => {
    const m = decodeTdMessage('{"t":"editors","master":"a","editors":[{"id":"a","name":"Main","path":"/p/main","version":"0.8.0","active":true},{"id":"b","path":"/p/b","active":false},{"name":"no id"},null,7]}');
    expect(m).toEqual({ t: 'editors', master: 'a', editors: [
      { id: 'a', name: 'Main', path: '/p/main', version: '0.8.0', active: true },
      { id: 'b', name: 'b', path: '/p/b', version: '', active: false },
    ] });
    expect(decodeTdMessage('{"t":"editors","editors":[]}')).toBeNull();
    expect(decodeTdMessage('{"t":"editors","master":"a"}')).toBeNull();
  });

  it('GET /editors body', () => {
    expect(decodeEditorList('{"master":"a","editors":[{"id":"a","name":"A","path":"/a","version":"1","active":true}]}')).toEqual({ master: 'a', editors: [{ id: 'a', name: 'A', path: '/a', version: '1', active: true }] });
    expect(decodeEditorList('nope')).toBeNull();
    expect(readEditorList({ master: 1, editors: [] })).toBeNull();
    expect(readEditorList(null)).toBeNull();
  });

  it('round trips', () => {
    const m = { t: 'editors' as const, master: 'x', editors: [{ id: 'x', name: 'X', path: '/x', version: '', active: true }] };
    expect(decodeTdMessage(encodeMessage(m))).toEqual(m);
  });
});

describe('v10 page hash', () => {
  it('parses #token=…&e=…', () => {
    expect(parseHash('#token=abc&e=ed2')).toEqual({ token: 'abc', editor: 'ed2' });
    expect(parseHash('#e=ed2&token=abc')).toEqual({ token: 'abc', editor: 'ed2' });
    expect(parseHash('token=a%2Bb-_9')).toEqual({ token: 'a+b-_9', editor: '' });
    expect(parseHash('')).toEqual({ token: '', editor: '' });
    expect(parseHash('#')).toEqual({ token: '', editor: '' });
    expect(parseHash('#e=my%20ed')).toEqual({ token: '', editor: 'my ed' });
  });

  it('understands the #/e/<id> deep link of DESIGN_V8', () => {
    expect(parseHash('#/e/ed3')).toEqual({ token: '', editor: 'ed3' });
    expect(parseHash('#/e/ed3&token=t')).toEqual({ token: 't', editor: 'ed3' });
  });

  it('malformed percent-encoding never throws: the raw text is kept', () => {
    expect(() => parseHash('#/e/%E0%A4%A')).not.toThrow();
    expect(parseHash('#/e/%E0%A4%A')).toEqual({ token: '', editor: '%E0%A4%A' });
    expect(parseHash('#/e/%')).toEqual({ token: '', editor: '%' });
    expect(parseHash('#/e/ed%2')).toEqual({ token: '', editor: 'ed%2' });
    expect(parseHash('#token=%E0%A4%A&e=%').editor).toBe('%'); // URLSearchParams decodes leniently
    expect(parseHash('#/e/ok%20x&token=%zz')).toEqual({ token: '%zz', editor: 'ok x' });
  });

  it('builds and round trips', () => {
    expect(buildHash({ token: 'a+b', editor: 'ed 2' })).toBe('#token=a%2Bb&e=ed+2');
    expect(parseHash(buildHash({ token: 'a+b&c', editor: 'ed 2/x' }))).toEqual({ token: 'a+b&c', editor: 'ed 2/x' });
    expect(buildHash({ token: 't', editor: '' })).toBe('#token=t');
    expect(buildHash({ token: '', editor: '' })).toBe('');
  });
});

describe('v10 request URLs', () => {
  it('withEditor on ws urls', () => {
    expect(withEditor('ws://h:1/ws', 'ed1')).toBe('ws://h:1/ws?editor=ed1');
    expect(withEditor('ws://h:1/ws?a=b', 'ed1')).toBe('ws://h:1/ws?a=b&editor=ed1');
    expect(withEditor('ws://h:1/ws?editor=old', 'ed1')).toBe('ws://h:1/ws?editor=ed1');
    expect(withEditor('ws://h:1/ws', '')).toBe('ws://h:1/ws');
  });

  it('requestQuery carries token, client and editor, then the route parameters', () => {
    expect(requestQuery({ token: 'a b', client: 'c1', editor: 'e/1' }, '&slot=2')).toBe('token=a%20b&client=c1&editor=e%2F1&slot=2');
    expect(requestQuery({ token: 't', client: 'c', editor: '' })).toBe('token=t&client=c');
  });

  it('GET /editors takes only the token', () => {
    expect(editorsUrl('http://127.0.0.1:9980', 'a+b')).toBe('http://127.0.0.1:9980/editors?token=a%2Bb');
  });
});
