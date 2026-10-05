import {AnthiasApi, normalizeBase, originPermission} from './api.js';
import {t} from './i18n.js';

// A foreground, user-requested HTTP sweep. No native helper, UDP or subnet guessing.
export const SCAN_PROFILES = Object.freeze({
  quick: Object.freeze({concurrency: 48, timeout: 1200}),
  thorough: Object.freeze({concurrency: 24, timeout: 4000}),
});
export function ipv4(value) {
  const parts = String(value || '').trim().split('.');
  if (parts.length !== 4 || parts.some(x => !/^\d{1,3}$/.test(x) || Number(x) > 255)) {
    throw new Error(t('Valid IPv4 addresses are required.'));
  }
  return parts.reduce((n, x) => n * 256 + Number(x), 0);
}
export function ipString(value) { return [24, 16, 8, 0].map(n => (value >>> n) & 255).join('.'); }
export function isPrivate(value) {
  const a = value >>> 24, b = (value >>> 16) & 255;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 127;
}
export function prefixLength(value) {
  const text = String(value ?? '').trim().replace(/^\//, '');
  if (/^\d{1,2}$/.test(text) && Number(text) <= 32) return Number(text);
  if (text.includes('.')) {
    const mask = ipv4(text), inverse = (~mask) >>> 0;
    if ((inverse & (inverse + 1)) === 0) return 32 - Math.log2(inverse + 1);
  }
  throw new Error(t('Use a subnet prefix (for example /24) or a valid subnet mask.'));
}
function transport({port = 80, protocol = 'http'}) {
  port = Number(port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(t('Invalid port.'));
  if (!['http', 'https'].includes(protocol)) throw new Error(t('Use HTTP or HTTPS.'));
  return {port, protocol};
}
export function networkSpec({address, subnet = '24', port = 80, protocol = 'http'}) {
  const pieces = String(address || '').trim().split('/');
  if (pieces.length > 2) throw new Error(t('Valid IPv4 addresses are required.'));
  const host = ipv4(pieces[0]), prefix = prefixLength(pieces.length === 2 ? pieces[1] : subnet);
  // Bound the workload before allocating addresses or requesting permissions.
  if (prefix < 22) throw new Error(t('Choose a subnet from /22 to /32 (at most 1024 addresses).'));
  const count = 2 ** (32 - prefix), network = Math.floor(host / count) * count;
  const broadcast = network + count - 1;
  if (!isPrivate(network) || !isPrivate(broadcast)) throw new Error(t('Search only a private or local IPv4 subnet.'));
  const first = network + (prefix <= 30 ? 1 : 0), last = broadcast - (prefix <= 30 ? 1 : 0);
  return {address: ipString(host), subnet: String(prefix), network: ipString(network), prefix,
    first, last, count: last - first + 1, cidr: `${ipString(network)}/${prefix}`, ...transport({port, protocol})};
}
export function migrateDiscovery(value = {}) {
  let address = String(value.address || '').slice(0, 32), subnet = String(value.subnet ?? '24').slice(0, 15);
  // Older exports used start/end addresses. Show their containing subnet explicitly.
  if (!address && value.start) {
    try {
      const first = ipv4(value.start), last = ipv4(value.end || value.start);
      address = ipString(first); subnet = String(Math.clz32((first ^ last) >>> 0));
    } catch { /* Invalid historical inputs are never silently scanned. */ }
  }
  return {address, subnet, port: Number(value.port) || 80, protocol: value.protocol === 'https' ? 'https' : 'http'};
}
export function scanTargets(options) {
  let first, last, channel;
  if (options.address !== undefined) {
    const spec = networkSpec(options); ({first, last} = spec); channel = spec;
  } else {
    // Read old inputs in tests/exports; the UI only offers IP + subnet now.
    first = ipv4(options.start); last = ipv4(options.end); channel = transport(options);
    if (first > last || last - first >= 1024) throw new Error(t('Use a private/local IPv4 range containing at most 1024 addresses.'));
  }
  const targets = [];
  for (let i = first; i <= last; i++) {
    if (!isPrivate(i)) throw new Error(t('Search only a private or local IPv4 subnet.'));
    targets.push(normalizeBase(`${channel.protocol}://${ipString(i)}:${channel.port}`));
  }
  return targets;
}
export const permissionsFor = targets => [...new Set(targets.map(originPermission))];
export function prioritizeTargets(targets, known = []) {
  const set = new Set(targets), first = [...new Set(known.filter(x => set.has(x)))];
  const visited = new Set(first); return first.concat(targets.filter(x => !visited.has(x)));
}
export function isAnthiasInfo(info) {
  return Boolean(info && typeof info.anthias_version === 'string' && info.anthias_version.length && typeof info.device_model === 'string' && info.device_model.length);
}
export async function probeInfo(base, {signal, timeout = SCAN_PROFILES.quick.timeout} = {}) {
  const info = await new AnthiasApi(base).request('/api/v2/info', {timeout, signal});
  if (!isAnthiasInfo(info)) { const error = new Error(t('Not an Anthias player.')); error.status = 422; throw error; }
  return {base: normalizeBase(base), identity: '', info};
}
export async function playerIdentity(base, {signal, timeout = 1800} = {}) {
  try {
    const data = await new AnthiasApi(base).integrations({signal, timeout});
    return data?.balena_device_id ? `balena:${String(data.balena_device_id)}` : '';
  } catch { return ''; } // Identity is optional for non-Balena/older players.
}
export async function identifyPlayer(base, {signal, timeout = 6000} = {}) {
  const found = await probeInfo(base, {signal, timeout});
  found.identity = await playerIdentity(base, {signal, timeout: Math.min(timeout, 2500)});
  if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
  return found;
}
export function classifyResult(found, players) {
  const sameBase = players.find(r => r.base === found.base);
  if (sameBase) return {kind: 'existing', player: sameBase};
  const matches = found.identity ? players.filter(r => r.identity === found.identity) : [];
  if (matches.length === 1) return {kind: 'moved', player: matches[0]};
  return {kind: 'new'};
}
export async function scanPlayers(targets, {
  signal, onResult = () => {}, onProgress = () => {}, probe = probeInfo,
  concurrency = SCAN_PROFILES.quick.concurrency, timeout = SCAN_PROFILES.quick.timeout, known = [],
} = {}) {
  const queue = prioritizeTargets([...new Set(targets)], known);
  const started = performance.now(), results = [], unresolved = [], identities = new Set();
  let cursor = 0, checked = 0;
  await Promise.all(Array.from({length: Math.min(Math.max(1, concurrency), 64, queue.length)}, async () => {
    while (cursor < queue.length && !signal?.aborted) {
      const base = queue[cursor++];
      try {
        const found = await probe(base, {signal, timeout});
        if (!signal?.aborted && (!found.identity || !identities.has(found.identity))) {
          results.push(found); if (found.identity) identities.add(found.identity);
          onResult(found); // Do not wait for an optional identity request to display a hit.
        }
      } catch (error) {
        // Only inconclusive network/server failures need a slower second pass.
        if (!signal?.aborted && (!error.status || error.status >= 500)) unresolved.push(base);
      }
      if (!signal?.aborted) {
        checked++;
        onProgress({checked, total: queue.length, found: results.length, elapsedMs: performance.now() - started});
      }
    }
  }));
  return {results, checked, unresolved, elapsedMs: performance.now() - started, stopped: Boolean(signal?.aborted)};
}
