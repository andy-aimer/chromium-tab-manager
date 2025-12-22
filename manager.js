const activeListEl = document.getElementById('active-list');
const refreshBtn = document.getElementById('refresh-btn');
const saveAllBtn = document.getElementById('save-all-btn');
const windowTemplate = document.getElementById('window-template');
const columnSelect = document.getElementById('column-count');
const activeCountEl = document.getElementById('active-count');
const saveMarkdownBtn = document.getElementById('save-markdown-btn');

let dragContext = null;
let activeWindowsCache = [];

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
  dragContext = null;
  clearDropIndicator();
  const draggingElement = document.querySelector('.dragging');
  if (draggingElement) {
    draggingElement.classList.remove('dragging');
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
  activeWindowsCache = windows;
  activeListEl.innerHTML = '';
  activeCountEl.textContent = windows.length ? `${windows.length} window(s)` : 'No windows';
  windows.forEach(win => activeListEl.appendChild(createWindowCard(win)));
}

function createWindowCard(win) {
  const frag = windowTemplate.content.cloneNode(true);
  const card = frag.querySelector('.card');
  card.dataset.winId = win.id;
  const header = card.querySelector('.card-header');
  header.classList.add('compact-header');
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
  groupCount.textContent = `${tabs.length} tab(s)`;
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
  label.textContent = tab.title;
  const tabCheckbox = createSelectCheckbox('tab', { windowId: win.id, groupId: tab.groupId, tabId: tab.id });
  const urlEl = document.createElement('span');
  urlEl.className = 'tab-url';
  urlEl.textContent = tab.url || '';
  item.append(icon, label, urlEl, tabCheckbox);
  if (tab.pinned) {
    item.classList.add('pinned');
    item.setAttribute('draggable', 'false');
  } else {
    item.setAttribute('draggable', 'true');
  }

  item.addEventListener('dragstart', handleTabDragStart);
  
  item.addEventListener('drop', handleTabDrop);
  item.addEventListener('click', async event => {
    if (event.target?.tagName?.toLowerCase() === 'input') {
      return;
    }
    try {
      await sendMessage({ type: 'focus-tab', tabId: tab.id });
    } catch (err) {
      toast(err.message);
    }
  });
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
}

const handleThrottledDragOver = throttle(event => {
  if (!dragContext) return;
  const target = event.target.closest('.tab-item, .group-section, .tab-list-inner.single');
  if (!target) {
    clearDropIndicator();
    return;
  }
  const isGroup = dragContext.kind === 'group';
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
    }
  } else {
    // Dragging a tab
    if (target.matches('.tab-item')) {
      if (Number(target.dataset.tabId) === dragContext.tabId) {
        clearDropIndicator();
        return;
      }
      updateDropIndicator(target, before, false);
    } else if (target.matches('.group-section')) {
      const header = target.querySelector('.group-header');
      updateDropIndicator(header, true, false);
    }
  }
}, 100);

function handleTabDragStart(event) {
  const { tabId, windowId, groupId } = event.currentTarget.dataset;
  dragContext = { kind: 'tab', tabId: Number(tabId), windowId: Number(windowId), groupId: Number(groupId) };
  event.dataTransfer?.setData('text/plain', tabId);
  event.dataTransfer?.setDragImage(event.currentTarget, 0, 0);
  event.currentTarget.classList.add('dragging');
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

function clearDropIndicator() {
  if (dropState.visible && dropIndicator.isConnected) {
    dropIndicator.remove();
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

  const { kind, tabId, windowId: sourceWindowId, groupId: sourceGroupId } = dragContext;
  const targetEl = event.target.closest('.tab-item, .group-header, .tab-list-inner.single');
  if (!targetEl) return;

  const targetWindowId = Number(targetEl.closest('.card').dataset.winId);

  // Handle dropping a tab
  if (kind === 'tab') {
    const sourceTabEl = document.querySelector(`.tab-item[data-tab-id='${tabId}']`);
    if (!sourceTabEl) return;

    let newIndex = -1;
    let newGroupId = undefined;

    if (targetEl.matches('.tab-item')) {
      const rect = targetEl.getBoundingClientRect();
      const before = event.clientY < rect.top + rect.height / 2;
      newIndex = Number(targetEl.dataset.index) + (before ? 0 : 1);
      newGroupId = Number(targetEl.closest('.group-section')?.dataset.groupId);
      moveElement(sourceTabEl.closest('ul'), targetEl.closest('ul'), before);
    } else if (targetEl.matches('.group-header')) {
      newGroupId = Number(targetEl.dataset.groupId);
      const list = targetEl.parentElement.querySelector('.tab-list-inner');
      list.appendChild(sourceTabEl.closest('ul'));
    } else if (targetEl.matches('.tab-list-inner.single')) {
      const rect = targetEl.getBoundingClientRect();
      const before = event.clientY < rect.top + rect.height / 2;
      newIndex = Number(targetEl.dataset.index) + (before ? 0 : 1);
      moveElement(sourceTabEl.closest('ul'), targetEl, before);
    }

    try {
      if (newGroupId !== undefined && newGroupId !== sourceGroupId) {
        await sendMessage({ type: 'assign-group', tabIds: [tabId], groupId: newGroupId, windowId: targetWindowId });
      }
      await sendMessage({ type: 'move-tab', tabId, windowId: targetWindowId, index: newIndex });
      if (sourceWindowId !== targetWindowId) {
        // update local cache to prevent full reload
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
    const movedTabId = dragContext.tabId;
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
    requestAnimationFrame(() => markRelocatedTab(movedTabId, windowId));
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

function markRelocatedTab(tabId, windowId) {
  let attempts = 0;
  function highlight() {
    const selector = windowId
      ? `.tab-item[data-tab-id='${tabId}'][data-window-id='${windowId}']`
      : `.tab-item[data-tab-id='${tabId}']`;
    const item = document.querySelector(selector);
    if (!item) {
      if (attempts < 10) {
        attempts += 1;
        requestAnimationFrame(highlight);
      }
      return;
    }
    item.classList.add('relocated');
    setTimeout(() => item.classList.remove('relocated'), 10000);
  }
  requestAnimationFrame(highlight);
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
