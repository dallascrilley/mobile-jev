import http from 'node:http';
export const EXPECTED_FORM = {
  name: 'Taylor Tablet',
  destination: 'Austin',
  category: 'Support',
  notes: 'Inspect tablet readiness',
};
export function createFixtureServer() {
  const receipts = new Map();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const id = url.searchParams.get('trial');
    if (req.method === 'GET' && url.pathname === '/result') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(receipts.get(id) || null));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/submit') {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 4000) {
          res.writeHead(413).end();
          return;
        }
      }
      const fields = Object.fromEntries(new URLSearchParams(raw));
      receipts.set(id, fields);
      res.setHeader('Content-Type', 'text/html');
      res.end(
        `<html><meta name="viewport" content="width=device-width, initial-scale=1"><body><h1>Tablet request review</h1>${Object.entries(
          fields,
        )
          .map(([k, v]) => `<p>${k}: ${String(v).replace(/[<>&]/g, '')}</p>`)
          .join('')}<p>Saved for review. No message was sent.</p></body></html>`,
      );
      return;
    }
    if (req.method !== 'GET' || url.pathname !== '/' || !id) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Tablet request</title><style>body{font:22px sans-serif;padding:24px;max-width:680px;margin:auto}label{display:block;margin:24px 0 8px}input,select,textarea,button{font:24px sans-serif;padding:14px;width:90%}textarea{height:110px}.space{height:650px}button{margin:30px 0}</style></head><body><h1>Tablet support request</h1><p>This is a synthetic local test. No external delivery.</p><form action="/submit?trial=${encodeURIComponent(id)}" method="post"><label for="name">Name</label><input id="name" name="name" autocomplete="off"><label for="destination">Destination</label><input id="destination" name="destination" autocomplete="off"><label for="category">Category</label><select id="category" name="category"><option value="">Choose category</option><option>Support</option><option>Delivery</option></select><div class="space"></div><label for="notes">Notes</label><textarea id="notes" name="notes"></textarea><button type="submit">Review request</button></form></body></html>`,
    );
  });
  return { server, receipts };
}
