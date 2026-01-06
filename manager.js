const activeListEl = document.getElementById('active-list');
const refreshBtn = document.getElementById('refresh-btn');
const saveAllBtn = document.getElementById('save-all-btn');
const expandAllBtn = document.getElementById('expand-all-btn');
const saveSessionBtn = document.getElementById('save-session-btn');
const windowTemplate = document.getElementById('window-template');
const columnSelect = document.getElementById('column-count');
const activeCountEl = document.getElementById('active-count');
const saveMarkdownBtn = document.getElementById('save-markdown-btn');
const closeTabsBtn = document.getElementById('close-tabs-btn');
const undoBtn = document.getElementById('undo-btn');
const redoBtn = document.getElementById('redo-btn');
const traceHistoryToggle = document.getElementById('trace-history');

// Settings Elements
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const undoLimitInput = document.getElementById('undo-limit-input');

// Initialize Settings Logic

const showCardMetaInput = document.getElementById('show-card-meta-input');
const applyCardMetaSetting = (show) => {
  if (show) {
    document.body.classList.remove('hide-card-meta');
  } else {
    document.body.classList.add('hide-card-meta');
  }
}


const closeSettings = () => {
  settingsModal.setAttribute('hidden', '');
};

settingsModal?.addEventListener('click', (e) => {
  if (e.target === settingsModal) {
    closeSettings();
  }
});

settingsBtn?.addEventListener('click', async () => {
  const isHidden = settingsModal.hasAttribute('hidden');

  if (!isHidden) {
    settingsModal.setAttribute('hidden', '');
    return;
  }

  undoLimitInput.disabled = true;
  showCardMetaInput.disabled = true;
  settingsModal.removeAttribute('hidden');

  try {
    const settings = await sendMessage({ type: 'get-settings' });
    if (settings) {
      if (settings.undoLimit) undoLimitInput.value = settings.undoLimit;
      // Default true if undefined
      const showMeta = settings.showCardMeta !== false;
      showCardMetaInput.checked = showMeta;
      applyCardMetaSetting(showMeta);
    }
  } catch (err) {
    console.error('Failed to load settings', err);
    toast('Failed to load settings');
  } finally {
    undoLimitInput.disabled = false;
    showCardMetaInput.disabled = false;
  }
});

saveSettingsBtn?.addEventListener('click', async () => {
  const limit = parseInt(undoLimitInput.value, 10);
  if (isNaN(limit) || limit < 10 || limit > 1000) {
    toast('Please enter a valid limit (10-1000)');
    return;
  }

  const showMeta = showCardMetaInput.checked;

  saveSettingsBtn.disabled = true;
  try {
    await sendMessage({
      type: 'update-settings',
      settings: {
        undoLimit: limit,
        showCardMeta: showMeta
      }
    });
    applyCardMetaSetting(showMeta);
    toast('Settings saved');
    closeSettings();
  } catch (err) {
    console.error('Save settings error:', err);
    toast('Failed to save settings: ' + err.message);
  } finally {
    saveSettingsBtn.disabled = false;
  }
});

// Initial load of settings style
(async () => {
  try {
    const settings = await sendMessage({ type: 'get-settings' });
    if (settings) {
      // Default true
      applyCardMetaSetting(settings.showCardMeta !== false);
    }
  } catch (e) {
    // ignore
  }
})();


let dragContext = null;
let activeWindowsCache = [];
let activeWindowMap = new Map();
let windowDragContext = null;
const WINDOW_ORDER_KEY = 'tab-manager:window-order';

refreshBtn.addEventListener('click', () => loadAll());

// Undo/Redo Logic
async function triggerUndo() {
  try {
    await sendMessage({ type: 'undo' });
    await loadActiveWindows();
    toast('Undone last action');
  } catch (err) {
    if (err.message) toast(err.message);
  }
}

async function triggerRedo() {
  try {
    await sendMessage({ type: 'redo' });
    await loadActiveWindows();
    toast('Redone last action');
  } catch (err) {
    if (err.message) toast(err.message);
  }
}

undoBtn?.addEventListener('click', triggerUndo);
redoBtn?.addEventListener('click', triggerRedo);

document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'z') {
    event.preventDefault();
    if (event.shiftKey) {
      triggerRedo();
    } else {
      triggerUndo();
    }
  }
});
const COLUMN_COUNT_KEY = 'tab-manager:column-count';

columnSelect.addEventListener('change', e => {
  const val = e.target.value;
  document.documentElement.style.setProperty('--column-count', val);
  chrome.storage.local.set({ [COLUMN_COUNT_KEY]: val });
});

// Load saved column count
chrome.storage.local.get([COLUMN_COUNT_KEY]).then(({ [COLUMN_COUNT_KEY]: saved }) => {
  if (saved) {
    columnSelect.value = saved;
    document.documentElement.style.setProperty('--column-count', saved);
  } else {
    document.documentElement.style.setProperty('--column-count', columnSelect.value);
  }
});
saveAllBtn.addEventListener('click', async () => {
  saveAllBtn.disabled = true;
  try {
    const tabIds = await collectAllTabIds();
    if (!tabIds.length) {
      toast('No tabs available to save.');
      return;
    }
    await saveMarkdownForTabIds(tabIds);
  } catch (err) {
    toast(err.message);
  } finally {
    saveAllBtn.disabled = false;
  }
});

saveSessionBtn.addEventListener('click', async () => {
  saveSessionBtn.disabled = true;
  try {
    const checkedWindows = Array.from(document.querySelectorAll("input[data-select-kind='window']:checked"));
    const windowIds = checkedWindows.map(cb => Number(cb.dataset.windowId));

    if (!windowIds.length) {
      toast('Select at least one window to export.');
      return;
    }

    // Collect tabs only from selected windows
    let allTabIds = [];
    // If cache is empty, we might need to load it (edge case), but usually it's there.
    if (!activeWindowsCache.length) {
      activeWindowsCache = await sendMessage({ type: 'get-active' });
      activeWindowMap = new Map(activeWindowsCache.map(w => [w.id, w]));
    }

    windowIds.forEach(wid => {
      const win = activeWindowMap.get(wid);
      if (win && win.tabs) {
        allTabIds.push(...win.tabs.map(t => t.id));
      }
    });

    if (!allTabIds.length) {
      toast('No tabs found in selected windows.');
      return;
    }

    await saveMarkdownForTabIds(allTabIds);
  } catch (err) {
    toast(err.message);
  } finally {
    saveSessionBtn.disabled = false;
  }
});

expandAllBtn.addEventListener('click', () => {
  const cards = document.querySelectorAll('.card');
  cards.forEach(card => {
    const toggleBtn = card.querySelector('.toggle-tabs');
    const list = card.querySelector('.tab-list');
    if (list && list.hasAttribute('hidden')) {
      // Simulate a click on the toggle button to reuse logic (lazy load etc)
      toggleBtn.click();
    }
  });
});

const minimizeAllBtn = document.getElementById('minimize-all-btn');
minimizeAllBtn.addEventListener('click', () => {
  const cards = document.querySelectorAll('.card');
  cards.forEach(card => {
    const toggleBtn = card.querySelector('.toggle-tabs');
    const list = card.querySelector('.tab-list');
    if (list && !list.hasAttribute('hidden')) {
      // Simulate click to collapse
      toggleBtn.click();
    }
  });
});

saveMarkdownBtn.addEventListener('click', async () => {
  const selectedTabIds = Array.from(document.querySelectorAll("input[data-select-kind='tab']:checked"))
    .map(input => Number(input.dataset.tabId))
    .filter(Boolean);
  if (!selectedTabIds.length) {
    toast('Select at least one tab to save.');
    return;
  }
  saveMarkdownBtn.disabled = true;
  try {
    await saveMarkdownForTabIds(selectedTabIds);
  } catch (err) {
    toast(err.message);
  } finally {
    saveMarkdownBtn.disabled = false;
  }
});

closeTabsBtn?.addEventListener('click', async () => {
  const selectedTabIds = Array.from(document.querySelectorAll("input[data-select-kind='tab']:checked"))
    .map(input => Number(input.dataset.tabId))
    .filter(Boolean);

  if (!selectedTabIds.length) {
    toast('Select at least one tab to close.');
    return;
  }

  closeTabsBtn.disabled = true;
  try {
    await sendMessage({ type: 'close-tabs', tabIds: selectedTabIds });
    toast(`${selectedTabIds.length} tab(s) closed.`);
    await loadActiveWindows();
  } catch (err) {
    toast(err.message);
  } finally {
    closeTabsBtn.disabled = false;
  }
});

traceHistoryToggle?.addEventListener('change', () => {
  applyTraceHistory();
});

document.addEventListener('dragover', event => {
  if (dragContext) {
    event.preventDefault();
    handleThrottledDragOver(event);
  }
});

document.addEventListener('dragleave', event => {
  if (dragContext && event.relatedTarget === null) {
    clearDropIndicator();
  }
});

document.addEventListener('dragend', () => {
  // Clean up multi-tab drag operation
  if (dragContext?.kind === 'tabs') {
    // Remove dragging class from all tabs
    document.querySelectorAll('.tab-item.dragging').forEach(el => {
      el.classList.remove('dragging');
    });
  } else {
    // Single element drag operation (existing behavior)
    const draggingElement = document.querySelector('.dragging');
    if (draggingElement) {
      draggingElement.classList.remove('dragging');
    }
  }

  dragContext = null;
  windowDragContext = null;
  clearDropIndicator();
  clearWindowDropIndicator();
});

document.addEventListener('drop', async event => {
  if (!dragContext) return;
  const targetCard = event.target.closest('.card');
  if (targetCard) return;
  event.preventDefault();
  try {
    if (dragContext.kind === 'tab') {
      await sendMessage({ type: 'move-to-new-window', kind: 'tab', tabId: dragContext.tabId });
    } else if (dragContext.kind === 'group') {
      await sendMessage({
        type: 'move-to-new-window',
        kind: 'group',
        groupId: dragContext.groupId,
        windowId: dragContext.windowId,
      });
    }
    await loadActiveWindows();
  } catch (err) {
    toast(err.message);
  } finally {
    dragContext = null;
    clearDropIndicator();
  }
});

async function sendMessage(payload) {
  const response = await chrome.runtime.sendMessage(payload);
  if (!response?.ok) {
    throw new Error(response?.error || 'Unknown extension error');
  }
  return response.data;
}

