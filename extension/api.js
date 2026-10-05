import {t} from './i18n.js';
/* Anthias API v2. Source contracts are documented in README.md. */
export class ApiError extends Error {
  constructor(message, status = 0, path = '') {
    super(message); this.name = 'ApiError'; this.status = status; this.path = path;
  }
}
export function normalizeBase(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let url;
  try { url = new URL(text.includes('://') ? text : `http://${text}`); }
  catch { throw new Error(t('Invalid address. Enter an IP or hostname.')); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error(t('Use an HTTP(S) address without paths, credentials or query parameters.'));
  }
  return url.origin;
}
export function originPermission(base) {
  const url = new URL(base);
  return `${url.protocol}//${url.hostname}/*`;
}
export function assetId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    throw new Error(t('Invalid asset identifier.'));
  }
  return encodeURIComponent(id);
}
export function mediaKind(asset) {
  const type = String(asset?.mimetype || '').toLowerCase();
  if (type === 'video' || type.startsWith('video/')) return 'video';
  if (type === 'image' || type.startsWith('image/')) return 'image';
  return null;
}
export function isLocalMedia(asset) {
  return Boolean(mediaKind(asset) && typeof asset.uri === 'string' && asset.uri.startsWith('/') && !asset.uri.startsWith('//'));
}
export function mediaUrl(base, asset) {
  if (!isLocalMedia(asset)) return null;
  const basename = asset.uri.split('/').pop();
  if (!basename || basename === '.' || basename === '..') return null;
  return `${normalizeBase(base)}/assets/${assetId(asset.asset_id)}/preview/`;
}
export function processingError(asset) {
  const meta = asset?.metadata || {};
  return meta.error_message || meta.processing_error || null;
}
export function assertReady(asset) {
  if (!asset) throw new Error(t('Asset missing on player. Refresh and select it again.'));
  if (!isLocalMedia(asset)) throw new Error(t('Choose a local image or video. Web apps remain managed in Anthias.'));
  if (asset.is_processing) throw new Error(t('Anthias is still processing this file.'));
  if (processingError(asset)) throw new Error(t('Anthias reports a file error: {detail}',{detail:processingError(asset)}));
  if (asset.is_reachable === false) throw new Error(t('Anthias reports that this file is unavailable.'));
}
export function fileKind(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  if (['jpg','jpeg','png','webp'].includes(extension)) return 'image';
  if (['mp4','mov','m4v','webm'].includes(extension)) return 'video';
  throw new Error(t('Unsupported file type. Use JPG, PNG, WebP, MP4, MOV, M4V or WebM.'));
}
function errorText(body, status) {
  let detail = typeof body === 'string' ? body : JSON.stringify(body);
  detail = String(detail || '').slice(0, 700);
  if (detail.trim().startsWith('<')) detail = t('HTML returned instead of JSON.');
  const help = status === 401 || status === 403
    ? t('Access denied. This panel currently supports players without Anthias authentication.')
    : status === 413 ? t('Player rejected the file as too large.')
    : status === 507 ? t('Player storage is full.')
    : t('HTTP error {status}.',{status});
  return `${help}${detail ? ' ' + detail : ''}`;
}
export class AnthiasApi {
  constructor(base, log = () => {}) { this.base = normalizeBase(base); this.log = log; }
  async request(path, {method = 'GET', body, timeout = 20000, signal} = {}) {
    if (!this.base) throw new ApiError(t('Player is not configured.'));
    if (!path.startsWith('/api/v2/')) throw new ApiError(t('Invalid API path.'));
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, {once:true});
    const timer = setTimeout(abort, timeout);
    try {
      const response = await fetch(this.base + path, {
        method, cache: 'no-store', credentials: 'omit', redirect: 'error',
        headers: {Accept: 'application/json', ...(body !== undefined ? {'Content-Type': 'application/json'} : {})},
        ...(body !== undefined ? {body: JSON.stringify(body)} : {}), signal: controller.signal
      });
      const text = await response.text();
      let result = null;
      if (text.trim()) { try { result = JSON.parse(text); } catch { result = text; } }
      this.log({method, path, status: response.status});
      if (!response.ok) throw new ApiError(errorText(result, response.status), response.status, path);
      return result;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const message = error.name === 'AbortError'
        ? t('Request timed out. Verify the result of any write before retrying.')
        : t('Player unreachable. Check the network, address and extension permissions.');
      this.log({method, path, status: 0, error: message});
      throw new ApiError(message, 0, path);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async assets(options = {}) {
    const data = await this.request('/api/v2/assets', {timeout: 7000, ...options});
    if (!Array.isArray(data) || data.some(a => !a || typeof a.asset_id !== 'string' || typeof a.is_enabled !== 'boolean')) {
      throw new ApiError(t('Invalid Anthias asset list response.'));
    }
    return data;
  }
  get(id) { return this.request(`/api/v2/assets/${assetId(id)}`); }
  patch(id, body) { return this.request(`/api/v2/assets/${assetId(id)}`, {method: 'PATCH', body}); }
  create(body) { return this.request('/api/v2/assets', {method: 'POST', body, timeout: 120000}); }
  show(id) { return this.request(`/api/v2/assets/control/asset&${assetId(id)}`); }
  order(ids) { return this.request('/api/v2/assets/order', {method:'POST', body:{ids:ids.join(',')}}); }
  settings() { return this.request('/api/v2/device_settings'); }
  patchSettings(body) { return this.request('/api/v2/device_settings', {method:'PATCH', body}); }
  integrations(options = {}) { return this.request('/api/v2/integrations', {timeout:4000, ...options}); }
  info() { return this.request('/api/v2/info', {timeout: 20000}); }
  reboot() { return this.request('/api/v2/reboot', {method: 'POST'}); }
  remove(id) { return this.request(`/api/v2/assets/${assetId(id)}`, {method: 'DELETE'}); }
  upload(file, onProgress) {
    // Single multipart transfer: no base64 copies, no blind retry, no hidden server.
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', this.base + '/api/v2/file_asset');
      xhr.timeout = 15 * 60 * 1000;
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.upload.onprogress = e => onProgress?.(e.lengthComputable ? Math.round(e.loaded / e.total * 100) : null);
      xhr.onload = () => {
        let body;
        try { body = JSON.parse(xhr.responseText); }
        catch { body = xhr.responseText; }
        this.log({method: 'POST', path: '/api/v2/file_asset', status: xhr.status});
        if (xhr.status < 200 || xhr.status >= 300) return reject(new ApiError(errorText(body, xhr.status), xhr.status));
        if (!body?.uri || !body?.ext) return reject(new ApiError(t('Upload response is missing uri/ext.')));
        resolve(body);
      };
      const fail = reason => {
        this.log({method: 'POST', path: '/api/v2/file_asset', status: 0, error: reason});
        reject(new ApiError(reason));
      };
      xhr.onerror = () => fail(t('Upload interrupted. Existing playback has not been disabled.'));
      xhr.ontimeout = () => fail(t('Upload exceeded 15 minutes. Check the player before retrying.'));
      xhr.onabort = () => fail(t('Upload cancelled.'));
      const form = new FormData();
      form.append('file_upload', file, file.name);
      xhr.send(form);
    });
  }
}
