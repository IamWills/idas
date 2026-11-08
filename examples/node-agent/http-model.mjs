import { IdasError, services } from '../../packages/contracts/dist/index.js';

/** A host-configured bridge to any service that accepts ModelRequest and returns an IDSS object. */
export function httpModel(endpoint, token, request = fetch) {
  const url = new URL(endpoint);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password) {
    throw new IdasError('INVALID', 'Model endpoint requires HTTPS or loopback HTTP');
  }
  return {
    manifest: {
      id: 'example.http-model', version: '1.0.0', environments: ['node'], requires: [], permissions: ['model.http'],
      provides: [{ id: services.model, version: '1.0.0' }],
    },
    async invoke(_id, input, ctx) {
      const response = await request(url, {
        method: 'POST', redirect: 'error', signal: ctx.signal,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify(input),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new IdasError('PLUGIN', 'Model service returned HTTP ' + response.status);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let size = 0;
      let body = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1_000_000) throw new IdasError('INVALID', 'Model response exceeds size limit');
          body += decoder.decode(value, { stream: true });
        }
        body += decoder.decode();
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally {
        reader.releaseLock();
      }
      try { return JSON.parse(body); }
      catch (cause) { throw new IdasError('INVALID', 'Model service did not return an IDSS JSON object', { cause }); }
    },
  };
}