function activateInlineRename(targetEl, currentValue, onSave) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentValue || '';
  input.className = 'inline-rename';
  targetEl.replaceWith(input);
  input.focus();
  input.select();
  const finalize = async (save) => {
    input.removeEventListener('keydown', handleKey);
    input.removeEventListener('blur', handleBlur);
    const replacement = document.createElement(targetEl.tagName.toLowerCase());
    replacement.className = targetEl.className;
    replacement.textContent = currentValue;
    if (save) {
      const next = input.value.trim();
      if (next && next !== currentValue) {
        try {
          await onSave(next);
          replacement.textContent = next;
        } catch (err) {
          toast(err.message);
        }
      }
    }
    input.replaceWith(replacement);
    if (replacement.classList.contains('clickable')) {
      replacement.addEventListener('click', () => activateInlineRename(replacement, replacement.textContent, onSave));
    }
  };
  const handleKey = (event) => {
    if (event.key === 'Enter') {
      finalize(true);
    } else if (event.key === 'Escape') {
      finalize(false);
    }
  };
  const handleBlur = () => finalize(true);
  input.addEventListener('keydown', handleKey);
  input.addEventListener('blur', handleBlur);
}

async function loadActiveWindows() {
  const sortedWindows = await sendMessage({ type: 'get-ordered-windows-light' });
  activeWindowsCache = sortedWindows;
  activeWindowMap = new Map(sortedWindows.map(w => [w.id, w]));

  activeCountEl.textContent = sortedWindows.length ? `${sortedWindows.length} window(s)` : 'No windows';

  // Granular DOM updates (Efficiency Recommendation #3)
  const existingCards = new Map();
  activeListEl.querySelectorAll('.card').forEach(card => {
    existingCards.set(Number(card.dataset.winId), card);
  });

  // 1. Update or Create
  sortedWindows.forEach((win, index) => {
    let card = existingCards.get(win.id);
    const orderKeyText = `[${index + 1}]`;

    if (card) {
      // Update existing
      const orderKeyEl = card.querySelector('.card-order-key');
      if (orderKeyEl) orderKeyEl.textContent = orderKeyText;

      const titleEl = card.querySelector('.title');
      if (titleEl && titleEl.textContent !== win.title) {
        titleEl.textContent = win.title;
      }

      // Fix for live updates: Refresh content if expanded
      const tabListContainer = card.querySelector('.tab-list');
      if (tabListContainer && tabListContainer.dataset.loaded === 'true' && !tabListContainer.hasAttribute('hidden')) {
        loadWindowDetails(win.id, card);
      }
      existingCards.delete(win.id); // Mark as visited

      // Update order if needed
      activeListEl.appendChild(card);
    } else {
      // Create new
      card = createWindowCard(win);

      const orderKeyEl = card.querySelector('.card-order-key');
      if (orderKeyEl) orderKeyEl.textContent = orderKeyText;

      const titleEl = card.querySelector('.title');
      if (titleEl) titleEl.textContent = win.title;

      activeListEl.appendChild(card);

      // Auto-expand if active (initial load logic, but good to keep consistent)
      if (win.focused) {
        const targetContainer = card.querySelector('.tab-list');
        const toggleButtons = card.querySelectorAll('.toggle-tabs');
        if (targetContainer) {
          targetContainer.removeAttribute('hidden');
          toggleButtons.forEach(btn => {
            btn.classList.remove('collapsed');
            btn.textContent = '▾';
          });
          loadWindowDetails(win.id, card);
        }
      }
    }
  });

  // 2. Remove extra
  existingCards.forEach(card => card.remove());

  applyTraceHistory();
}

function createWindowCard(win) {
  const frag = windowTemplate.content.cloneNode(true);
  const card = frag.querySelector('.card');
  card.dataset.winId = win.id;
  const header = card.querySelector('.card-header');
  header.classList.add('compact-header');
  header.setAttribute('draggable', 'true');
  header.addEventListener('dragstart', handleWindowDragStart);
  header.addEventListener('dragend', handleWindowDragEnd);
  card.addEventListener('dragover', handleWindowDragOver);
  card.addEventListener('drop', handleWindowDrop);
  const windowCheckbox = createSelectCheckbox('window', { windowId: win.id });
  const titleEl = card.querySelector('.title');
  titleEl.textContent = win.title;
  titleEl.classList.add('clickable');
  titleEl.addEventListener('click', () => activateInlineRename(titleEl, win.title, async value => {
    const updatedWindow = await sendMessage({ type: 'rename-window', windowId: win.id, title: value });
    win.title = updatedWindow.title;
  }));
  const metaEl = card.querySelector('.meta');
  metaEl.textContent = `... tabs`; // Placeholder

  const actions = card.querySelector('.card-actions');
  actions.replaceChildren();

  // Create save markdown icon button
  const saveBtn = document.createElement('button');
  saveBtn.className = 'icon-button';
  saveBtn.setAttribute('aria-label', 'Save Markdown');
  saveBtn.textContent = '📥';
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      // Only get checked tabs within this specific window
      const windowTabIds = (win.tabs || []).map(tab => tab.id).filter(Boolean);
      const checkedTabIds = Array.from(card.querySelectorAll("input[data-select-kind='tab']:checked"))
        .map(input => Number(input.dataset.tabId))
        .filter(tabId => windowTabIds.includes(tabId));

      if (!checkedTabIds.length) {
        toast('Select at least one tab in this window to save.');
        return;
      }

      await saveMarkdownForTabIds(checkedTabIds);
    } catch (err) {
      toast(err.message);
    } finally {
      saveBtn.disabled = false;
    }
  });

  // Create close tabs icon button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'icon-button danger';
  closeBtn.setAttribute('aria-label', 'Close Selected Tabs');
  closeBtn.textContent = '🗑️';
  closeBtn.addEventListener('click', async () => {
    closeBtn.disabled = true;
    try {
      // Only get checked tabs within this specific window
      const windowTabIds = (win.tabs || []).map(tab => tab.id).filter(Boolean);
      const checkedTabIds = Array.from(card.querySelectorAll("input[data-select-kind='tab']:checked"))
        .map(input => Number(input.dataset.tabId))
        .filter(tabId => windowTabIds.includes(tabId));

      if (!checkedTabIds.length) {
        toast('Select at least one tab in this window to close.');
        return;
      }

      await sendMessage({ type: 'close-tabs', tabIds: checkedTabIds });
      toast(`${checkedTabIds.length} tab(s) closed.`);
      await loadActiveWindows();
    } catch (err) {
      toast(err.message);
    } finally {
      closeBtn.disabled = false;
    }
  });

  // Create group tabs icon button
  const groupBtn = document.createElement('button');
  groupBtn.className = 'icon-button';
  groupBtn.setAttribute('aria-label', 'Group Selected Tabs');
  groupBtn.textContent = '🏷️';
  groupBtn.addEventListener('click', async () => {
    groupBtn.disabled = true;
    try {
      // Only get checked tabs within this specific window
      const windowTabIds = (win.tabs || []).map(tab => tab.id).filter(Boolean);
      const checkedTabIds = Array.from(card.querySelectorAll("input[data-select-kind='tab']:checked"))
        .map(input => Number(input.dataset.tabId))
        .filter(tabId => windowTabIds.includes(tabId));

      if (!checkedTabIds.length) {
        toast('Select at least one tab in this window to group.');
        return;
      }

      if (checkedTabIds.length === 1) {
        toast('Select at least 2 tabs to create a group.');
        return;
      }

      // Get a random color for the new group
      const colors = ['blue', 'red', 'green', 'yellow', 'pink', 'purple', 'cyan', 'orange'];
      const randomColor = colors[Math.floor(Math.random() * colors.length)];

      await sendMessage({
        type: 'assign-group',
        tabIds: checkedTabIds,
        groupId: 'new',
        windowId: win.id,
        title: 'New Group',
        color: randomColor
      });

      toast(`${checkedTabIds.length} tab(s) grouped.`);
      await loadActiveWindows();
    } catch (err) {
      toast(err.message);
    } finally {
      groupBtn.disabled = false;
    }
  });

  actions.append(saveBtn, groupBtn, closeBtn);
  header.append(windowCheckbox);
  windowCheckbox.addEventListener('change', () => {
    const tabCheckboxes = card.querySelectorAll("input[data-select-kind='tab']");
    tabCheckboxes.forEach(input => {
      input.checked = windowCheckbox.checked;
    });
    const groupCheckboxes = card.querySelectorAll("input[data-select-kind='group']");
    groupCheckboxes.forEach(input => {
      input.checked = windowCheckbox.checked;
      input.indeterminate = false;
    });
  });

  const container = card.querySelector('.tab-list');
  container.classList.add('tab-collection');
  container.replaceChildren(); // Empty for now
  const toggleButtons = card.querySelectorAll('.toggle-tabs');
  toggleButtons.forEach(toggleBtn => {
    toggleBtn.type = 'button';
    toggleBtn.classList.add('collapsed');
    toggleBtn.textContent = '▸';
    toggleBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const targetContainer = card.querySelector('.tab-list');
      if (!targetContainer) return;

      const collapsed = targetContainer.hasAttribute('hidden');
      if (collapsed) {
        targetContainer.removeAttribute('hidden');
        toggleButtons.forEach(btn => {
          btn.classList.remove('collapsed');
          btn.textContent = '▾';
        });
        // Load content if it's not already loaded
        if (!targetContainer.dataset.loaded) {
          loadWindowDetails(win.id, card);
        }
      } else {
        targetContainer.setAttribute('hidden', '');
        toggleButtons.forEach(btn => {
          btn.classList.add('collapsed');
          btn.textContent = '▸';
        });
      }
    });
  });

  // Auto-expand if window is focused
  if (win.focused) {
    const targetContainer = card.querySelector('.tab-list');
    if (targetContainer) {
      targetContainer.removeAttribute('hidden');
      toggleButtons.forEach(btn => {
        btn.classList.remove('collapsed');
        btn.textContent = '▾';
      });
      // Load content immediately
      loadWindowDetails(win.id, card);
    }
  }

  container.dataset.windowId = win.id;
  container.addEventListener('drop', handleGroupContainerDrop);

  return frag;
}

