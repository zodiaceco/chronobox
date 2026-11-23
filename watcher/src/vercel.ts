// A handler of service.ts as a Vercel function (Node.js runtime): (req, res) in, JSON (or a page) out.
import type { IncomingMessage, ServerResponse } from 'node:http';
import process from 'node:process';
import type { Deps, Env, Reply, Request } from './service.ts';

type Handler = (env: Env, req: Request, deps?: Deps) => Promise<Reply>;

const MAX_BODY = 1_000_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

export function vercelFunction(handler: Handler) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let reply: Reply;
    try {
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
      reply = await handler(process.env, { method: req.method ?? 'GET', url: req.url, headers, body: await readBody(req) });
    } catch {
      reply = { status: 400, body: { error: 'bad request' } };
    }
    if (typeof reply.body === 'string') {
      res.writeHead(reply.status, { 'cache-control': 'no-store', ...reply.headers });
      res.end(reply.body);
      return;
    }
    res.writeHead(reply.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(reply.body));
  };
}
