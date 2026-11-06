import { createHmac, randomBytes } from 'node:crypto';
import { isIP, SocketAddress } from 'node:net';

const WINDOW_MS = 60_000;
const MAX_ANALYSES = 12;
const MAX_PER_VISITOR = 4;
const MAX_ATTEMPTS = 80;

export function createPublicLimits(now = () => performance.now()) {
  const key = randomBytes(32);
  const visitors = new Map();
  let resetAt = 0;
  let analyses = 0;
  let attempts = 0;

  function refreshWindow() {
    const time = now();
    if (time >= resetAt) {
      resetAt = time + WINDOW_MS;
      analyses = 0;
      attempts = 0;
      visitors.clear();
    }
    return Math.ceil((resetAt - time) / 1000);
  }

  return {
    admitAnalysis(address) {
      const retryAfter = refreshWindow();
      if (analyses >= MAX_ANALYSES) return retryAfter;
      const family = isIP(address);
      const canonical = family
        ? new SocketAddress({ address, family: family === 6 ? 'ipv6' : 'ipv4' }).address
        : 'sem-ip-verificado';
      const visitor = createHmac('sha256', key).update(canonical).digest('base64url');
      const count = visitors.get(visitor) ?? 0;
      if (count >= MAX_PER_VISITOR) return retryAfter;
      visitors.set(visitor, count + 1);
      analyses++;
      return 0;
    },

    takeAttempt() {
      refreshWindow();
      if (attempts >= MAX_ATTEMPTS) return false;
      attempts++;
      return true;
    },
  };
}