async function loadWindowDetails(windowId, card) {
  const container = card.querySelector('.tab-list');
  // Only show loading if we don't have content, to prevent flash on reload
  if (!container.hasChildNodes()) {
    container.textContent = 'Loading...';
  }
  try {
    const win = await sendMessage({ type: 'get-window-details', windowId });

    // Update the main cache
    const cachedWindow = activeWindowsCache.find(w => w.id === windowId);
    if (cachedWindow) {
      cachedWindow.tabs = win.tabs;
      cachedWindow.groups = win.groups;
    }

    const metaEl = card.querySelector('.meta');
    metaEl.textContent = `${win.tabs.length} tab(s)`;

    container.innerHTML = '';
    buildWindowSections(win).forEach(section => {
      if (section.type === 'group') {
        container.appendChild(renderGroupSection(win, section.group, section.tabs));
      } else if (section.type === 'tab') {
        container.appendChild(renderSingleTabRow(win, section.tab));
      }
    });
    container.dataset.loaded = 'true';
    applyTraceHistory();
  } catch (err) {
    container.textContent = `Error: ${err.message}`;
  }
}


async function loadWindowOrder() {
  try {
    const { [WINDOW_ORDER_KEY]: order = [] } = await chrome.storage.local.get(WINDOW_ORDER_KEY);
    return Array.isArray(order) ? order : [];
  } catch (err) {
    return [];
  }
}

async function saveWindowOrder(order) {
  try {
    await chrome.storage.local.set({ [WINDOW_ORDER_KEY]: order });
  } catch (err) {
    console.warn('Failed to save window order', err);
  }
}

function sortWindowsByOrder(windows, order) {
  if (!order.length) {
    return windows;
  }
  const indexById = new Map(order.map((id, index) => [id, index]));
  return [...windows].sort((a, b) => {
    const aIndex = indexById.get(a.id);
    const bIndex = indexById.get(b.id);
    if (aIndex === undefined && bIndex === undefined) return 0;
    if (aIndex === undefined) return 1;
    if (bIndex === undefined) return -1;
    return aIndex - bIndex;
  });
}

function persistWindowOrderFromDom() {
  const cards = Array.from(activeListEl.querySelectorAll('.card'));
  const order = cards
    .map(card => Number(card.dataset.winId))
    .filter(Boolean);
  saveWindowOrder(order);

  // Update prefixes
  // Update prefixes
  cards.forEach((card, index) => {
    // Update the separate order key element
    const orderKeyEl = card.querySelector('.card-order-key');
    if (orderKeyEl) {
      orderKeyEl.textContent = `[${index + 1}]`;
    }

    const titleEl = card.querySelector('.title');
    const winId = Number(card.dataset.winId);
    const win = activeWindowMap.get(winId);
    if (titleEl && win) {
      // win.title is the source of truth for the NAME. 
      // We no longer prepend [N] here.
      if (titleEl.textContent !== win.title) {
        titleEl.textContent = win.title;
      }
    }
  });

  // activeWindowMap is already efficient
  const reordered = order.map(id => activeWindowMap.get(id)).filter(Boolean);
  const missing = activeWindowsCache.filter(win => !order.includes(win.id));
  activeWindowsCache = reordered.concat(missing);
}

function handleWindowDragStart(event) {
  if (dragContext) {
    return;
  }
  const card = event.currentTarget.closest('.card');
  if (!card) {
    return;
  }
  windowDragContext = { windowId: Number(card.dataset.winId) };
  event.dataTransfer?.setData('text/plain', `window:${card.dataset.winId}`);
  event.dataTransfer.effectAllowed = 'move';
  card.classList.add('dragging');
}

// Helper to find closest card when dragging over container
function getClosestCard(y) {
  const cards = [...activeListEl.querySelectorAll('.card:not(.dragging)')];
  return cards.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      return { offset: offset, element: child };
    } else {
      return closest;
    }
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

const throttledWindowDragOverLogic = throttle((event) => {
  // Support both window reordering AND dropping tabs/groups to create new windows
  if (!windowDragContext && !dragContext) return;

  let targetCard = event.target.closest('.card');
  const isContainer = event.target === activeListEl || event.target.closest('#active-list');

  // If over container gap, find closest card
  if (!targetCard && isContainer) {
    const closest = getClosestCard(event.clientY);
    if (closest) {
      targetCard = closest;
    } else {
      // If no closest (e.g. at bottom), default to last card?
      const cards = activeListEl.querySelectorAll('.card');
      if (cards.length) targetCard = cards[cards.length - 1];
    }
  }

  if (!targetCard) {
    clearWindowDropIndicator();
    return;
  }

  const targetId = Number(targetCard.dataset.winId);

  // If dragging a window, don't show indicator on self
  if (windowDragContext && targetId === windowDragContext.windowId) {
    return;
  }

  // If dragging a tab/group, we SHOULD show indicator on any window card (to insert before/after)
  // But wait, usually dropping ON a card means "add to this window".
  // Dropping IN BETWEEN cards means "create new window here".
  // So we need to distinct visual feedback? 
  // actually, let's treat "dropping on edge" as "new window".

  const rect = targetCard.getBoundingClientRect();
  const midX = rect.left + rect.width / 2;
  const midY = rect.top + rect.height / 2;
  const mouseX = event.clientX;
  const mouseY = event.clientY;

  let before = false;
  if (mouseY < rect.top) {
    before = true;
  } else if (mouseY > rect.bottom) {
    before = false;
  } else {
    before = mouseX < midX;
  }

  updateWindowDropIndicator(targetCard, before);
}, 50);

function handleWindowDragEnd(event) {
  const card = event.target.closest('.card');
  if (card) {
    card.classList.remove('dragging');
  }
  windowDragContext = null;
  clearWindowDropIndicator();
}

function handleWindowDragOver(event) {
  event.preventDefault(); // Mandatory for drop
  event.dataTransfer.dropEffect = 'move';
  throttledWindowDragOverLogic(event);
}

function handleWindowDrop(event) {
  if (!windowDragContext && !dragContext) {
    return;
  }
  event.preventDefault();

  let targetCard = event.target.closest('.card');
  const isContainer = event.target === activeListEl || event.target.closest('#active-list');

  if (!targetCard && isContainer) {
    // Re-calculate simply similar to dragover
    const closest = getClosestCard(event.clientY);
    if (closest) targetCard = closest;
    else {
      const cards = activeListEl.querySelectorAll('.card');
      if (cards.length) targetCard = cards[cards.length - 1];
    }
  }

  // Determine drop position (before/after targetCard)
  let before = false;
  if (targetCard) {
    const rect = targetCard.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    const mouseY = event.clientY;
    const mouseX = event.clientX;

    if (mouseY < rect.top) before = true;
    else if (mouseY > rect.bottom) before = false;
    else before = mouseX < midX;
  }

  clearWindowDropIndicator();

  // Scenario 1: Reordering Windows
  if (windowDragContext) {
    const sourceCard = activeListEl.querySelector(`.card[data-win-id='${windowDragContext.windowId}']`);
    if (!sourceCard || !targetCard || sourceCard === targetCard) {
      return;
    }
    moveElement(sourceCard, targetCard, before);
    persistWindowOrderFromDom();
    return;
  }

  // Scenario 2: Dropping Tabs/Groups to create NEW Window
  if (dragContext && targetCard) {
    // We are dropping tabs/groups "between" windows to create a new one.
    // Calculate insert index.
    const targetCardIndex = Array.from(activeListEl.children).indexOf(targetCard);
    // If before, index is targetCardIndex. If after, index is targetCardIndex + 1.
    const newIndex = before ? targetCardIndex : targetCardIndex + 1;

    // Delegate to handleMoveToNewWindow or similar logic
    // existing logic: handleMoveToNewWindow(items, newIndex) ? 
    // We can reuse the message 'move-to-new-window' passing tabIds or groupId

    const items = dragContext.tabIds || (dragContext.groupId ? { groupId: dragContext.groupId } : null);
    if (!items) return; // Should not happen

    // Call backend to create window
    (async () => {
      try {
        let newWindow;
        if (dragContext.type === 'group') {
          newWindow = await sendMessage({
            type: 'move-group-to-new-window',
            groupId: dragContext.groupId
          });
        } else {
          // Tabs
          newWindow = await sendMessage({
            type: 'move-to-new-window',
            tabIds: dragContext.tabIds
          });
        }

        if (newWindow) {
          // Now we need to insert this new window into our CUSTOM order at newIndex
          // 1. Get current order
          const order = await loadWindowOrder(); // or get from DOM
          // Actually DOM is most up to date usually?
          const currentDomOrder = Array.from(activeListEl.querySelectorAll('.card'))
            .map(c => Number(c.dataset.winId));

          // Insert newWindow.id at newIndex
          currentDomOrder.splice(newIndex, 0, newWindow.id);

          await saveWindowOrder(currentDomOrder);

          // Reload
          loadActiveWindows();
          toast('Created new window');
        }
      } catch (err) {
        console.error('Failed to create new window from drop', err);
        toast('Failed to create window');
      }
    })();
  }
}

function buildWindowSections(win) {
  const sections = [];
  const orderedTabs = [...win.tabs].sort((a, b) => a.index - b.index);
  const groupTabs = new Map();
  orderedTabs.forEach(tab => {
    if (tab.groupId >= 0) {
      const list = groupTabs.get(tab.groupId) || [];
      list.push(tab);
      groupTabs.set(tab.groupId, list);
    }
  });
  const processedGroupIds = new Set();
  orderedTabs.forEach(tab => {
    if (tab.groupId >= 0) {
      if (processedGroupIds.has(tab.groupId)) {
        return;
      }
      processedGroupIds.add(tab.groupId);
      const info =
        win.groups.find(group => group.id === tab.groupId) || {
          id: tab.groupId,
          title: 'Group',
          color: 'blue',
          collapsed: false,
        };
      sections.push({ type: 'group', group: info, tabs: groupTabs.get(tab.groupId) || [] });
    } else {
      sections.push({ type: 'tab', tab });
    }
  });
  return sections;
}

