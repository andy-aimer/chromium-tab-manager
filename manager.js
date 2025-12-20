const activeListEl = document.getElementById('active-list');
const savedListEl = document.getElementById('saved-list');
const refreshBtn = document.getElementById('refresh-btn');
const saveAllBtn = document.getElementById('save-all-btn');
const windowTemplate = document.getElementById('window-template');
const sessionTemplate = document.getElementById('session-template');
const columnSelect = document.getElementById('column-count');
const activeCountEl = document.getElementById('active-count');
const savedCountEl = document.getElementById('saved-count');

let dragContext = null;

refreshBtn.addEventListener('click', () => loadAll());
columnSelect.addEventListener('change', e => {
  document.documentElement.style.setProperty('--column-count', e.target.value);
});
document.documentElement.style.setProperty('--column-count', columnSelect.value);
saveAllBtn.addEventListener('click', async () => {
  saveAllBtn.disabled = true;
  try {
    await sendMessage({ type: 'save-window', windowId: null, title: 'All Windows' });
    await loadSessions();
    toast('All windows saved');
  } catch (err) {
    toast(err.message);
  } finally {
    saveAllBtn.disabled = false;
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
  activeListEl.innerHTML = '';
  activeCountEl.textContent = windows.length ? `${windows.length} window(s)` : 'No windows';
  windows.forEach(win => activeListEl.appendChild(createWindowCard(win)));
}

async function loadSessions() {
  const sessions = await sendMessage({ type: 'get-sessions' });
  savedListEl.innerHTML = '';
  savedCountEl.textContent = sessions.length ? `${sessions.length} saved session(s)` : 'No sessions yet';
  sessions
    .sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime())
    .forEach(session => savedListEl.appendChild(createSessionCard(session)));
}

function createWindowCard(win) {
  const frag = windowTemplate.content.cloneNode(true);
  const card = frag.querySelector('.card');
  card.dataset.winId = win.id;
  const header = card.querySelector('.card-header');
  header.classList.add('compact-header');
  const titleEl = card.querySelector('.title');
  titleEl.textContent = win.title;
  titleEl.classList.add('clickable');
  titleEl.addEventListener('click', () => activateInlineRename(titleEl, win.title, async value => {
    await sendMessage({ type: 'rename-window', windowId: win.id, title: value });
    await loadActiveWindows();
  }));
  const metaEl = card.querySelector('.meta');
  metaEl.textContent = `${win.tabs.length} tab(s)`;

  const actions = card.querySelector('.card-actions');
  actions.replaceChildren();

  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      await sendMessage({ type: 'save-window', windowId: win.id, title: win.title });
      await loadSessions();
    } catch (err) {
      toast(err.message);
    } finally {
      saveBtn.disabled = false;
    }
  });

  actions.append(saveBtn);

  const container = card.querySelector('.tab-list');
  container.classList.add('tab-collection');
  container.replaceChildren();
  const toggleBtn = card.querySelector('.toggle-tabs');
  toggleBtn.type = 'button';
  toggleBtn.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    const targetContainer = card.querySelector('.tab-list');
    if (!targetContainer) return;
    const collapsed = targetContainer.hasAttribute('hidden');
    if (collapsed) {
      targetContainer.removeAttribute('hidden');
      toggleBtn.classList.remove('collapsed');
      toggleBtn.textContent = '▾';
    } else {
      targetContainer.setAttribute('hidden', '');
      toggleBtn.classList.add('collapsed');
      toggleBtn.textContent = '▸';
    }
  });

  buildWindowSections(win).forEach(section => {
    if (section.type === 'group') {
      container.appendChild(renderGroupSection(win, section.group, section.tabs));
    } else if (section.type === 'tab') {
      container.appendChild(renderSingleTabRow(win, section.tab));
    }
  });

  container.dataset.windowId = win.id;
  container.addEventListener('dragover', handleGroupContainerDragOver);
  container.addEventListener('dragleave', handleGroupContainerDragLeave);
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

  const header = document.createElement('div');
  header.className = 'group-header';
  header.dataset.dropTarget = 'group';
  header.dataset.groupId = group.id;
  header.dataset.windowId = win.id;
  header.addEventListener('dragover', handleGroupDragOver);
  header.addEventListener('drop', handleGroupDrop);

  const chip = document.createElement('span');
  chip.className = 'group-chip';
  chip.textContent = group.title;
  chip.style.setProperty('--group-color', colorToHex(group.color));
  chip.addEventListener('click', () => activateInlineRename(chip, group.title, async value => {
    await sendMessage({ type: 'rename-group', groupId: group.id, title: value });
    await loadActiveWindows();
  }));
  chip.draggable = true;
  chip.addEventListener('dragstart', handleGroupChipDragStart);
  chip.addEventListener('dragend', handleGroupChipDragEnd);

  header.append(chip);
  section.appendChild(header);
  const list = renderTabList(win, tabs);
  list.style.setProperty('--group-color', colorToHex(group.color));
  const startIndex = tabs.length ? Math.min(...tabs.map(t => t.index)) : 0;
  const endIndex = tabs.length ? Math.max(...tabs.map(t => t.index)) : startIndex;
  section.dataset.groupStartIndex = String(startIndex);
  section.dataset.groupEndIndex = String(endIndex);
  section.addEventListener('dragover', handleGroupSectionDragOver);
  section.addEventListener('dragleave', handleGroupSectionDragLeave);
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
  wrapper.addEventListener('dragover', handleTabbedRowDragOver);
  wrapper.addEventListener('dragleave', handleTabbedRowDragLeave);
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
  const icon = document.createElement('img');
  icon.className = 'tab-icon';
  icon.src = tab.favicon || 'chrome://favicon';
  icon.onerror = () => (icon.style.visibility = 'hidden');
  const label = document.createElement('span');
  label.textContent = tab.title;
  item.append(icon, label);
  if (tab.pinned) {
    item.classList.add('pinned');
    item.setAttribute('draggable', 'false');
  } else {
    item.setAttribute('draggable', 'true');
  }

  item.addEventListener('dragstart', handleTabDragStart);
  item.addEventListener('dragend', handleTabDragEnd);
  item.addEventListener('dragover', handleTabDragOver);
  item.addEventListener('dragleave', handleTabDragLeave);
  item.addEventListener('drop', handleTabDrop);

  return item;
}

