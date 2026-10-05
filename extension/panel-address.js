/** The landing page is an extension resource, never a generated/session URL. */
export function getPanelAddress(runtime = globalThis.chrome?.runtime) {
  if (!runtime?.getURL) throw new Error('Open Anthias Rooms from its Chrome extension.');
  const address = runtime.getURL('panel.html');
  const parsed = new URL(address);
  if (parsed.protocol !== 'chrome-extension:' || !/^[a-p]{32}$/.test(parsed.hostname) ||
      parsed.pathname !== '/panel.html' || parsed.search || parsed.hash) {
    throw new Error('Invalid Anthias Rooms panel address.');
  }
  return address;
}

/** User-triggered copy only. No clipboard permission or background clipboard access. */
export async function copyPanelAddress(input, {
  runtime = globalThis.chrome?.runtime,
  clipboard = globalThis.navigator?.clipboard
} = {}) {
  const address = getPanelAddress(runtime);
  input.value = address;
  try {
    if (!clipboard?.writeText) throw new Error('Clipboard unavailable');
    await clipboard.writeText(address);
    return true;
  } catch {
    // Keep the address selected for keyboard/context-menu Copy if browser policy denies it.
    input.focus();
    input.select();
    return false;
  }
}