function renderGroupSection(win, group, tabs) {
  const section = document.createElement('div');
  section.className = 'group-section grouped';
  section.dataset.groupId = group.id;
  section.dataset.windowId = win.id;
  section.style.setProperty('--group-color', colorToHex(group.color));

  const header = document.createElement('div');
  header.className = 'group-header';
  header.dataset.dropTarget = 'group';
  header.dataset.groupId = group.id;
  header.dataset.windowId = win.id;
  header.addEventListener('drop', handleGroupDrop);
  header.draggable = true;
  header.addEventListener('dragstart', handleGroupChipDragStart);

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'toggle-tabs';
  toggleBtn.type = 'button';
  toggleBtn.setAttribute('aria-label', 'Toggle group tabs');
  toggleBtn.textContent = group.collapsed ? '▸' : '▾';
  const toggleBtnRight = document.createElement('button');
  toggleBtnRight.className = 'toggle-tabs toggle-tabs-right';
  toggleBtnRight.type = 'button';
  toggleBtnRight.setAttribute('aria-label', 'Toggle group tabs');
  toggleBtnRight.textContent = group.collapsed ? '▸' : '▾';

  const chip = document.createElement('span');
  chip.className = 'group-chip';
  chip.textContent = group.title;
  chip.style.setProperty('--group-color', colorToHex(group.color));
  chip.addEventListener('click', () => activateInlineRename(chip, group.title, async value => {
    const updatedGroup = await sendMessage({ type: 'rename-group', groupId: group.id, title: value });
    group.title = updatedGroup.title || value;
  }));
  chip.draggable = true;
  chip.addEventListener('dragstart', handleGroupChipDragStart);


  const groupCount = document.createElement('span');
  groupCount.className = 'group-count';
  groupCount.textContent = `${tabs.length} ${tabs.length === 1 ? 'tab' : 'tabs'}`;
  const groupCheckbox = createSelectCheckbox('group', { windowId: win.id, groupId: group.id });
  header.append(toggleBtn);
  header.append(chip);
  header.append(groupCount);
  header.append(groupCheckbox);
  header.append(toggleBtnRight);
  groupCheckbox.addEventListener('change', () => {
    section.querySelectorAll("input[data-select-kind='tab']").forEach(input => {
      input.checked = groupCheckbox.checked;
    });
    const card = section.closest('.card');
    if (card) {
      updateWindowCheckboxState(card);
    }
  });
  section.appendChild(header);
  const list = renderTabList(win, tabs);
  list.style.setProperty('--group-color', colorToHex(group.color));
  if (group.collapsed) {
    list.setAttribute('hidden', '');
  }
  const toggleButtons = [toggleBtn, toggleBtnRight];
  toggleButtons.forEach(button => {
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const collapsed = list.hasAttribute('hidden');
      if (collapsed) {
        list.removeAttribute('hidden');
        toggleButtons.forEach(btn => {
          btn.classList.remove('collapsed');
          btn.textContent = '▾';
        });
      } else {
        list.setAttribute('hidden', '');
        toggleButtons.forEach(btn => {
          btn.classList.add('collapsed');
          btn.textContent = '▸';
        });
      }
    });
  });
  const startIndex = tabs.length ? Math.min(...tabs.map(t => t.index)) : 0;
  const endIndex = tabs.length ? Math.max(...tabs.map(t => t.index)) : startIndex;
  section.dataset.groupStartIndex = String(startIndex);
  section.dataset.groupEndIndex = String(endIndex);
  section.addEventListener('drop', handleGroupSectionDrop);
  section.appendChild(list);
  return section;
}

function renderTabList(win, tabs) {
  const list = document.createElement('ul');
  list.className = 'tab-list-inner';
  if (!tabs.length) {
    const empty = document.createElement('li');
    empty.className = 'tab-item muted';
    empty.textContent = 'No tabs';
    list.appendChild(empty);
    return list;
  }
  tabs.forEach(tab => {
    list.appendChild(createTabItem(win, tab));
  });

  return list;
}

function renderSingleTabRow(win, tab) {
  const wrapper = document.createElement('ul');
  wrapper.className = 'tab-list-inner single';
  wrapper.dataset.windowId = win.id;
  wrapper.dataset.index = tab.index;
  wrapper.addEventListener('drop', handleTabbedRowDrop);
  wrapper.appendChild(createTabItem(win, tab));
  return wrapper;
}

function createTabItem(win, tab) {
  const item = document.createElement('li');
  item.className = 'tab-item';
  item.dataset.windowId = win.id;
  item.dataset.tabId = tab.id;
  item.dataset.index = tab.index;
  item.dataset.lastAccessed = typeof tab.lastAccessed === 'number' ? String(tab.lastAccessed) : '0';
  if (tab.groupId > -1) {
    item.dataset.groupId = tab.groupId;
  }
  const icon = document.createElement('img');
  icon.className = 'tab-icon';
  const iconUrl = getFaviconUrl(tab);
  icon.src = iconUrl;
  if (!iconUrl) {
    icon.style.visibility = 'hidden';
  }
  icon.onerror = () => (icon.style.visibility = 'hidden');
  const label = document.createElement('span');
  label.className = 'tab-title';
  const titleButton = document.createElement('button');
  titleButton.type = 'button';
  titleButton.className = 'tab-link-text';
  titleButton.textContent = tab.title;
  label.appendChild(titleButton);
  const tabCheckbox = createSelectCheckbox('tab', { windowId: win.id, groupId: tab.groupId, tabId: tab.id });
  const urlEl = document.createElement('span');
  urlEl.className = 'tab-url';
  const urlButton = document.createElement('button');
  urlButton.type = 'button';
  urlButton.className = 'tab-link-text';
  urlButton.textContent = tab.url || '';
  urlEl.appendChild(urlButton);

  item.append(icon, label);

  // Audio Indicator
  if (tab.audible) {
    const audioIndicator = document.createElement('div');
    audioIndicator.className = 'tab-audio-indicator';
    audioIndicator.textContent = '🔊';
    audioIndicator.title = 'Playing audio';

    // Optional: click to mute? (Requires permission/backend support)
    // For now purely visual.

    item.appendChild(audioIndicator);
  }

  item.append(urlEl, tabCheckbox);

  if (tab.pinned) {
    item.classList.add('pinned');
    item.setAttribute('draggable', 'false');
  } else {
    item.setAttribute('draggable', 'true');
  }

  item.addEventListener('dragstart', handleTabDragStart);

  item.addEventListener('drop', handleTabDrop);
  const focusTab = async event => {
    event.stopPropagation();
    try {
      await sendMessage({ type: 'focus-tab', tabId: tab.id });
    } catch (err) {
      toast(err.message);
    }
  };
  titleButton.addEventListener('click', focusTab);
  urlButton.addEventListener('click', focusTab);
  item.addEventListener('mouseenter', event => {
    scheduleTabTooltip(event, tab);
  });
  item.addEventListener('mousemove', event => {
    updateTabTooltipPosition(event);
  });
  item.addEventListener('mouseleave', () => {
    hideTabTooltip();
  });
  tabCheckbox.addEventListener('change', () => {
    if (tabCheckbox.checked) {
      item.classList.add('selected');
    } else {
      item.classList.remove('selected');
    }
    const section = item.closest('.group-section');
    if (section) {
      updateGroupCheckboxState(section);
    }
    const card = item.closest('.card');
    if (card) {
      updateWindowCheckboxState(card);
    }
  });
  // Initial state
  if (tabCheckbox.checked) {
    item.classList.add('selected');
  }

  return item;
}

function applyTraceHistory() {
  const items = Array.from(document.querySelectorAll('.tab-item')).filter(item => !item.classList.contains('muted'));
  if (!traceHistoryToggle?.checked) {
    items.forEach(item => {
      item.style.backgroundColor = '';
    });
    return;
  }
  const ranked = items
    .map(item => ({
      item,
      lastAccessed: Number(item.dataset.lastAccessed) || 0,
    }))
    .sort((a, b) => b.lastAccessed - a.lastAccessed);
  const total = ranked.length;
  ranked.forEach((entry, index) => {
    const ratio = total > 1 ? index / (total - 1) : 0;
    entry.item.style.backgroundColor = interpolateHistoryColor(ratio);
  });
}

function interpolateHistoryColor(ratio) {
  const start = [255, 255, 255];
  const end = [118, 118, 118];
  return rgbToString(lerpRgb(start, end, ratio));
}

function lerpRgb(from, to, t) {
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
  ];
}

function rgbToString(rgb) {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

const tabTooltip = document.createElement('div');
tabTooltip.className = 'tab-tooltip';
const tabTooltipTitle = document.createElement('div');
tabTooltipTitle.className = 'tab-tooltip-title';
const tabTooltipUrl = document.createElement('div');
tabTooltipUrl.className = 'tab-tooltip-url';
tabTooltip.append(tabTooltipTitle, tabTooltipUrl);
document.body.appendChild(tabTooltip);

let tooltipTimer = null;
let tooltipVisible = false;
let tooltipAnchor = null;

function scheduleTabTooltip(event, tab) {
  tooltipAnchor = { title: tab.title || 'Untitled', url: tab.url || '' };
  if (tooltipTimer) {
    clearTimeout(tooltipTimer);
  }
  tooltipTimer = setTimeout(() => {
    if (!tooltipAnchor) {
      return;
    }
    tabTooltipTitle.textContent = tooltipAnchor.title;
    tabTooltipUrl.textContent = tooltipAnchor.url;
    tabTooltip.style.display = 'block';
    tooltipVisible = true;
    updateTabTooltipPosition(event);
  }, 600);
}

function updateTabTooltipPosition(event) {
  if (!tooltipVisible) {
    return;
  }
  const offset = 12;
  const x = event.clientX + offset;
  const y = event.clientY + offset;
  tabTooltip.style.left = `${x}px`;
  tabTooltip.style.top = `${y}px`;
}

function hideTabTooltip() {
  if (tooltipTimer) {
    clearTimeout(tooltipTimer);
    tooltipTimer = null;
  }
  tooltipAnchor = null;
  if (tooltipVisible) {
    tabTooltip.style.display = 'none';
    tooltipVisible = false;
  }
}

function createSelectCheckbox(kind, { windowId, groupId, tabId }) {
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = kind === 'tab' ? 'tab-select' : 'select-checkbox';
  checkbox.dataset.selectKind = kind;
  checkbox.dataset.windowId = windowId;
  if (typeof groupId === 'number' && groupId >= 0) {
    checkbox.dataset.groupId = groupId;
  }
  if (typeof tabId === 'number') {
    checkbox.dataset.tabId = tabId;
  }
  checkbox.addEventListener('click', event => event.stopPropagation());
  checkbox.addEventListener('mousedown', event => event.stopPropagation());
  return checkbox;
}

function updateWindowCheckboxState(card) {
  const windowCheckbox = card.querySelector("input[data-select-kind='window']");
  const tabCheckboxes = card.querySelectorAll("input[data-select-kind='tab']");
  const total = tabCheckboxes.length;
  const checked = Array.from(tabCheckboxes).filter(input => input.checked).length;
  if (!windowCheckbox) {
    return;
  }
  windowCheckbox.checked = total > 0 && checked === total;
  windowCheckbox.indeterminate = checked > 0 && checked < total;
}

function updateGroupCheckboxState(section) {
  const groupCheckbox = section.querySelector("input[data-select-kind='group']");
  const tabCheckboxes = section.querySelectorAll("input[data-select-kind='tab']");
  const total = tabCheckboxes.length;
  const checked = Array.from(tabCheckboxes).filter(input => input.checked).length;
  if (!groupCheckbox) {
    return;
  }
  groupCheckbox.checked = total > 0 && checked === total;
  groupCheckbox.indeterminate = checked > 0 && checked < total;
}

function getFaviconUrl(tab) {
  if (tab.favicon) {
    return tab.favicon;
  }
  const url = tab.url || tab.pendingUrl;
  if (url.includes('window_end_marker')) {
    return '';
  }
  const fallback = 'chrome://favicon/size/16@2x/';
  // Use protocol check or just try/catch
  if (url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('about:')) {
    // These might not work with the chrome://favicon/ approach directly or might need permissions depending on browser
    // But usually standard favicon fetch works for valid URLs.
    // If it fails, the img onerror below handles it.
  }
  if (!url) {
    return '';
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'chrome-extension:') {
      return `${fallback}${parsed.origin}`;
    }
    return '';
  } catch (err) {
    return '';
  }
}