function handleTabDragStart(event) {
  const { tabId, windowId } = event.currentTarget.dataset;
  dragContext = { kind: 'tab', tabId: Number(tabId), windowId: Number(windowId) };
  event.dataTransfer?.setData('text/plain', tabId);
  event.dataTransfer?.setDragImage(event.currentTarget, 0, 0);
  event.currentTarget.classList.add('dragging');
}

function handleTabDragEnd(event) {
  event.currentTarget.classList.remove('dragging');
  dragContext = null;
}

function handleGroupChipDragStart(event) {
  const section = event.currentTarget.closest('.group-section');
  if (!section) return;
  const groupId = Number(section.dataset.groupId);
  const windowId = Number(section.dataset.windowId);
  dragContext = { kind: 'group', groupId, windowId };
  event.dataTransfer?.setData('text/plain', String(groupId));
  event.currentTarget.classList.add('dragging');
}

function handleGroupChipDragEnd(event) {
  event.currentTarget.classList.remove('dragging');
  dragContext = null;
  clearDropIndicator();
}

const dropIndicator = document.createElement('div');
dropIndicator.className = 'drop-indicator';
const dropState = { visible: false, windowId: null, tabId: null, groupId: null, before: true, target: null, type: null };

function positionDropIndicator(target, before) {
  const rect = target.getBoundingClientRect();
  dropIndicator.style.width = `${rect.width}px`;
  dropIndicator.style.left = `${rect.left}px`;
  dropIndicator.style.top = before ? `${rect.top - 1}px` : `${rect.bottom - 1}px`;
  if (!dropIndicator.isConnected) {
    document.body.appendChild(dropIndicator);
  }
  if (dropState.target && dropState.target !== target) {
    dropState.target.classList.remove('drop-target-active');
  }
  dropState.target = target;
  target.classList.add('drop-target-active');
  dropState.visible = true;
}

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

function handleTabDragOver(event) {
  if (!dragContext || dragContext.kind !== 'tab') {
    return;
  }
  event.preventDefault();
  const target = event.currentTarget;
  if (target.classList.contains('tab-item')) {
    const rect = target.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    dropState.windowId = Number(target.dataset.windowId);
    dropState.tabId = Number(target.dataset.tabId);
    dropState.before = before;
    positionDropIndicator(target, before);
  }
  event.dataTransfer.dropEffect = 'move';
}

function handleTabDragLeave(event) {
  if (event.currentTarget.classList.contains('tab-item')) {
    clearDropIndicator();
  }
}

