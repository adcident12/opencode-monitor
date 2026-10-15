// The MCP tools over HTTP, for an assistant on another machine of the network (Claude Code on a
// model server, say): MCP's "Streamable HTTP" transport, the plain JSON form. Each POST carries
// one JSON-RPC message, or a batch, and is answered with JSON. The monitor never calls the
// client, so there is no event stream to open (GET answers 405, as the transport allows).
// Who may ask is decided before this, by the access key, as for the page.

// No request of this protocol comes near this size; a bigger body is dropped, not kept.
const MAX_BODY = 1_000_000;

/** The body of a request as text, or null when it is larger than `max`. */
function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    // Past the limit the rest is read and dropped, so the answer still reaches the client.
    req.on('data', chunk => {
      size += chunk.length;
      if (size <= max) chunks.push(chunk);
    });
    req.on('end', () => resolve(size > max ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

/**
 * Answers one HTTP request at the MCP address.
 * @param {(message: object) => object|null} handle  from createMcpServer
 * @param {Set<string>} origins  page origins allowed to call (the monitor's own): a web page
 *   anywhere else that tries to reach it from a browser is refused
 */
export async function answerMcp(req, res, handle, origins) {
  const origin = req.headers.origin;
  if (origin && !origins.has(String(origin).toLowerCase())) {
    res.writeHead(403, JSON_HEADERS).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Origin not allowed.' } }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { ...JSON_HEADERS, allow: 'POST' }).end();
    return;
  }
  const text = await readBody(req);
  if (text == null) {
    res.writeHead(413, JSON_HEADERS).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large.' } }));
    return;
  }
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Not JSON.' } }));
    return;
  }
  const replies = (Array.isArray(message) ? message : [message]).map(m => handle(m)).filter(Boolean);
  // Only notifications or replies: accepted, nothing to say.
  if (!replies.length) {
    res.writeHead(202, JSON_HEADERS).end();
    return;
  }
  res.writeHead(200, JSON_HEADERS).end(JSON.stringify(Array.isArray(message) ? replies : replies[0]));
}