function updateDropIndicator(target, before, isGroup) {
  const rect = target.getBoundingClientRect();
  dropIndicator.style.width = `${rect.width}px`;
  dropIndicator.style.left = `${rect.left}px`;
  dropIndicator.style.top = before ? `${rect.top}px` : `${rect.bottom}px`;
  if (!dropIndicator.isConnected) {
    document.body.appendChild(dropIndicator);
  }
  if (dropIndicatorTimer) {
    clearTimeout(dropIndicatorTimer);
  }
  dropIndicatorTimer = setTimeout(() => {
    clearDropIndicator();
  }, 1000);
}

const handleThrottledDragOver = throttle(event => {
  if (!dragContext) return;
  const target = event.target.closest('.tab-item, .group-section, .tab-list-inner.single, .group-header, .tab-collection');
  if (!target) {
    clearDropIndicator();
    return;
  }
  const isGroup = dragContext.kind === 'group';
  const isMultiTab = dragContext.kind === 'tabs';
  const rect = target.getBoundingClientRect();
  const before = event.clientY < rect.top + rect.height / 2;
  if (isGroup) {
    if (target.matches('.tab-item')) {
      const parentGroup = target.closest('.group-section');
      if (parentGroup && Number(parentGroup.dataset.groupId) === dragContext.groupId) {
        clearDropIndicator();
        return;
      }
      updateDropIndicator(target, before, true);
    } else if (target.matches('.group-section')) {
      if (Number(target.dataset.groupId) === dragContext.groupId) {
        clearDropIndicator();
        return;
      }
      updateDropIndicator(target, before, true);
    } else if (target.matches('.tab-list-inner.single')) {
      updateDropIndicator(target, before, true);
    } else if (target.matches('.group-header')) {
      const parentSection = target.closest('.group-section');
      if (parentSection && Number(parentSection.dataset.groupId) === dragContext.groupId) {
        clearDropIndicator();
        return;
      }
      updateDropIndicator(target, true, true);
    }
  } else {
    // Dragging a tab or multiple tabs
    if (target.matches('.tab-item')) {
      // For multi-tab drag, don't prevent drop if one of the dragged tabs matches the target
      if (!isMultiTab && Number(target.dataset.tabId) === dragContext.tabId) {
        clearDropIndicator();
        return;
      }
      updateDropIndicator(target, before, false);
    } else if (target.matches('.group-section')) {
      // For group sections, show indicator based on drop position relative to the group
      updateDropIndicator(target, before, false);
    } else if (target.matches('.group-header')) {
      updateDropIndicator(target, before, false);
    } else if (target.matches('.tab-collection')) {
      // Handle dragging over the tab collection container
      const firstChild = target.firstChild;
      if (firstChild) {
        const firstRect = firstChild.getBoundingClientRect();
        const droppingAtTop = event.clientY < firstRect.top + firstRect.height / 2;
        if (droppingAtTop) {
          // Show indicator at the very top
          updateDropIndicator(target, true, false);
        } else {
          // Show indicator at the very bottom
          const lastChild = target.lastChild;
          if (lastChild) {
            const lastRect = lastChild.getBoundingClientRect();
            const droppingAtBottom = event.clientY > lastRect.bottom - lastRect.height / 2;
            if (droppingAtBottom) {
              updateDropIndicator(target, false, false);
            } else {
              clearDropIndicator();
            }
          }
        }
      } else {
        // Empty collection - show indicator in the middle
        updateDropIndicator(target, true, false);
      }
    }
  }
}, 100);

function handleTabDragStart(event) {
  const { tabId, windowId, groupId } = event.currentTarget.dataset;

  // Check if this is a multi-tab drag operation
  const checkedTabIds = Array.from(document.querySelectorAll("input[data-select-kind='tab']:checked"))
    .map(input => Number(input.dataset.tabId))
    .filter(Boolean);

  if (checkedTabIds.length > 1 && checkedTabIds.includes(Number(tabId))) {
    // Multi-tab drag operation
    dragContext = {
      kind: 'tabs',
      tabIds: checkedTabIds,
      windowId: Number(windowId),
      sourceWindowId: Number(windowId),
      groupId: Number(groupId)
    };
    event.dataTransfer?.setData('text/plain', `tabs:${checkedTabIds.join(',')}`);

    // Highlight all checked tabs during drag and set drag count
    checkedTabIds.forEach((checkedTabId, index) => {
      const tabElement = document.querySelector(`.tab-item[data-tab-id='${checkedTabId}']`);
      if (tabElement) {
        tabElement.classList.add('dragging');
        // Only show count on the first tab to avoid visual clutter
        if (index === 0) {
          tabElement.setAttribute('data-drag-count', checkedTabIds.length);
        } else {
          tabElement.removeAttribute('data-drag-count');
        }
      }
    });
  } else {
    // Single tab drag operation (existing behavior)
    dragContext = { kind: 'tab', tabId: Number(tabId), windowId: Number(windowId), groupId: Number(groupId) };
    event.dataTransfer?.setData('text/plain', tabId);
    event.dataTransfer?.setDragImage(event.currentTarget, 0, 0);
    event.currentTarget.classList.add('dragging');
    event.currentTarget.removeAttribute('data-drag-count');
  }
}

function handleGroupChipDragStart(event) {
  const section = event.currentTarget.closest('.group-section');
  if (!section) return;
  const groupId = Number(section.dataset.groupId);
  const windowId = Number(section.dataset.windowId);
  dragContext = { kind: 'group', groupId, windowId, sourceGroupId: groupId };
  event.dataTransfer?.setData('text/plain', String(groupId));
  event.currentTarget.classList.add('dragging');
}

const dropIndicator = document.createElement('div');
dropIndicator.className = 'drop-indicator';
const dropState = { visible: false, windowId: null, tabId: null, groupId: null, before: true, target: null, type: null };
let dropIndicatorTimer = null;
const windowDropIndicator = document.createElement('div');
windowDropIndicator.className = 'window-drop-indicator';

function clearDropIndicator() {
  if (dropIndicator.isConnected) {
    dropIndicator.remove();
  }
  if (dropIndicatorTimer) {
    clearTimeout(dropIndicatorTimer);
    dropIndicatorTimer = null;
  }
  if (dropState.target) {
    dropState.target.classList.remove('drop-target-active');
  }
  dropState.visible = false;
  dropState.windowId = null;
  dropState.tabId = null;
  dropState.groupId = null;
  dropState.before = true;
  dropState.target = null;
  dropState.type = null;
}

function updateWindowDropIndicator(target, before) {
  const rect = target.getBoundingClientRect();
  const height = 100; // Large target area
  const gap = 20; // Visual gap reference

  windowDropIndicator.style.width = `${rect.width}px`;
  windowDropIndicator.style.left = `${rect.left}px`;

  // Position "in between"
  windowDropIndicator.style.height = `${height}px`;

  if (before) {
    windowDropIndicator.style.top = `${rect.top - height / 2}px`;
  } else {
    windowDropIndicator.style.top = `${rect.bottom - height / 2}px`;
  }
  if (!windowDropIndicator.isConnected) {
    document.body.appendChild(windowDropIndicator);
  }
}

function clearWindowDropIndicator() {
  if (windowDropIndicator.isConnected) {
    windowDropIndicator.remove();
  }
}

function moveElement(element, target, before) {
  if (!element || !target) return;
  if (before) {
    target.parentNode.insertBefore(element, target);
  } else {
    target.parentNode.insertBefore(element, target.nextSibling);
  }
}


