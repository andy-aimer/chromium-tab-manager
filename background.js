const STORAGE_KEY = 'tab-manager:sessions';
const WINDOW_TITLES_KEY = 'tab-manager:window-titles';
const MANAGER_URL = chrome.runtime.getURL('manager.html');

async function openManagerTab() {
  const [existing] = await chrome.tabs.query({ url: MANAGER_URL });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    return existing;
  }
  return chrome.tabs.create({ url: MANAGER_URL, active: true });
}

async function loadWindowTitles() {
  const { [WINDOW_TITLES_KEY]: titles = {} } = await chrome.storage.local.get(WINDOW_TITLES_KEY);
  return titles;
}

async function saveWindowTitle(windowId, title) {
  const titles = await loadWindowTitles();
  if (!title || !title.trim()) {
    delete titles[windowId];
  } else {
    titles[windowId] = title.trim();
  }
  await chrome.storage.local.set({ [WINDOW_TITLES_KEY]: titles });
  return { windowId, title: titles[windowId] || '' };
}

async function fetchTabGroups(windows) {
  const ids = new Set();
  windows.forEach(win => {
    (win.tabs || []).forEach(tab => {
      if (typeof tab.groupId === 'number' && tab.groupId >= 0) {
        ids.add(tab.groupId);
      }
    });
  });
  const groups = [];
  await Promise.all(
    [...ids].map(async id => {
      try {
        const group = await chrome.tabGroups.get(id);
        groups.push(group);
      } catch (err) {
        console.warn('Failed to fetch tab group', id, err);
      }
    }),
  );
  return groups;
}

async function getActiveWindows() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const [titles, groups] = await Promise.all([loadWindowTitles(), fetchTabGroups(windows)]);
  return windows.map(win => {
    const tabs = (win.tabs || []).map((tab, index) => serializeTab(tab, index));
    const windowGroups = groups
      .filter(group => group.windowId === win.id)
      .map(group => ({
        id: group.id,
        title: group.title || 'Group',
        color: group.color,
        collapsed: group.collapsed,
      }));
    return {
      id: win.id,
      title: titles[win.id] || buildWindowTitle(win),
      focused: win.focused,
      tabs,
      groups: windowGroups,
    };
  });
}

function serializeTab(tab, index) {
  return {
    id: tab.id,
    title: tab.title || tab.pendingUrl || 'Untitled',
    url: tab.url || tab.pendingUrl || 'chrome://newtab/',
    pinned: tab.pinned,
    audible: tab.audible,
    muted: tab.mutedInfo ? tab.mutedInfo.muted : false,
    favicon: tab.favIconUrl || '',
    groupId: typeof tab.groupId === 'number' ? tab.groupId : -1,
    index,
  };
}

function buildWindowTitle(win) {
  if (win.title && win.title.trim()) {
    return win.title.trim();
  }
  if (!win.tabs || !win.tabs.length) {
    return 'Empty Window';
  }
  const first = win.tabs.find(tab => tab.active) || win.tabs[0];
  try {
    const hostname = new URL(first.url || first.pendingUrl || 'chrome://newtab/').hostname;
    return hostname || 'Window';
  } catch (err) {
    return 'Window';
  }
}

async function loadSessions() {
  const { [STORAGE_KEY]: sessions = [] } = await chrome.storage.local.get(STORAGE_KEY);
  return sessions;
}

async function persistSessions(sessions) {
  await chrome.storage.local.set({ [STORAGE_KEY]: sessions });
}

async function saveWindow(winId, title) {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  if (!winId) {
    const titles = await loadWindowTitles();
    const sessions = await loadSessions();
    windows.forEach(win => {
      const entry = {
        id: crypto.randomUUID(),
        title: titles[win.id] || `Session • ${buildWindowTitle(win)}`,
        savedAt: new Date().toISOString(),
        tabs: (win.tabs || []).map(tab => ({
          url: tab.url || tab.pendingUrl,
          title: tab.title || 'Untitled',
          pinned: tab.pinned,
        })),
      };
      sessions.push(entry);
    });
    await persistSessions(sessions);
    return sessions;
  }
  const titles = await loadWindowTitles();
  const win = windows.find(w => w.id === winId);
  if (!win) {
    throw new Error('Window not found');
  }
  const sessions = await loadSessions();
  const entry = {
    id: crypto.randomUUID(),
    title: title || titles[winId] || buildWindowTitle(win),
    savedAt: new Date().toISOString(),
    tabs: (win.tabs || []).map(tab => ({
      url: tab.url || tab.pendingUrl,
      title: tab.title || 'Untitled',
      pinned: tab.pinned,
    })),
  };
  sessions.push(entry);
  await persistSessions(sessions);
  return entry;
}

