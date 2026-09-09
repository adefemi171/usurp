import { expect, it } from 'vitest';
import { createServer } from 'node:net';
import { probeDatabaseEndpoint } from './database-endpoint-probe.mjs';
it('refuses plaintext-only PostgreSQL endpoints without sending credentials', async () => {
  let received: Buffer | undefined;
  const server = createServer(socket => socket.once('data', data => { received = data; socket.end('N'); }));
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const address=server.address() as {port:number};
    await expect(probeDatabaseEndpoint({host:'127.0.0.1',port:address.port,timeoutMs:1000})).rejects.toThrow('did not accept TLS');
    expect(received?.toString('hex')).toBe('0000000804d2162f');
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