async function handleTabDrop(event) {
  if (!dragContext) {
    return;
  }
  event.preventDefault();
  clearDropIndicator();

  const { kind, tabId, tabIds, windowId: sourceWindowId, groupId: sourceGroupId } = dragContext;
  const targetEl = event.target.closest('.tab-item, .group-header, .tab-list-inner.single, .group-section');
  if (!targetEl) return;

  const targetWindowId = Number(targetEl.closest('.card').dataset.winId);

  // Handle dropping a tab or multiple tabs
  if (kind === 'tab' || kind === 'tabs') {
    const isMultiTab = kind === 'tabs';
    const tabIdsToMove = isMultiTab ? tabIds : [tabId];

    let newIndex = -1;
    let newGroupId = undefined;

    if (targetEl.matches('.tab-item')) {
      const rect = targetEl.getBoundingClientRect();
      const before = event.clientY < rect.top + rect.height / 2;
      newIndex = Number(targetEl.dataset.index) + (before ? 0 : 1);
      const targetGroupId = targetEl.closest('.group-section')?.dataset.groupId;
      newGroupId = targetGroupId === undefined ? -1 : Number(targetGroupId);

      // For multi-tab drag, we don't move elements in UI since we'll reload
      if (!isMultiTab) {
        const sourceTabEl = document.querySelector(`.tab-item[data-tab-id='${tabId}']`);
        if (sourceTabEl) {
          moveElement(sourceTabEl.closest('ul'), targetEl.closest('ul'), before);
        }
      }
    } else if (targetEl.matches('.group-header')) {
      newGroupId = Number(targetEl.dataset.groupId);
      // For multi-tab drag, we don't move elements in UI since we'll reload
      if (!isMultiTab) {
        const sourceTabEl = document.querySelector(`.tab-item[data-tab-id='${tabId}']`);
        if (sourceTabEl) {
          const list = targetEl.parentElement.querySelector('.tab-list-inner');
          list.appendChild(sourceTabEl.closest('ul'));
        }
      }
    } else if (targetEl.matches('.tab-list-inner.single')) {
      const rect = targetEl.getBoundingClientRect();
      const before = event.clientY < rect.top + rect.height / 2;
      newIndex = Number(targetEl.dataset.index) + (before ? 0 : 1);
      newGroupId = -1;

      // For multi-tab drag, we don't move elements in UI since we'll reload
      if (!isMultiTab) {
        const sourceTabEl = document.querySelector(`.tab-item[data-tab-id='${tabId}']`);
        if (sourceTabEl) {
          moveElement(sourceTabEl.closest('ul'), targetEl, before);
        }
      }
    } else if (targetEl.matches('.group-section')) {
      // Handle dropping on a group section - this fixes the issue with groups at first position
      const rect = targetEl.getBoundingClientRect();
      const before = event.clientY < rect.top + rect.height / 2;

      if (before) {
        // Drop before the group - use the group's start index
        newIndex = Number(targetEl.dataset.groupStartIndex);
        newGroupId = -1; // Ungrouped position before the group
      } else {
        // Drop after the group - use the group's end index + 1
        newIndex = Number(targetEl.dataset.groupEndIndex) + 1;
        newGroupId = -1; // Ungrouped position after the group
      }
    } else if (targetEl.matches('.tab-collection')) {
      // Handle dropping directly on the tab collection (when no other targets are available)
      // This allows dropping at the very beginning or end of the window
      const firstChild = targetEl.firstChild;
      if (!firstChild) {
        // Empty collection - drop at position 0
        newIndex = 0;
        newGroupId = -1;
      } else {
        // Check if we're dropping near the top (before first element)
        const firstRect = firstChild.getBoundingClientRect();
        const droppingAtTop = event.clientY < firstRect.top + firstRect.height / 2;

        if (droppingAtTop) {
          // Drop at the very beginning
          if (firstChild.matches('.group-section')) {
            // First element is a group - drop before it
            newIndex = Number(firstChild.dataset.groupStartIndex);
          } else {
            // First element is a tab - drop at index 0
            newIndex = 0;
          }
          newGroupId = -1;
        } else {
          // Drop at the very end
          const lastChild = targetEl.lastChild;
          const lastRect = lastChild.getBoundingClientRect();
          if (lastChild.matches('.group-section')) {
            // Last element is a group - drop after it
            newIndex = Number(lastChild.dataset.groupEndIndex) + 1;
          } else {
            // Last element is a tab - drop after it
            newIndex = Number(lastChild.dataset.index) + 1;
          }
          newGroupId = -1;
        }
      }
    }

    try {
      if (typeof newGroupId === 'number' && !Number.isNaN(newGroupId)) {
        // Only change group if it's different from source group
        const shouldChangeGroup = isMultiTab
          ? tabIdsToMove.some(tabId => {
            const tabElement = document.querySelector(`.tab-item[data-tab-id='${tabId}']`);
            const currentGroupId = tabElement?.dataset.groupId ? Number(tabElement.dataset.groupId) : -1;
            return currentGroupId !== newGroupId;
          })
          : newGroupId !== sourceGroupId;

        if (shouldChangeGroup) {
          await sendMessage({ type: 'assign-group', tabIds: tabIdsToMove, groupId: newGroupId, windowId: targetWindowId });
        }
      }

      // Move tabs to new position
      if (typeof newIndex === 'number' && !Number.isNaN(newIndex)) {
        // For multi-tab drag, move all tabs to the same position
        for (const currentTabId of tabIdsToMove) {
          await sendMessage({ type: 'move-tab', tabId: currentTabId, windowId: targetWindowId, index: newIndex });
          // Increment index for subsequent tabs to maintain order
          newIndex++;
        }
      }

      // Update local cache for single tab moves between windows
      if (!isMultiTab && sourceWindowId !== targetWindowId && typeof newIndex === 'number') {
        const sourceWindow = activeWindowsCache.find(w => w.id === sourceWindowId);
        const targetWindow = activeWindowsCache.find(w => w.id === targetWindowId);
        if (sourceWindow && targetWindow) {
          const tabToMove = sourceWindow.tabs.find(t => t.id === tabId);
          sourceWindow.tabs = sourceWindow.tabs.filter(t => t.id !== tabId);
          targetWindow.tabs.splice(newIndex, 0, tabToMove);
        }
      }

      await loadActiveWindows();
      selectTabs(tabIdsToMove);
    } catch (err) {
      toast(err.message);
      await loadActiveWindows();
    }
  }

  // Handle dropping a group
  else if (kind === 'group') {
    const sourceGroupEl = document.querySelector(`.group-section[data-group-id='${sourceGroupId}']`);
    if (!sourceGroupEl) return;

    let newIndex = -1;
    if (targetEl.matches('.tab-item') || targetEl.matches('.tab-list-inner.single')) {
      const rect = targetEl.getBoundingClientRect();
      const before = event.clientY < rect.top + rect.height / 2;
      newIndex = Number(targetEl.dataset.index) + (before ? 0 : 1);
      moveElement(sourceGroupEl, targetEl.closest('ul'), before);
    } else if (targetEl.matches('.group-header')) {
      const rect = targetEl.parentElement.getBoundingClientRect();
      const before = event.clientY < rect.top + rect.height / 2;
      newIndex = Number(targetEl.parentElement.dataset.groupStartIndex) + (before ? 0 : 1);
      moveElement(sourceGroupEl, targetEl.parentElement, before);
    } else if (targetEl.matches('.group-section')) {
      // Handle group-to-group section drops
      const rect = targetEl.getBoundingClientRect();
      const before = event.clientY < rect.top + rect.height / 2;
      newIndex = before ? Number(targetEl.dataset.groupStartIndex) : Number(targetEl.dataset.groupEndIndex) + 1;
      moveElement(sourceGroupEl, targetEl, before);
    }
    try {
      await sendMessage({ type: 'move-group', groupId: sourceGroupId, windowId: targetWindowId, index: newIndex });
      await loadActiveWindows();
    } catch (err) {
      toast(err.message);
      await loadActiveWindows();
    }
  }
}

function handleGroupDragOver(event) {
  if (!dragContext || dragContext.kind !== 'tab') {
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
}

async function handleGroupDrop(event) {
  if (!dragContext || dragContext.kind !== 'tab') {
    return;
  }
  event.preventDefault();
  const targetEl = event.currentTarget;
  const dataset = targetEl?.dataset || {};
  const target = dataset.dropTarget;
  const windowId = Number(dataset.windowId ?? dragContext.windowId);
  try {
    if (targetEl?.classList?.contains('tab-item')) {
      targetEl.classList.remove('drag-target', 'drag-target-before', 'drag-target-after');
    }
    if (target === 'group') {
      const groupId = Number(dataset.groupId);
      await sendMessage({ type: 'assign-group', tabIds: [dragContext.tabId], groupId, windowId });
    } else if (target === 'new-group') {
      await sendMessage({ type: 'assign-group', tabIds: [dragContext.tabId], groupId: 'new', windowId });
    } else if (target === 'ungroup') {
      await sendMessage({ type: 'assign-group', tabIds: [dragContext.tabId], groupId: -1, windowId });
    }
    await loadActiveWindows();
    selectTabs([dragContext.tabId]);
  } catch (err) {
    toast(err.message);
  } finally {
    dragContext = null;
    clearDropIndicator();
  }
}

function handleGroupSectionDragOver(event) {
  if (!dragContext || dragContext.kind !== 'group') {
    return;
  }
  event.preventDefault();
  const section = event.currentTarget;
  const rect = section.getBoundingClientRect();
  const before = event.clientY < rect.top + rect.height / 2;
  dropState.windowId = Number(section.dataset.windowId);
  dropState.groupId = Number(section.dataset.groupId);
  dropState.tabId = null;
  dropState.before = before;
  dropState.type = 'group';
  positionDropIndicator(section, before);
  event.dataTransfer.dropEffect = 'move';
}

function handleGroupSectionDragLeave(event) {
  if (!dragContext || dragContext.kind !== 'group') return;
  if (!event.currentTarget.contains(event.relatedTarget)) {
    clearDropIndicator();
  }
}

async function handleGroupSectionDrop(event) {
  if (!dragContext) return;

  // New part for tab drop
  if (dragContext.kind === 'tab') {
    event.preventDefault();
    event.stopPropagation();

    const section = event.currentTarget;
    const windowId = Number(section.dataset.windowId);
    const { tabId, groupId: sourceGroupId, windowId: sourceWindowId } = dragContext;

    const startIndex = Number(section.dataset.groupStartIndex || 0);

    const rect = section.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    const targetIndex = before ? startIndex : (Number(section.dataset.groupEndIndex || startIndex) + 1);

    try {
      if (windowId === sourceWindowId && sourceGroupId > -1) {
        await sendMessage({ type: 'assign-group', tabIds: [tabId], groupId: -1 });
      }

      await sendMessage({
        type: 'move-tab',
        tabId,
        windowId,
        index: targetIndex,
      });
      await loadActiveWindows();
      selectTabs([tabId]);
    } catch (err) {
      toast(err.message);
      await loadActiveWindows();
    } finally {
      clearDropIndicator();
      dragContext = null;
    }
    return;
  }


  if (dragContext.kind === 'group') {
    event.preventDefault();
    event.stopPropagation();
    const section = event.currentTarget;
    const windowId = Number(section.dataset.windowId);
    // ... existing group drop logic
    const targetGroupId = Number(section.dataset.groupId);
    if (targetGroupId === dragContext.groupId) {
      clearDropIndicator();
      dragContext = null;
      return;
    }
    const startIndex = Number(section.dataset.groupStartIndex || 0);
    const endIndex = Number(section.dataset.groupEndIndex || startIndex);
    const before = dropState.before;
    const targetIndex = before ? startIndex : endIndex + 1;
    try {
      await sendMessage({ type: 'move-group', groupId: dragContext.groupId, windowId, index: targetIndex });
      await loadActiveWindows();
    } catch (err) {
      toast(err.message);
    } finally {
      clearDropIndicator();
      dragContext = null;
    }
  }
}

async function handleGroupContainerDrop(event) {
  if (!dragContext || dragContext.kind !== 'group') return;
  event.preventDefault();
  event.stopPropagation();
  const windowId = Number(event.currentTarget.dataset.windowId);
  const tabItem = event.target.closest('.tab-item');
  if (tabItem) {
    const rect = tabItem.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    const referenceIndex = Number(tabItem.dataset.index ?? 0);
    const targetIndex = before ? referenceIndex : referenceIndex + 1;
    try {
      await sendMessage({ type: 'move-group', groupId: dragContext.groupId, windowId, index: targetIndex });
      await loadActiveWindows();
    } catch (err) {
      toast(err.message);
    } finally {
      clearDropIndicator();
      dragContext = null;
    }
    return;
  }
  try {
    await sendMessage({ type: 'move-group', groupId: dragContext.groupId, windowId, index: -1 });
    await loadActiveWindows();
    selectTabs([dragContext.tabId]);
  } catch (err) {
    toast(err.message);
  } finally {
    clearDropIndicator();
    dragContext = null;
  }
}

async function handleTabbedRowDrop(event) {
  if (!dragContext || dragContext.kind !== 'group') return;
  event.preventDefault();
  const windowId = Number(event.currentTarget.dataset.windowId);
  const referenceIndex = Number(event.currentTarget.dataset.index);
  const before = dropState.before;
  const targetIndex = before ? referenceIndex : referenceIndex + 1;
  try {
    await sendMessage({ type: 'move-group', groupId: dragContext.groupId, windowId, index: targetIndex });
    await loadActiveWindows();
  } catch (err) {
    toast(err.message);
  } finally {
    clearDropIndicator();
    dragContext = null;
  }
}

const toastEl = document.getElementById('toast-notification');
let toastTimer = null;

function toast(message) {
  if (!message) return;

  // Also log to background/console
  chrome.runtime.sendMessage({ type: 'toast', message }).catch(() => { });

  if (toastEl) {
    toastEl.textContent = message;
    toastEl.classList.remove('hidden');

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.add('hidden');
    }, 3000);
  }
}