async function handleTabDrop(event) {
  if (!dragContext || dragContext.kind !== 'tab') {
    return;
  }
  event.preventDefault();
  const targetEl = event.currentTarget;
  const dataset = targetEl?.dataset || {};
  const targetWindowId = Number(dataset.windowId ?? dropState.windowId ?? dragContext.windowId);
  let targetIndex = Number(dataset.index ?? dropState.tabId ?? 0);
  if (dropState.visible && dropState.tabId !== null) {
    const targetTab = document.querySelector(`.tab-item[data-tab-id='${dropState.tabId}']`);
    if (targetTab) {
      targetIndex = Number(targetTab.dataset.index) + (dropState.before ? 0 : 1);
    }
  } else if (targetEl?.classList?.contains('drag-target-after')) {
    targetIndex += 1;
  }
  try {
    const movedTabId = dragContext.tabId;
    await sendMessage({ type: 'move-tab', tabId: movedTabId, windowId: targetWindowId, index: targetIndex });
    await loadActiveWindows();
    requestAnimationFrame(() => markRelocatedTab(movedTabId, targetWindowId));
  } catch (err) {
    toast(err.message);
  } finally {
    if (targetEl?.classList?.contains('tab-item')) {
      targetEl.classList.remove('drag-target', 'drag-target-before', 'drag-target-after');
    }
    dragContext = null;
    clearDropIndicator();
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

function handleGroupContainerDragOver(event) {
  if (!dragContext || dragContext.kind !== 'group') return;
  const container = event.currentTarget;
  if (event.target.closest('.group-section')) return;
  event.preventDefault();
  dropState.windowId = Number(container.dataset.windowId);
  dropState.groupId = null;
  dropState.tabId = null;
  dropState.before = false;
  dropState.type = 'group';
  positionDropIndicator(container, false);
  event.dataTransfer.dropEffect = 'move';
}

function handleGroupContainerDragLeave(event) {
  if (!dragContext || dragContext.kind !== 'group') return;
  if (!event.currentTarget.contains(event.relatedTarget)) {
    clearDropIndicator();
  }
}

async function handleGroupContainerDrop(event) {
  if (!dragContext || dragContext.kind !== 'group') return;
  event.preventDefault();
  event.stopPropagation();
  const windowId = Number(event.currentTarget.dataset.windowId);
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

function handleTabbedRowDragOver(event) {
  if (!dragContext || dragContext.kind !== 'group') return;
  const list = event.currentTarget;
  if (!list.classList.contains('tab-list-inner')) return;
  event.preventDefault();
  const rect = list.getBoundingClientRect();
  const before = event.clientY < rect.top + rect.height / 2;
  dropState.windowId = Number(list.dataset.windowId);
  dropState.tabId = Number(list.dataset.index);
  dropState.groupId = null;
  dropState.before = before;
  dropState.type = 'group-between';
  positionDropIndicator(list, before);
  event.dataTransfer.dropEffect = 'move';
}

function handleTabbedRowDragLeave(event) {
  if (!dragContext || dragContext.kind !== 'group') return;
  if (!event.currentTarget.contains(event.relatedTarget)) {
    clearDropIndicator();
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

function createSessionCard(session) {
  const frag = sessionTemplate.content.cloneNode(true);
  const card = frag.querySelector('.card');
  card.dataset.sessionId = session.id;
  const sessionTitle = card.querySelector('.title');
  sessionTitle.textContent = session.title;
  card.querySelector('.saved-meta').textContent = `${session.tabs.length} tab(s) • saved ${formatDate(session.savedAt)}`;

  const actions = card.querySelector('.card-actions');
  actions.replaceChildren();

  const openBtn = document.createElement('button');
  openBtn.textContent = 'Open';
  openBtn.addEventListener('click', async () => {
    openBtn.disabled = true;
    try {
      await sendMessage({ type: 'launch-session', sessionId: session.id, options: { focused: true } });
      toast('Session opened');
    } catch (err) {
      toast(err.message);
    } finally {
      openBtn.disabled = false;
    }
  });

  const renameBtn = document.createElement('button');
  renameBtn.textContent = 'Rename';
  renameBtn.addEventListener('click', () => activateInlineRename(sessionTitle, sessionTitle.textContent, async value => {
    await sendMessage({ type: 'rename-session', sessionId: session.id, title: value });
    await loadSessions();
  }));

  const deleteBtn = document.createElement('button');
  deleteBtn.textContent = 'Delete';
  deleteBtn.classList.add('danger');
  deleteBtn.addEventListener('click', async () => {
    deleteBtn.disabled = true;
    try {
      await sendMessage({ type: 'remove-session', sessionId: session.id });
      await loadSessions();
    } catch (err) {
      toast(err.message);
    } finally {
      deleteBtn.disabled = false;
    }
  });

  actions.append(openBtn, renameBtn, deleteBtn);
  return frag;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'just now';
  }
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
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
    await Promise.all([loadActiveWindows(), loadSessions()]);
  } catch (err) {
    toast(err.message);
  }
}

loadAll();
