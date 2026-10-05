// Always open the canonical packaged page. The permanent manifest key fixes its origin.
// No session URL, saved tab ID, automatic player request or extra browser permission.
let openingPanel = null;

async function focusOrCreatePanel() {
  const url = chrome.runtime.getURL('panel.html');
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); }
  catch (error) { console.warn('Unable to inspect panel tabs; opening the panel.', error); }
  const existing = tabs.find(tab => {
    try {
      // pendingUrl covers a restored/loading tab. Ignore only query/hash for comparison.
      const candidate = new URL(tab.pendingUrl || tab.url || '');
      candidate.search = '';
      candidate.hash = '';
      return candidate.href === url;
    } catch { return false; }
  });
  if (existing && Number.isInteger(existing.id)) {
    let activated = false;
    try { await chrome.tabs.update(existing.id, {active:true}); activated = true; }
    catch (error) { console.warn('Panel tab was closed or unavailable; reopening.', error); }
    if (activated) {
      if (Number.isInteger(existing.windowId)) {
        try { await chrome.windows.update(existing.windowId, {focused:true}); }
        catch (error) { console.warn('Panel opened, but its window could not be focused.', error); }
      }
      return; // A focus failure must not duplicate an already activated panel.
    }
  }
  await chrome.tabs.create({url});
}

chrome.action.onClicked.addListener(() => {
  // A rapid double click must not create two tabs while the first one is opening.
  if (!openingPanel) {
    openingPanel = focusOrCreatePanel()
      .catch(error => console.error('Unable to open Anthias Rooms.', error))
      .finally(() => { openingPanel = null; });
  }
  return openingPanel;
});