function colorToHex(color) {
  const map = {
    grey: '#6b7280',
    blue: '#2563eb',
    red: '#dc2626',
    yellow: '#facc15',
    green: '#16a34a',
    pink: '#db2777',
    purple: '#7c3aed',
    cyan: '#0891b2',
    orange: '#ea580c',
  };
  return map[color] || '#2563eb';
}

function hexToRgba(hex, alpha) {
  const cleaned = hex.replace('#', '');
  if (cleaned.length !== 6) {
    return 'rgba(37, 99, 235, 0.12)';
  }
  const bigint = parseInt(cleaned, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

async function loadAll() {
  try {
    await loadActiveWindows();
  } catch (err) {
    toast(err.message);
  }
}

async function collectAllTabIds() {
  if (!activeWindowsCache.length) {
    activeWindowsCache = await sendMessage({ type: 'get-active' });
  }
  return activeWindowsCache.flatMap(win => (win.tabs || []).map(tab => tab.id)).filter(Boolean);
}

async function saveMarkdownForTabIds(tabIds) {
  const results = await sendMessage({ type: 'save-markdown', tabIds });
  const successes = results.filter(result => result.success).length;
  const failures = results.filter(result => !result.success);
  if (failures.length) {
    const detail = failures[0]?.error || 'Some tabs failed to save';
    toast(`Saved ${successes}/${results.length}. ${detail}`);
  } else {
    toast(`Saved ${successes} markdown file(s).`);
  }
}

function selectTabs(tabIds) {
  if (!tabIds || !tabIds.length) return;
  tabIds.forEach(id => {
    const checkbox = document.querySelector(`input[data-tab-id='${id}']`);
    if (checkbox) {
      checkbox.checked = true;
      // Trigger change event to update UI (selected class)
      checkbox.dispatchEvent(new Event('change'));
    }
  });
}


function throttle(callback, delay) {
  let throttleTimeout = null;
  let storedEvent = null;

  const throttledCallback = event => {
    storedEvent = event;
    if (throttleTimeout) return;

    throttleTimeout = setTimeout(() => {
      callback(storedEvent);
      throttleTimeout = null;
    }, delay);
  };

  return throttledCallback;
}

loadAll();

/* Context Menu Logic */

const contextMenu = document.getElementById('context-menu');

document.addEventListener('contextmenu', event => {
  event.preventDefault();
  handleContextMenu(event);
});

document.addEventListener('click', () => {
  if (contextMenu) contextMenu.style.display = 'none';
});

async function handleContextMenu(event) {
  if (!contextMenu) return;

  const x = event.clientX;
  const y = event.clientY;

  // 1. Identify Target Context
  const targetCard = event.target.closest('.card');
  const targetTabItem = event.target.closest('.tab-item');
  const targetGroupHeader = event.target.closest('.group-header');

  // 2. Identify Selection
  const selectedTabInputs = Array.from(document.querySelectorAll("input[data-select-kind='tab']:checked"));
  const selectedTabsCount = selectedTabInputs.length;


  // Priority Order: 
  // 1. Group Header (Force group actions)
  // 2. Selection (If exists)
  // 3. Tab Item
  // 4. Window / Empty Space

  const items = [];

  if (targetGroupHeader) {
    const groupId = Number(targetGroupHeader.dataset.groupId);
    const winId = Number(targetGroupHeader.dataset.windowId);

    items.push({
      label: 'View group',
      action: async () => {
        // Focus first tab in group?
        const win = activeWindowsCache.find(w => w.id === winId);
        if (win) {
          const groupTabs = win.tabs.filter(t => t.groupId === groupId);
          if (groupTabs.length) {
            await sendMessage({ type: 'focus-tab', tabId: groupTabs[0].id });
          }
        }
      }
    });

    // Change Group Color
    const colors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
    // Find current color
    const win = activeWindowsCache.find(w => w.id === winId);
    let currentColor = '';
    if (win) {
      const group = win.groups.find(g => g.id === groupId);
      if (group) currentColor = group.color;
    }

    items.push({
      label: 'Color',
      // submenuLayout: 'grid', // Removed grid layout
      submenu: colors.map(color => ({
        label: color.charAt(0).toUpperCase() + color.slice(1),
        // colorCode: colorToHex(color), // Removed swatch
        textColor: colorToHex(color), // Added colored text
        active: color === currentColor,
        action: async () => {
          await sendMessage({
            type: 'update-group',
            groupId: groupId,
            updateProperties: { color: color }
          });
          await loadActiveWindows();
        }
      }))
    });

    items.push({
      label: 'Un-group',
      action: async () => {
        const win = activeWindowsCache.find(w => w.id === winId);
        if (win) {
          const groupTabs = win.tabs.filter(t => t.groupId === groupId);
          if (groupTabs.length) {
            await sendMessage({
              type: 'assign-group',
              tabIds: groupTabs.map(t => t.id),
              groupId: -1
            });
            await loadActiveWindows();
          }
        }
      }
    });

    // Move group submenu
    const moveSubmenu = await buildMoveSubmenu((targetWinId) => {
      return sendMessage({
        type: 'move-group',
        groupId: groupId,
        windowId: targetWinId,
        index: -1
      }).then(() => loadActiveWindows());
    });

    items.push({
      label: 'Move group',
      submenu: moveSubmenu.length ? moveSubmenu : [{ label: 'No other windows', info: true }]
    });

    items.push({
      label: 'Close group',
      danger: true,
      action: async () => {
        // Close all tabs in group
        const win = activeWindowsCache.find(w => w.id === winId);
        if (win) {
          const groupTabs = win.tabs.filter(t => t.groupId === groupId);
          if (groupTabs.length) {
            await sendMessage({ type: 'close-tabs', tabIds: groupTabs.map(t => t.id) });
            await loadActiveWindows();
          }
        }
      }
    });

  } else if (selectedTabsCount > 0) {
    // --- Selection Mode ---

    // Calculate stats
    const selectedTabIds = selectedTabInputs.map(input => Number(input.dataset.tabId));
    const distinctGroups = new Set();
    const distinctWindows = new Set();

    selectedTabInputs.forEach(input => {
      if (input.dataset.groupId) distinctGroups.add(input.dataset.groupId);
      if (input.dataset.windowId) distinctWindows.add(input.dataset.windowId);
    });

    items.push({
      label: `Selected ${selectedTabsCount} tabs`,
      info: true,
      meta: `across ${distinctGroups.size} group(s) in ${distinctWindows.size} window(s)`
    });

    if (targetCard) {
      // Pointer inside window area
      items.push({
        label: 'Create new group',
        action: async () => {
          const windowId = Number(targetCard.dataset.winId);
          await sendMessage({
            type: 'assign-group',
            tabIds: selectedTabIds,
            groupId: 'new',
            windowId: windowId,
            title: 'New Group',
            color: 'blue'
          });
          await loadActiveWindows();
        }
      });

      // Move selection to this window implemented? 
      // It's covered by 'Move selection to new window' logic below for OUTSIDE context.
      // But if I right click inside a DIFFERENT window, maybe I want to move selected tabs HERE?
      // Logic from before:
      // "At closest position of mouse pointer create new group and move selected tabs into that group"
      // So the strict "Move here" logic is tied to "Create new group" above.

    } else {
      // Pointer outside window area
      items.push({
        label: 'Move selection to new window',
        action: async () => {
          await sendMessage({
            type: 'move-to-new-window',
            kind: 'tabs',
            tabIds: selectedTabIds
          });
          await loadActiveWindows();
          selectTabs(selectedTabIds);
        }
      });

      if (distinctGroups.size > 0) {
        items.push({
          label: 'Move grouped selection to new window',
          action: async () => {
            await sendMessage({
              type: 'move-to-new-window',
              kind: 'tabs',
              tabIds: selectedTabIds
            });
            await loadActiveWindows();
            selectTabs(selectedTabIds);
          }
        });
      }
    }

  } else {
    // --- No Selection & No Group Header ---


    if (targetTabItem) {
      const tabId = Number(targetTabItem.dataset.tabId);
      const winId = Number(targetTabItem.dataset.windowId);



      // Move tab submenu
      const moveSubmenu = await buildMoveSubmenu(
        (targetWinId, targetGroupId) => {
          return sendMessage({
            type: 'move-tab',
            tabIds: [tabId],
            windowId: targetWinId,
            index: -1
            // If group is specified, we might need to then group it. 
            // 'move-tab' only moves window/index. 
            // Adding group support to moveSubmenu logic is needed.
          }).then(async () => {
            if (targetGroupId !== undefined) {
              await sendMessage({ type: 'assign-group', tabIds: [tabId], groupId: targetGroupId });
            }
            await loadActiveWindows();
          });
        },
        async (targetIndex) => {
          const newWindow = await sendMessage({
            type: 'move-to-new-window',
            kind: 'tab',
            tabId: tabId
          });
          if (newWindow) {
            const order = activeWindowsCache.map(w => w.id);
            order.splice(targetIndex, 0, newWindow.id);
            await saveWindowOrder(order);
            await loadActiveWindows();
          }
        }
      );

      items.push({
        label: 'Move tab',
        submenu: moveSubmenu.length ? moveSubmenu : [{ label: 'No other windows', info: true }]
      });

      items.push({
        label: 'Close tab',
        danger: true,
        action: async () => {
          await sendMessage({ type: 'close-tabs', tabIds: [tabId] });
          await loadActiveWindows();
        }
      });

    } else if (targetGroupHeader) {
      const groupId = Number(targetGroupHeader.dataset.groupId);
      const winId = Number(targetGroupHeader.dataset.windowId);

      items.push({
        label: 'View group',
        action: async () => {
          // Focus first tab in group?
          const win = activeWindowsCache.find(w => w.id === winId);
          if (win) {
            const groupTabs = win.tabs.filter(t => t.groupId === groupId);
            if (groupTabs.length) {
              await sendMessage({ type: 'focus-tab', tabId: groupTabs[0].id });
            }
          }
        }
      });

      // Change Group Color
      const colors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
      // Find current color
      const win = activeWindowsCache.find(w => w.id === winId);
      let currentColor = '';
      if (win) {
        const group = win.groups.find(g => g.id === groupId);
        if (group) currentColor = group.color;
      }

      items.push({
        label: 'Color',
        submenuLayout: 'grid',
        submenu: colors.map(color => ({
          label: color.charAt(0).toUpperCase() + color.slice(1),
          colorCode: colorToHex(color),
          active: color === currentColor, // Add active flag
          action: async () => {
            await sendMessage({
              type: 'update-group',
              groupId: groupId,
              updateProperties: { color: color }
            });
            await loadActiveWindows();
          }
        }))
      });

      items.push({
        label: 'Un-group',
        action: async () => {
          const win = activeWindowsCache.find(w => w.id === winId);
          if (win) {
            const groupTabs = win.tabs.filter(t => t.groupId === groupId);
            if (groupTabs.length) {
              await sendMessage({
                type: 'assign-group',
                tabIds: groupTabs.map(t => t.id),
                groupId: -1
              });
              await loadActiveWindows();
            }
          }
        }
      });

      // Move group submenu
      const moveSubmenu = await buildMoveSubmenu(
        (targetWinId) => {
          return sendMessage({
            type: 'move-group',
            groupId: groupId,
            windowId: targetWinId,
            index: -1
          }).then(() => loadActiveWindows());
        },
        async (targetIndex) => {
          const newWindow = await sendMessage({
            type: 'move-to-new-window',
            kind: 'group',
            groupId: groupId
          });
          if (newWindow) {
            const order = activeWindowsCache.map(w => w.id);
            order.splice(targetIndex, 0, newWindow.id);
            await saveWindowOrder(order);
            await loadActiveWindows();
          }
        }
      );

      items.push({
        label: 'Move group',
        submenu: moveSubmenu.length ? moveSubmenu : [{ label: 'No other windows', info: true }]
      });

      items.push({
        label: 'Close group',
        danger: true,
        action: async () => {
          // Close all tabs in group
          const win = activeWindowsCache.find(w => w.id === winId);
          if (win) {
            const groupTabs = win.tabs.filter(t => t.groupId === groupId);
            if (groupTabs.length) {
              await sendMessage({ type: 'close-tabs', tabIds: groupTabs.map(t => t.id) });
              await loadActiveWindows();
            }
          }
        }
      });

    } else if (!targetCard) {
      // In-between windows
      items.push({
        label: 'New browser window',
        action: async () => {
          await sendMessage({ type: 'create-window' });
          // Ideally we should reload active windows but the create event might not be instant or monitored?
          // Since manager is an extension page, we might not get notified unless we poll or focus.
          // But existing behavior has 'refresh'. We can try to reload.
          setTimeout(loadActiveWindows, 500);
        }
      });
    }
  }

  renderContextMenu(items, x, y);
}

function renderContextMenu(items, x, y) {
  if (!items.length) return;

  contextMenu.innerHTML = '';

  function buildMenu(menuItems, parent) {
    menuItems.forEach(item => {
      const el = document.createElement('div');
      el.className = 'menu-item';

      if (item.info) {
        el.classList.add('info');
        el.innerHTML = `<strong>${item.label}</strong><br><span class="meta">${item.meta}</span>`;
        parent.appendChild(el);
        return;
      }

      if (item.colorCode) {
        // Render as color swatch
        const swatch = document.createElement('div');
        swatch.className = 'color-swatch';
        swatch.style.backgroundColor = item.colorCode;
        swatch.title = item.label; // Tooltip for accessibility

        if (item.active) {
          swatch.style.boxShadow = 'inset 0 0 0 2px white, 0 0 0 2px var(--text)';
          swatch.style.transform = 'scale(1.1)';
        }

        el.appendChild(swatch);
      } else {
        el.textContent = item.label;
        if (item.textColor) {
          el.style.color = item.textColor;
          el.style.fontWeight = '700';
        }
        if (item.bold) {
          el.style.fontWeight = '700';
        }
        if (item.active) {
          const check = document.createElement('span');
          check.textContent = ' ✓';
          check.style.marginLeft = 'auto';
          check.style.fontWeight = 'bold';
          el.appendChild(check);
          el.style.display = 'flex'; // Ensure flex layout for checkmark alignment
          el.style.justifyContent = 'space-between';
        }
      }

      if (item.danger) el.classList.add('danger');
      if (item.submenu) {
        el.classList.add('has-submenu');
        el.classList.add('has-submenu');
        // Arrow is handled by CSS ::after on .has-submenu to keep it clean
        // Removing the manual span creation if we use CSS ::after 
        // OR we can keep the span but make it empty and styled.
        // Let's use the pure CSS approach usually used in the styles I see.
        // Checking styles.css, I see: #context-menu .menu-item.has-submenu::after { content: '▸'; ... }
        // BUT wait, line 1866 created a span. 
        // Existing styles.css line 639 ALREADY has a rule for ::after with content '▸'.
        // So we might have DOUBLE arrows right now? '▶' from JS and '▸' from CSS?
        // Let's remove the JS arrow creation entirely and rely on CSS.


        const sub = document.createElement('div');
        sub.className = 'submenu';
        if (item.submenuLayout === 'grid') {
          sub.classList.add('grid-layout');
        }
        buildMenu(item.submenu, sub);
        el.appendChild(sub);
      }

      if (item.action) {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          // Normally close menu on action
          item.action();
          contextMenu.style.display = 'none';
        });
      }

      parent.appendChild(el);
    });
  }

  buildMenu(items, contextMenu);

  contextMenu.style.left = `${x}px`;
  contextMenu.style.top = `${y}px`;
  contextMenu.style.display = 'block';

  // Adjust if out of bounds
  const rect = contextMenu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    contextMenu.style.left = `${x - rect.width}px`;
  }
  if (rect.bottom > window.innerHeight) {
    contextMenu.style.top = `${y - rect.height}px`;
  }
}

