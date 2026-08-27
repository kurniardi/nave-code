import type { Tool } from './types.ts';
import { ok, fail, str } from './types.ts';

/**
 * Local HTTP only.
 *
 * nave is an offline tool by design, so this deliberately refuses the public
 * internet. What it is for is the dev server the model just started: hitting
 * http://localhost:3000 to confirm a route renders is part of doing the work.
 */
const LOCAL_HOSTS = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0|host\.docker\.internal)$/i;
const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

const MAX_BODY = 20_000;

export const httpTool: Tool = {
  name: 'http',
  description:
    'Make an HTTP request to a service running on this machine or local network — typically the dev ' +
    'server you just started — and return the status and body. Public internet hosts are refused.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'A localhost or private-network URL.' },
      method: { type: 'string', description: 'HTTP method. Defaults to GET.' },
      body: { type: 'string', description: 'Request body for POST/PUT/PATCH.' },
      headers: { type: 'object', description: 'Optional request headers.' },
      timeout_ms: { type: 'number', description: 'Timeout in ms (default 15000).' },
    },
    required: ['url'],
  },
  async run(args, ctx) {
    const raw = str(args, 'url');
    if (!raw) return fail('url is required');

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return fail(`"${raw}" is not a valid URL`);
    }
    if (!/^https?:$/.test(url.protocol)) {
      return fail(`unsupported protocol ${url.protocol}`);
    }
    const host = url.hostname;
    if (!LOCAL_HOSTS.test(host) && !PRIVATE_IPV4.test(host)) {
      return fail(
        `${host} is not a local address. nave runs entirely offline and only talks to services on this machine or your local network.`
      );
    }

    const method = (str(args, 'method') ?? 'GET').toUpperCase();
    const timeout = Number(args.timeout_ms ?? 15_000);
    const headers: Record<string, string> = {};
    if (args.headers && typeof args.headers === 'object') {
      for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) {
        headers[k] = String(v);
      }
    }

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : str(args, 'body'),
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(timeout)]),
      });
      const text = await res.text();
      const clipped =
        text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}\n… [${text.length - MAX_BODY} chars trimmed]` : text;
      const type = res.headers.get('content-type') ?? 'unknown';
      return ok(
        `${res.status} ${res.statusText} (${type})\n\n${clipped}`,
        `${method} ${url.pathname} → ${res.status}`
      );
    } catch (err) {
      const msg = String((err as Error).message);
      return fail(
        /abort|timeout/i.test(msg)
          ? `no response from ${url.host} within ${timeout}ms — is the server running?`
          : `request failed: ${msg}`
      );
    }
  },
};
