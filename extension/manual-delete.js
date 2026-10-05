/**
 * Explicit operator deletion. Deliberately separate from lifecycle.js:
 * automatic cleanup retains every existing ownership/readiness/live safeguard.
 * A receipt records only reconciliation work, NEVER permission to retry DELETE.
 */
import {assetId} from './api.js';
import {itemIds, unique} from './storage.js';
import {t} from './i18n.js';

const isLocalPath = uri => typeof uri === 'string' && uri.startsWith('/') && !uri.startsWith('//');
const isLive = asset => Boolean(asset.is_active || asset.is_enabled);
const displayName = asset => String(asset.name || asset.asset_id).replace(/^\[HMR\] (?:Hotel|Evento|Home|Event) - [a-f0-9]{8} - /, '');

export function deletionPlan(assets, room, id) {
  assetId(id); // Validate identifiers before rendering or sending any request.
  const selected = assets.find(asset => asset.asset_id === id);
  if (!selected) return null;
  // Deleting a physical file may invalidate more than one asset registration.
  // Include those exact-path aliases in the confirmation, never silently orphan them.
  const targets = assets.filter(asset => asset.asset_id === id ||
    (isLocalPath(selected.uri) && asset.uri === selected.uri));
  const ids = targets.map(asset => asset.asset_id).sort();
  const roles = ['home', 'event'].filter(role =>
    itemIds(room.playlists[role]).some(value => ids.includes(value)) ||
    (room.lastPublished?.role === role && itemIds(room.lastPublished.items).some(value => ids.includes(value))));
  const live = targets.some(isLive);
  return {
    selected, targets, ids, roles, live,
    processing: targets.some(asset => asset.is_processing),
    lastActive: live && !assets.some(asset => !ids.includes(asset.asset_id) && isLive(asset)),
    fingerprint: JSON.stringify({
      targets: targets.map(asset => [asset.asset_id, asset.uri, asset.name, Boolean(asset.is_enabled),
        Boolean(asset.is_active), Boolean(asset.is_processing)]).sort((a, b) => a[0].localeCompare(b[0])),
      roles, remainingActive: assets.filter(asset => !ids.includes(asset.asset_id) && isLive(asset)).map(asset => asset.asset_id).sort()
    })
  };
}

export function deletionMessage(plan) {
  const lines = [t('Permanently delete “{name}” from this player?', {name: displayName(plan.selected)})];
  if (plan.live) lines.push(t('This asset is LIVE or enabled on the player. Deleting it can interrupt playback.'));
  if (plan.roles.length) lines.push(t('It will also be removed from these panel playlists: {roles}.', {
    roles: plan.roles.map(role => t(role === 'home' ? 'Home content' : 'Event')).join(', ')
  }));
  if (plan.lastActive) lines.push(t('This removes the last active content. The player may have nothing to show until you publish another playlist.'));
  if (plan.processing) lines.push(t('The player is still processing this asset. Deletion will be requested anyway.'));
  if (plan.targets.length > 1) lines.push(t('These {count} asset entries share the same physical file and will all be deleted: {names}.', {
    count: plan.targets.length, names: plan.targets.map(displayName).join(', ')
  }));
  if (!isLocalPath(plan.selected.uri)) lines.push(t('Only the entry on this player is removed; the remote website or source file is not deleted.'));
  lines.push(t('This cannot be undone. Other players are not affected.'));
  return lines.join('\n\n');
}

/** Remove only IDs proven absent, preserving order/timing of every surviving item. */
export function detachDeletedMedia(room, ids) {
  const deleted = new Set(unique(ids));
  for (const role of ['home', 'event']) room.playlists[role] = room.playlists[role].filter(item => !deleted.has(item.id));
  if (room.lastPublished) {
    room.lastPublished.items = room.lastPublished.items.filter(item => !deleted.has(item.id));
    if (!room.lastPublished.items.length) room.lastPublished = null;
  }
  for (const key of ['uploadedIds', 'managedEventIds', 'eventHistory', 'homeHistory'])
    room[key] = room[key].filter(id => !deleted.has(id));
  // A manual edit invalidates the prior verification target. Cancel such jobs,
  // rather than weakening automatic cleanup by silently changing its precondition.
  room.cleanup = room.cleanup.filter(job => !deleted.has(job.assetId) && !job.targetIds.some(id => deleted.has(id)));
}