async function buildMoveSubmenu(onSelect, onNewWindowAtIndex) {
  // Returns Items for submenu
  // Tree: Window -> Groups
  const windows = activeWindowsCache || [];
  const menuItems = [];

  // Fetch all groups globally to ensure they are available even for collapsed windows
  let allGroups = [];
  try {
    allGroups = await sendMessage({ type: 'get-all-groups' });
  } catch (err) {
    console.warn('Failed to fetch groups for submenu:', err);
  }

  // Map groups to windows
  const windowGroups = new Map();
  allGroups.forEach(g => {
    if (!windowGroups.has(g.windowId)) {
      windowGroups.set(g.windowId, []);
    }
    windowGroups.get(g.windowId).push(g);
  });

  windows.forEach((win, index) => {
    // Interleaved New Window Option
    if (onNewWindowAtIndex) {
      menuItems.push({
        label: '--- [ new window ] ---',
        action: () => onNewWindowAtIndex(index)
      });
    }

    // Option to move to Window itself
    menuItems.push({
      label: `[${index + 1}] ${win.title}`,
      bold: true,
      action: () => onSelect(win.id)
    });

    // Groups within window
    const groups = windowGroups.get(win.id) || [];
    if (groups.length) {
      groups.forEach(g => {
        menuItems.push({
          label: `  ↳ ${g.title}`,
          textColor: colorToHex(g.color),
          action: () => onSelect(win.id, g.id)
        });
      });
    }
  });

  // Final New Window Option
  if (onNewWindowAtIndex) {
    menuItems.push({
      label: '--- [ new window ] ---',
      action: () => onNewWindowAtIndex(windows.length)
    });
  }

  return menuItems;
}



// Attach container-level drag listeners
activeListEl.addEventListener('dragover', handleWindowDragOver);
activeListEl.addEventListener('drop', handleWindowDrop);

// Start the application
loadAll();