async function removeSession(sessionId) {
  const sessions = await loadSessions();
  const next = sessions.filter(session => session.id !== sessionId);
  await persistSessions(next);
  return next;
}

async function renameSession(sessionId, title) {
  const sessions = await loadSessions();
  const session = sessions.find(entry => entry.id === sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  session.title = title;
  session.savedAt = new Date().toISOString();
  await persistSessions(sessions);
  return session;
}

async function launchSession(sessionId, { reuse, focused }) {
  const sessions = await loadSessions();
  const session = sessions.find(entry => entry.id === sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  const urls = session.tabs.map(tab => tab.url).filter(Boolean);
  if (!urls.length) {
    return null;
  }
  if (reuse && reuse.windowId) {
    for (const url of urls) {
      chrome.tabs.create({ windowId: reuse.windowId, url, active: false });
    }
    if (focused) {
      chrome.windows.update(reuse.windowId, { focused: true });
    }
  } else {
    await chrome.windows.create({ url: urls, focused: focused !== false });
  }
  return session;
}

async function assignToGroup(message) {
  const tabIds = Array.isArray(message.tabIds) ? message.tabIds : [message.tabId];
  if (!tabIds.length) {
    return { groupId: -1 };
  }
  if (message.groupId === -1) {
    await chrome.tabs.ungroup(tabIds);
    return { groupId: -1 };
  }
  if (message.groupId === 'new') {
    const groupId = await chrome.tabs.group({ tabIds });
    await chrome.tabGroups.update(groupId, {
      title: message.title || 'New Group',
      color: message.color || 'blue',
    });
    return { groupId };
  }
  await chrome.tabs.group({ groupId: message.groupId, tabIds });
  return { groupId: message.groupId };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const respond = (data, isError) => {
    if (isError) {
      sendResponse({ ok: false, error: data.message || String(data) });
    } else {
      sendResponse({ ok: true, data });
    }
  };
  (async () => {
    switch (message?.type) {
      case 'get-active':
        respond(await getActiveWindows());
        break;
      case 'get-sessions':
        respond(await loadSessions());
        break;
      case 'save-window':
        respond(await saveWindow(message.windowId, message.title));
        break;
      case 'remove-session':
        respond(await removeSession(message.sessionId));
        break;
      case 'rename-session':
        respond(await renameSession(message.sessionId, message.title));
        break;
      case 'launch-session':
        respond(await launchSession(message.sessionId, message.options || {}));
        break;
      case 'rename-window':
        respond(await saveWindowTitle(message.windowId, message.title));
        break;
      case 'rename-group':
        respond(await chrome.tabGroups.update(message.groupId, { title: message.title || '' }));
        break;
      case 'move-tab':
        respond(
          await chrome.tabs.move(message.tabId, {
            windowId: message.windowId,
            index: message.index,
          }),
        );
        break;
      case 'assign-group':
        respond(await assignToGroup(message));
        break;
      case 'move-group':
        respond(await chrome.tabGroups.move(message.groupId, { index: message.index, windowId: message.windowId }));
        break;
      case 'toast':
        if (message.message) {
          console.info('[Tab Manager]', message.message);
        }
        respond(true);
        break;
      default:
        respond(new Error('Unknown message type'), true);
        break;
    }
  })().catch(err => respond(err, true));
  return true;
});

chrome.commands.onCommand.addListener(async command => {
  if (command === 'open-tab-manager') {
    await openManagerTab();
  }
});

chrome.action.onClicked.addListener(async () => {
  await openManagerTab();
});