export function validDeletionReceipt(receipt, base) {
  return Boolean(receipt?.version === 1 && receipt.base === base && Array.isArray(receipt.ids) &&
    receipt.ids.length > 0 && receipt.ids.length === unique(receipt.ids).length);
}

/** Recovery after a closed tab / lost response: read and detach only, no DELETE. */
export async function reconcileDeletion(api, room, receipt, {persist, clearReceipt, onDeleted = () => {}}) {
  if (!validDeletionReceipt(receipt, room.base)) return {deleted: [], ignored: true};
  const assets = await api.assets();
  const missing = receipt.ids.filter(id => !assets.some(asset => asset.asset_id === id));
  if (missing.length) {
    detachDeletedMedia(room, missing);
    await persist(); // Keep the receipt if local saving fails.
    for (const id of missing) await onDeleted(id);
  }
  await clearReceipt();
  return {assets, deleted: missing};
}

/** Caller holds the player lock. Confirmation always uses freshly read state. */
export async function deleteMedia(api, room, id, {
  confirm, persist, saveReceipt, clearReceipt, authorize = async () => {},
  onDeleted = () => {}, progress = () => {}
}) {
  if (typeof confirm !== 'function') throw new TypeError('Manual deletion requires explicit confirmation.');
  let assets = await api.assets();
  let plan;
  for (let attempt = 0; attempt < 3; attempt++) {
    plan = deletionPlan(assets, room, id);
    if (!plan) {
      detachDeletedMedia(room, [id]); await persist(); await onDeleted(id);
      return {deleted: [], alreadyAbsent: true, assets};
    }
    if (!await confirm(plan)) return {cancelled: true, deleted: [], assets};
    await authorize();
    const fresh = await api.assets(), latest = deletionPlan(fresh, room, id);
    if (!latest) {
      detachDeletedMedia(room, [id]); await persist(); await onDeleted(id);
      return {deleted: [], alreadyAbsent: true, assets: fresh};
    }
    if (latest.fingerprint === plan.fingerprint) {assets = fresh; plan = latest; break;}
    assets = fresh; plan = null; // State/aliases changed: ask again with the new impact.
  }
  if (!plan) throw new Error(t('Player state keeps changing. Refresh Player media and try again.'));
  await authorize();
  const receipt = {version: 1, base: room.base, ids: plan.ids, createdAt: new Date().toISOString()};
  await saveReceipt(receipt); // Fail closed if crash-recovery metadata cannot be saved.
  progress(t('Deleting from player…'));
  const failures = [];
  for (const target of plan.targets) {
    try {await authorize(); await api.remove(target.asset_id);}
    catch (error) {failures.push({id: target.asset_id, message: error.message});}
  }
  // Includes 204, 404, timeout/lost reply and partial success. Never retry blindly.
  const result = await reconcileDeletion(api, room, receipt, {persist, clearReceipt, onDeleted});
  const remaining = plan.ids.filter(value => result.assets.some(asset => asset.asset_id === value));
  if (remaining.length) {
    const detail = failures.filter(error => remaining.includes(error.id)).map(error => error.message).join(' · ');
    throw new Error(t('Deletion incomplete: {deleted} removed, {remaining} still on the player. Refresh and confirm again to retry.', {
      deleted: result.deleted.length, remaining: remaining.length
    }) + (detail ? ` ${detail}` : ''));
  }
  return {...result, lastActive: plan.lastActive};
}
