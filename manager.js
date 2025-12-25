const activeListEl = document.getElementById('active-list');
const refreshBtn = document.getElementById('refresh-btn');
const saveAllBtn = document.getElementById('save-all-btn');
const windowTemplate = document.getElementById('window-template');
const columnSelect = document.getElementById('column-count');
const activeCountEl = document.getElementById('active-count');
const saveMarkdownBtn = document.getElementById('save-markdown-btn');
const traceHistoryToggle = document.getElementById('trace-history');

let dragContext = null;
let activeWindowsCache = [];
let windowDragContext = null;
const WINDOW_ORDER_KEY = 'tab-manager:window-order';

refreshBtn.addEventListener('click', () => loadAll());
columnSelect.addEventListener('change', e => {
  document.documentElement.style.setProperty('--column-count', e.target.value);
});
document.documentElement.style.setProperty('--column-count', columnSelect.value);
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
  const windows = await sendMessage({ type: 'get-active' });
  const order = await loadWindowOrder();
  const sortedWindows = sortWindowsByOrder(windows, order);
  activeWindowsCache = sortedWindows;
  activeListEl.innerHTML = '';
  activeCountEl.textContent = sortedWindows.length ? `${sortedWindows.length} window(s)` : 'No windows';
  sortedWindows.forEach(win => activeListEl.appendChild(createWindowCard(win)));
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
  metaEl.textContent = `${win.tabs.length} tab(s)`;

  const actions = card.querySelector('.card-actions');
  actions.replaceChildren();

  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save Markdown';
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      const tabIds = (win.tabs || []).map(tab => tab.id).filter(Boolean);
      if (!tabIds.length) {
        toast('No tabs to save in this window.');
      } else {
        await saveMarkdownForTabIds(tabIds);
      }
    } catch (err) {
      toast(err.message);
    } finally {
      saveBtn.disabled = false;
    }
  });

  actions.append(saveBtn);
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
  container.replaceChildren();
  const toggleButtons = card.querySelectorAll('.toggle-tabs');
  toggleButtons.forEach(toggleBtn => {
    toggleBtn.type = 'button';
    toggleBtn.addEventListener('click', event => {
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
      } else {
        targetContainer.setAttribute('hidden', '');
        toggleButtons.forEach(btn => {
          btn.classList.add('collapsed');
          btn.textContent = '▸';
        });
      }
    });
  });

  buildWindowSections(win).forEach(section => {
    if (section.type === 'group') {
      container.appendChild(renderGroupSection(win, section.group, section.tabs));
    } else if (section.type === 'tab') {
      container.appendChild(renderSingleTabRow(win, section.tab));
    }
  });

  container.dataset.windowId = win.id;
  container.addEventListener('drop', handleGroupContainerDrop);

  return frag;
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
  const order = Array.from(activeListEl.querySelectorAll('.card'))
    .map(card => Number(card.dataset.winId))
    .filter(Boolean);
  saveWindowOrder(order);
  const windowById = new Map(activeWindowsCache.map(win => [win.id, win]));
  const reordered = order.map(id => windowById.get(id)).filter(Boolean);
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

function handleWindowDragOver(event) {
  if (!windowDragContext) {
    return;
  }
  const card = event.currentTarget;
  if (Number(card.dataset.winId) === windowDragContext.windowId) {
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  const rect = card.getBoundingClientRect();
  const before = event.clientY < rect.top + rect.height / 2;
  updateWindowDropIndicator(card, before);
}

function handleWindowDrop(event) {
  if (!windowDragContext) {
    return;
  }
  event.preventDefault();
  const targetCard = event.currentTarget;
  const sourceCard = activeListEl.querySelector(`.card[data-win-id='${windowDragContext.windowId}']`);
  if (!sourceCard || sourceCard === targetCard) {
    return;
  }
  clearWindowDropIndicator();
  const rect = targetCard.getBoundingClientRect();
  const before = event.clientY < rect.top + rect.height / 2;
  moveElement(sourceCard, targetCard, before);
  persistWindowOrderFromDom();
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
  item.append(icon, label, urlEl, tabCheckbox);
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
    const section = item.closest('.group-section');
    if (section) {
      updateGroupCheckboxState(section);
    }
    const card = item.closest('.card');
    if (card) {
      updateWindowCheckboxState(card);
    }
  });

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
  const fallback = 'chrome://favicon/size/16@2x/';
  const url = tab.url || tab.pendingUrl;
  if (!url) {
    return '';
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
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
      const header = target;
      updateDropIndicator(header, true, false);
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
  const height = 12;
  windowDropIndicator.style.width = `${rect.width}px`;
  windowDropIndicator.style.left = `${rect.left}px`;
  windowDropIndicator.style.height = `${height}px`;
  windowDropIndicator.style.top = before ? `${rect.top - height / 2}px` : `${rect.bottom - height / 2}px`;
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
  if (!dragContext || dragContext.kind !== 'group') return;
  event.preventDefault();
  event.stopPropagation();
  const section = event.currentTarget;
  const windowId = Number(section.dataset.windowId);
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

function toast(message) {
  if (!message) return;
  chrome.runtime.sendMessage({ type: 'toast', message }).catch(() => console.warn(message));
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
