import net from 'node:net';
import tls from 'node:tls';

/** PostgreSQL SSL negotiation only: no credentials, SQL, or application writes.
 * Lets a free Render instance verify its actual outbound network during an
 * approved maintenance window, without requiring a paid remote shell. */
export function probeDatabaseEndpoint({ host, port = 15433, servername = host, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let connectionMs;
    let secure;
    let finished = false;
    const socket = net.createConnection({ host, port: Number(port) });
    const timer = setTimeout(() => fail(new Error('Database TLS preflight timed out')), timeoutMs);
    function fail(error) {
      if (finished) return;
      finished = true; clearTimeout(timer); secure?.destroy(); socket.destroy(); reject(error);
    }
    socket.once('error', fail);
    socket.once('end', () => fail(new Error('Database closed before TLS verification')));
    socket.once('connect', () => {
      connectionMs = Math.round(performance.now() - started);
      const request = Buffer.alloc(8);
      request.writeInt32BE(8, 0); request.writeInt32BE(80877103, 4);
      socket.write(request);
    });
    socket.once('data', response => {
      if (response.length !== 1 || response[0] !== 83) return fail(new Error('Database did not accept TLS negotiation'));
      secure = tls.connect({ socket, servername, rejectUnauthorized: true, minVersion: 'TLSv1.2' });
      secure.once('error', fail);
      secure.once('secureConnect', () => {
        if (!secure.authorized) return fail(new Error('Database certificate not authorized'));
        finished = true; clearTimeout(timer);
        const result = { ok: true, tcpConnectMs: connectionMs, verifiedTlsMs: Math.round(performance.now()-started), protocol: secure.getProtocol() };
        secure.end(); resolve(result);
      });
    });
  });
}
