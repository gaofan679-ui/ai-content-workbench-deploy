import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

function allowed(input) {
  let host;
  if (typeof input === 'string' || input instanceof URL) host = new URL(input).hostname;
  else host = input?.hostname || input?.host || 'localhost';
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) throw new Error('TEST_BLOCKED_EXTERNAL_NETWORK');
}
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, ...rest) => {
  allowed(input instanceof Request ? input.url : input);
  return originalFetch(input, ...rest);
};
for (const module of [http, https]) {
  for (const name of ['request', 'get']) {
    const original = module[name];
    module[name] = function (...args) { allowed(args[0]); return original.apply(this, args); };
  }
}
syncBuiltinESMExports();
