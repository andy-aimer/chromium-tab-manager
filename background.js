const WINDOW_TITLES_KEY = 'tab-manager:window-titles';
const WINDOW_ORDER_KEY = 'tab-manager:window-order';
const UNDO_STACK_KEY = 'tab-manager:undo-stack';
const REDO_STACK_KEY = 'tab-manager:redo-stack';
const SETTINGS_KEY = 'tab-manager:settings';
const MANAGER_URL = chrome.runtime.getURL('manager.html');
let storagePromise = Promise.resolve();

class CommandManager {
  constructor() {
    this.undoStack = [];
    this.redoStack = [];
    this.loaded = false;
    this.settings = { undoLimit: 50 }; // Default settings
  }

  async load() {
    if (this.loaded) return;
    try {
      const data = await chrome.storage.local.get([UNDO_STACK_KEY, REDO_STACK_KEY, SETTINGS_KEY]);
      this.undoStack = data[UNDO_STACK_KEY] || [];
      this.redoStack = data[REDO_STACK_KEY] || [];
      this.settings = { ...this.settings, ...(data[SETTINGS_KEY] || {}) };
      this.loaded = true;
    } catch (err) {
      console.error('Failed to load command stacks', err);
    }
  }

  async save() {
    try {
      // Limit stack size to prevent storage quota issues
      // Limit stack size based on settings
      const limit = this.settings.undoLimit || 50;
      if (this.undoStack.length > limit) this.undoStack.shift();
      if (this.redoStack.length > limit) this.redoStack.shift();

      await chrome.storage.local.set({
        [UNDO_STACK_KEY]: this.undoStack,
        [REDO_STACK_KEY]: this.redoStack
      });
    } catch (err) {
      console.warn('Failed to save command stacks', err);
    }
  }

  async execute(command, executeFn) {
    await this.load();
    try {
      const result = await executeFn();
      // Only push to undo stack if execution succeeded
      this.undoStack.push(command);
      this.redoStack = []; // Clear redo stack on new action
      await this.save();
      return result;
    } catch (err) {
      console.error('Command execution failed', err);
      throw err;
    }
  }

  async undo() {
    await this.load();
    const command = this.undoStack.pop();
    if (!command) return;

    try {
      await this.performInverse(command);
      this.redoStack.push(command);
      await this.save();
    } catch (err) {
      console.error('Undo failed', err);
      // Put it back? Or drop it? specialized handling might be needed.
      // For now, if undo fails, we might have partial state.
      // We'll push it back to redo so user can try to "redo" to fix state or undo again?
      // Actually if undo failed, we probably shouldn't push to redo.
      this.undoStack.push(command); // Put it back
      throw err;
    }
  }

  async redo() {
    await this.load();
    const command = this.redoStack.pop();
    if (!command) return;

    try {
      await this.performAction(command);
      this.undoStack.push(command);
      await this.save();
    } catch (err) {
      console.error('Redo failed', err);
      this.redoStack.push(command); // Put it back
      throw err;
    }
  }

  async performAction(command) {
    const { type, data } = command;
    switch (type) {
      case 'rename-window':
        await saveWindowTitle(data.windowId, data.newTitle);
        break;
      case 'rename-group':
        await chrome.tabGroups.update(data.groupId, { title: data.newTitle });
        break;
      case 'update-group':
        await chrome.tabGroups.update(data.groupId, data.newProperties);
        break;
      case 'move-tab':
        await chrome.tabs.move(data.tabIds, { windowId: data.toWindowId, index: data.toIndex });
        break;
      case 'move-group':
        await chrome.tabGroups.move(data.groupId, { windowId: data.toWindowId, index: data.toIndex });
        break;
      case 'close-tabs':
        // We can't easily "redo" a close tab exactly same ID unless we use sessions.restore on the session ID
        // But capturing session ID on close is tricky. 
        // For simple redo, we just close them again? 
        // If "Undo" restored them, they have new IDs. 
        // Redo needs to know the NEW IDs. This is hard.
        // STRATEGY CHANGE: Redo'ing a "Close Tab" means closing the tabs that were restored.
        // But we don't know their IDs.
        // Simplified: We might only support Undo for Close, and Redo for non-destructive?
        // Or, we update the command in stack with new IDs after Undo?
        // For now, let's implement basic re-actions.
        if (data.restoredSessionId) {
          // If we used restore, we can't "re-close" easily without tracking property.
          // Let's skip Redo for Close Tabs for MVP or just try to remove by URL? No unsafe.
          throw new Error("Redo not implemented for Close Tabs yet");
        }
        await chrome.tabs.remove(data.tabIds);
        break;
      case 'create-window':
        // Redo: Create window again?
        await chrome.windows.create({});
        break;
      case 'move-to-new-window':
        // Redo: Move tabs to new window.
        // Data needs tabIds.
        if (data.kind === 'tab') {
          await chrome.windows.create({ tabId: data.tabId });
        } else if (data.kind === 'tabs') {
          const [first, ...others] = data.tabIds;
          const win = await chrome.windows.create({ tabId: first });
          if (others.length) await chrome.tabs.move(others, { windowId: win.id, index: -1 });
        }
      case 'get-tab-count':
        return await getTotalTabCount();
      case 'get-all-groups':
        return await chrome.tabGroups.query({});
      case 'assign-group':
        await assignToGroup(data.message);
        break;
    }
  }

  async performInverse(command) {
    const { type, data } = command;
    switch (type) {
      case 'rename-window':
        await saveWindowTitle(data.windowId, data.oldTitle);
        break;
      case 'rename-group':
        await chrome.tabGroups.update(data.groupId, { title: data.oldTitle });
        break;
      case 'update-group':
        // We need old properties.
        await chrome.tabGroups.update(data.groupId, data.oldProperties);
        break;
      case 'move-tab':
        // Move back.
        // If multiple tabs, move them back one by one or together?
        // Data should capture 'fromWindowId' and 'fromIndex'. 
        // If multiple tabs came from different places, we need an array of sources.
        if (Array.isArray(data.sources)) {
          // Reverse order to maintain indices if possible?
          for (const src of data.sources) {
            // We need to find current tab ID? The ID should be constant usually.
            await chrome.tabs.move(src.tabId, { windowId: src.windowId, index: src.index });
          }
        } else {
          await chrome.tabs.move(data.tabIds, { windowId: data.fromWindowId, index: data.fromIndex });
        }
        break;
      case 'move-group':
        await chrome.tabGroups.move(data.groupId, { windowId: data.fromWindowId, index: data.fromIndex });
        break;
      case 'close-tabs':
        // Restore closed tabs.
        // We can use chrome.sessions.restore if we can find the session?
        // Or chrome.tabs.create with URL.
        // Ideally chrome.sessions.restore() with no arguments restores most recent.
        // But we need to match OUR action.
        // Let's rely on chrome.sessions.restore(null) if it was the most recent close.
        // Risk: Context might have changed.

        // Better: chrome.sessions.getRecentlyClosed...
        // MVP: Re-create tabs with URLs.
        if (data.tabs && data.tabs.length) {
          for (const tabInfo of data.tabs) {
            await chrome.tabs.create({
              url: tabInfo.url,
              windowId: tabInfo.windowId,
              pinned: tabInfo.pinned,
              index: tabInfo.index,
              active: false
            });
          }
        }
        break;
      case 'create-window':
        // Undo: Close the created window.
        // We need the created window ID.
        // Issue: The 'command' stored in 'execute' needs the result of the action.
        // We'll need to update the command object after execution with result data.
        if (data.newWindowId) {
          await chrome.windows.remove(data.newWindowId);
        }
        break;
      case 'move-to-new-window':
        // Inverse: Move tabs back to old window.
        // We need to know where they came from.
        if (data.sources) {
          for (const src of data.sources) {
            await chrome.tabs.move(src.tabId, { windowId: src.windowId, index: src.index });
          }
        }
        break;
      case 'assign-group':
        // Inverse: restore groups
        if (data.sources) {
          // Grouping needs to be efficient. 
          // Group by groupId first.
          const map = new Map();
          data.sources.forEach(s => {
            const list = map.get(s.groupId) || [];
            list.push(s.tabId);
            map.set(s.groupId, list);
          });
          for (const [gid, tids] of map.entries()) {
            if (gid === -1) {
              await chrome.tabs.ungroup(tids);
            } else {
              // We can try to add to existing group.
              // Does group exist?
              try {
                await chrome.tabs.group({ groupId: gid, tabIds: tids });
              } catch (e) {
                // If group gone, maybe create new? 
                // Or just ungroup?
                // For now, if undo fails to find group, we might just ungroup or create new.
                // Simpler: Just ungroup if fail.
                await chrome.tabs.ungroup(tids);
              }
            }
          }
        }
        break;
    }
  }
}

const commandManager = new CommandManager();

function queueStorageOperation(operation) {
  const next = storagePromise.then(operation);
  storagePromise = next.catch(err => {
    console.error('Storage operation failed:', err);
  });
  return next;
}

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
  return queueStorageOperation(async () => {
    const titles = await loadWindowTitles();
    if (!title || !title.trim()) {
      delete titles[windowId];
    } else {
      titles[windowId] = title.trim();
    }
    await chrome.storage.local.set({ [WINDOW_TITLES_KEY]: titles });
    return { windowId, title: titles[windowId] || '' };
  });
}

async function fetchTabGroups(windows) {
  // Optimization: use chrome.tabGroups.query instead of individual gets
  try {
    // If we are fetching for specific windows, we can try to filter
    if (windows.length === 1) {
      return await chrome.tabGroups.query({ windowId: windows[0].id });
    }
    // Otherwise fetch all (fetching all is often faster than N individual GETs)
    return await chrome.tabGroups.query({});
  } catch (err) {
    console.warn('Failed to fetch tab groups', err);
    return [];
  }
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

async function getOrderedActiveWindowsLight() {
  const windows = await getActiveWindowsLight();
  const { [WINDOW_ORDER_KEY]: order = [] } = await chrome.storage.local.get(WINDOW_ORDER_KEY);

  if (!order.length) return windows;

  const indexById = new Map(order.map((id, index) => [id, index]));
  return windows.sort((a, b) => {
    const aIndex = indexById.get(a.id);
    const bIndex = indexById.get(b.id);
    if (aIndex === undefined && bIndex === undefined) return 0;
    if (aIndex === undefined) return 1;
    if (bIndex === undefined) return -1;
    return aIndex - bIndex;
  });
}

async function getActiveWindowsLight() {
  const windows = await chrome.windows.getAll({ populate: false, windowTypes: ['normal'] });
  const titles = await loadWindowTitles();
  return windows.map(win => ({
    id: win.id,
    title: titles[win.id] || win.title || 'Window',
    focused: win.focused,
    tabs: [],
    groups: [],
  }));
}

async function getWindowDetails(windowId) {
  const win = await chrome.windows.get(windowId, { populate: true });
  const groups = await fetchTabGroups([win]);
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
    tabs,
    groups: windowGroups,
  };
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
    lastAccessed: typeof tab.lastAccessed === 'number' ? tab.lastAccessed : 0,
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

function sanitizeFilename(value) {
  const cleaned = value.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ').trim();
  return cleaned || 'untitled';
}

async function extractMarkdownFromTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const normalizeText = (text) => text.replace(/\s+/g, ' ').trim();

      const pickMainNode = () => {
        const selectors = [
          'article',
          'main',
          '[role="main"]',
          '#content',
          '.content',
          '.article',
          '.post',
          '.entry',
          '.markdown-body',
        ];
        let best = null;
        let bestScore = 0;
        selectors.forEach(selector => {
          document.querySelectorAll(selector).forEach(node => {
            const score = (node.innerText || '').length;
            if (score > bestScore) {
              best = node;
              bestScore = score;
            }
          });
        });
        return best || document.body;
      };

      const cloneAndClean = (node) => {
        const clone = node.cloneNode(true);
        const removeTags = [
          'script',
          'style',
          'noscript',
          'iframe',
          'canvas',
          'svg',
          'nav',
          'aside',
          'header',
          'footer',
          'form',
          'button',
          'input',
          'textarea',
          'select',
        ];
        clone.querySelectorAll(removeTags.join(',')).forEach(el => el.remove());
        return clone;
      };

      const renderInline = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          return normalizeText(node.textContent || '');
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
          return '';
        }
        const tag = node.tagName.toLowerCase();
        if (tag === 'br') {
          return '\n';
        }
        if (tag === 'strong' || tag === 'b') {
          return `**${renderInlineChildren(node)}**`;
        }
        if (tag === 'em' || tag === 'i') {
          return `*${renderInlineChildren(node)}*`;
        }
        if (tag === 'code') {
          return `\`${(node.textContent || '').trim()}\``;
        }
        if (tag === 'a') {
          const href = node.getAttribute('href') || '';
          const label = renderInlineChildren(node) || href;
          return href ? `[${label}](${href})` : label;
        }
        if (tag === 'img') {
          const alt = node.getAttribute('alt') || '';
          const src = node.getAttribute('src') || '';
          return src ? `![${alt}](${src})` : '';
        }
        return renderInlineChildren(node);
      };

      const renderInlineChildren = (node) => {
        const parts = [];
        node.childNodes.forEach(child => {
          const chunk = renderInline(child);
          if (chunk) {
            parts.push(chunk);
          }
        });
        return parts.join(' ').replace(/\s+\n/g, '\n').replace(/\n\s+/g, '\n').trim();
      };

      const renderBlock = (node, depth = 0) => {
        if (node.nodeType === Node.TEXT_NODE) {
          return normalizeText(node.textContent || '');
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
          return '';
        }
        const tag = node.tagName.toLowerCase();
        if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
          const level = Number(tag[1]);
          const title = renderInlineChildren(node);
          return title ? `${'#'.repeat(level)} ${title}\n\n` : '';
        }
        if (tag === 'p') {
          const text = renderInlineChildren(node);
          return text ? `${text}\n\n` : '';
        }
        if (tag === 'pre') {
          const text = node.textContent || '';
          return `\`\`\`\n${text.replace(/\n{3,}/g, '\n\n')}\n\`\`\`\n\n`;
        }
        if (tag === 'blockquote') {
          const text = renderInlineChildren(node);
          if (!text) {
            return '';
          }
          return `${text.split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
        }
        if (tag === 'ul' || tag === 'ol') {
          const items = [];
          const ordered = tag === 'ol';
          let index = 1;
          node.childNodes.forEach(child => {
            if (child.nodeType === Node.ELEMENT_NODE && child.tagName.toLowerCase() === 'li') {
              const content = renderBlock(child, depth + 1).trim();
              if (content) {
                const prefix = ordered ? `${index}. ` : '- ';
                items.push(`${'  '.repeat(depth)}${prefix}${content}`);
                index += 1;
              }
            }
          });
          return items.length ? `${items.join('\n')}\n\n` : '';
        }
        if (tag === 'li') {
          const content = renderInlineChildren(node);
          return content || '';
        }
        if (tag === 'hr') {
          return '---\n\n';
        }

        const parts = [];
        node.childNodes.forEach(child => {
          const chunk = renderBlock(child, depth);
          if (chunk) {
            parts.push(chunk);
          }
        });
        return parts.join('');
      };

      try {
        const mainNode = pickMainNode();
        const cleaned = cloneAndClean(mainNode);
        let markdown = renderBlock(cleaned).replace(/\n{3,}/g, '\n\n').trim();
        const title = document.title || 'Untitled';
        if (markdown) {
          markdown = `# ${title}\n\n${markdown}`;
        } else {
          markdown = `# ${title}\n\n${normalizeText(document.body?.innerText || '')}`;
        }
        return { title, markdown };
      } catch (err) {
        return { error: err.message || String(err) };
      }
    },
  });
  const result = results?.[0]?.result;
  if (!result || result.error) {
    throw new Error(result?.error || 'Failed to extract content');
  }
  return result;
}

async function saveMarkdownForTabs(tabIds) {
  const results = [];
  for (const tabId of tabIds) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab?.url || !tab.url.startsWith('http')) {
        throw new Error('Tab URL is not supported');
      }
      const { title, markdown } = await extractMarkdownFromTab(tabId);
      const filename = `${sanitizeFilename(title || tab.title || 'untitled')}.md`;
      const dataUrl = `data:text/markdown;charset=utf-8,${encodeURIComponent(markdown)}`;
      await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
      results.push({ tabId, title, success: true });
    } catch (err) {
      results.push({ tabId, title: '', success: false, error: err.message || String(err) });
    }
  }
  return results;
}

async function moveGroupToNewWindow(groupId, windowId) {
  const tabs = await chrome.tabs.query({ windowId, groupId });
  if (!tabs.length) {
    throw new Error('No tabs found in group');
  }
  const group = await chrome.tabGroups.get(groupId);
  const ordered = tabs.slice().sort((a, b) => a.index - b.index);
  const firstTab = ordered[0];
  const remainingTabIds = ordered.slice(1).map(tab => tab.id);
  const newWindow = await chrome.windows.create({ tabId: firstTab.id });
  if (remainingTabIds.length) {
    await chrome.tabs.move(remainingTabIds, { windowId: newWindow.id, index: -1 });
  }
  const allTabIds = ordered.map(tab => tab.id);
  const newGroupId = await chrome.tabs.group({
    tabIds: allTabIds,
    createProperties: { windowId: newWindow.id },
  });
  await chrome.tabGroups.update(newGroupId, {
    title: group.title || '',
    color: group.color,
    collapsed: group.collapsed,
  });
  return newWindow;
}

async function refocusManager(sender) {
  if (!sender?.tab?.id) {
    return;
  }
  await chrome.tabs.update(sender.tab.id, { active: true });
  if (sender.tab.windowId) {
    await chrome.windows.update(sender.tab.windowId, { focused: true });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    console.warn(`Ignoring message from unknown sender: ${sender.id}`);
    return false;
  }
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
      case 'get-active-windows-light':
        respond(await getActiveWindowsLight());
        break;
      case 'get-ordered-windows-light':
        respond(await getOrderedActiveWindowsLight());
        break;
      case 'get-window-details':
        respond(await getWindowDetails(message.windowId));
        break;
      case 'get-all-groups':
        respond(await chrome.tabGroups.query({}));
        break;
      case 'get-settings':
        await commandManager.load();
        respond(commandManager.settings);
        break;
      case 'update-settings':
        await commandManager.load();
        commandManager.settings = { ...commandManager.settings, ...message.settings };
        await chrome.storage.local.set({ [SETTINGS_KEY]: commandManager.settings });
        respond({ success: true, settings: commandManager.settings });
        break;
      case 'rename-window': {
        const { windowId, title } = message;
        const oldTitle = (await loadWindowTitles())[windowId] || '';
        respond(
          await commandManager.execute(
            {
              type: 'rename-window',
              timestamp: Date.now(),
              data: { windowId, newTitle: title, oldTitle }
            },
            async () => saveWindowTitle(windowId, title)
          )
        );
        break;
      }
      case 'rename-group': {
        const { groupId, title } = message;
        const group = await chrome.tabGroups.get(groupId);
        respond(
          await commandManager.execute(
            {
              type: 'rename-group',
              timestamp: Date.now(),
              data: { groupId, newTitle: title, oldTitle: group.title }
            },
            async () => chrome.tabGroups.update(groupId, { title: title || '' })
          )
        );
        break;
      }
      case 'update-group': {
        const { groupId, updateProperties } = message;
        const group = await chrome.tabGroups.get(groupId);
        // Only capture properties being updated
        const oldProperties = {};
        Object.keys(updateProperties).forEach(key => {
          if (key === 'color') oldProperties.color = group.color;
          if (key === 'title') oldProperties.title = group.title;
          if (key === 'collapsed') oldProperties.collapsed = group.collapsed;
        });

        respond(
          await commandManager.execute(
            {
              type: 'update-group',
              timestamp: Date.now(),
              data: { groupId, newProperties: updateProperties, oldProperties }
            },
            async () => chrome.tabGroups.update(groupId, updateProperties)
          )
        );
        break;
      }
      case 'move-tab': {
        const tabIds = Array.isArray(message.tabIds) ? message.tabIds : [message.tabId];
        // Capture sources
        const sources = [];
        for (const tid of tabIds) {
          try {
            const t = await chrome.tabs.get(tid);
            sources.push({ tabId: tid, windowId: t.windowId, index: t.index });
          } catch (e) { /* ignore if tab gone */ }
        }

        respond(
          await commandManager.execute(
            {
              type: 'move-tab',
              timestamp: Date.now(),
              data: {
                tabIds,
                toWindowId: message.windowId,
                toIndex: message.index,
                sources
              }
            },
            async () => chrome.tabs.move(tabIds, {
              windowId: message.windowId,
              index: message.index,
            })
          )
        );
        break;
      }
      case 'assign-group': {
        const tabIds = Array.isArray(message.tabIds) ? message.tabIds : [message.tabId];
        // Capture old groups
        const sources = [];
        for (const tid of tabIds) {
          try {
            const t = await chrome.tabs.get(tid);
            sources.push({ tabId: tid, groupId: t.groupId });
          } catch (e) { /* ignore */ }
        }

        respond(
          await commandManager.execute(
            {
              type: 'assign-group',
              timestamp: Date.now(),
              data: { message, sources }
            },
            async () => assignToGroup(message)
          )
        );
        break;
      }
      case 'focus-tab': {
        const tab = await chrome.tabs.get(message.tabId);
        await chrome.tabs.update(message.tabId, { active: true });
        if (tab?.windowId) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        respond(true);
        break;
      }
      case 'save-markdown':
        respond(await saveMarkdownForTabs(message.tabIds || []));
        break;
      case 'move-group': {
        const { groupId, windowId, index } = message;
        // Capture old position
        // TabGroup object doesn't have index, but we can infer or we might not need strict index restore?
        // Wait, TabGroup DOES have windowId. Index? Not directly exposed in all APIs or versions.
        // Actually chrome.tabGroups.get returns simple object. 
        // But we can just move it back to old window. Index might be lost or approximated.
        // Let's try to get it if possible, but standard API chrome.tabGroups.get properties: collapsed, color, id, title, windowId.
        // No index. To find index, we'd need to check the index of the first tab in group? 
        // The implementation moves group by moving tabs? No, `chrome.tabGroups.move`.
        // Let's assume restoration to windowId is sufficient for MVP, or find first tab index.
        const group = await chrome.tabGroups.get(groupId);
        const tabs = await chrome.tabs.query({ groupId });
        const firstTab = tabs.sort((a, b) => a.index - b.index)[0];
        const oldIndex = firstTab ? firstTab.index : -1;

        respond(
          await commandManager.execute(
            {
              type: 'move-group',
              timestamp: Date.now(),
              data: { groupId, toWindowId: windowId, toIndex: index, fromWindowId: group.windowId, fromIndex: oldIndex }
            },
            async () => chrome.tabGroups.move(groupId, { index: index, windowId: windowId })
          )
        );
        break;
      }
      case 'move-to-new-window': {
        const { kind, groupId, windowId } = message;
        // Capture sources
        let sources = [];
        let tabIds = [];

        if (kind === 'tab') {
          tabIds = [message.tabId];
        } else if (kind === 'tabs') {
          tabIds = message.tabIds;
        } else if (kind === 'group') {
          const groupTabs = await chrome.tabs.query({ groupId });
          tabIds = groupTabs.map(t => t.id);
        }

        for (const tid of tabIds) {
          try {
            const t = await chrome.tabs.get(tid);
            sources.push({ tabId: tid, windowId: t.windowId, index: t.index });
          } catch (e) { /* ignore */ }
        }

        const command = {
          type: 'move-to-new-window',
          timestamp: Date.now(),
          data: { kind, tabIds, sources }
        };

        respond(
          await commandManager.execute(command, async () => {
            let result;
            if (kind === 'tab') {
              result = await chrome.windows.create({ tabId: message.tabId });
            } else if (kind === 'tabs') {
              const first = tabIds[0];
              const others = tabIds.slice(1);
              result = await chrome.windows.create({ tabId: first });
              if (others.length) {
                await chrome.tabs.move(others, { windowId: result.id, index: -1 });
              }
            } else if (kind === 'group') {
              result = await moveGroupToNewWindow(groupId, windowId);
            } else {
              throw new Error('Unknown move target');
            }

            command.data.newWindowId = result.id; // Capture new window ID
            await refocusManager(sender);
            return result;
          })
        );
        break;
      }
      case 'toast':
        if (message.message) {
          console.info('[Tab Manager]', message.message);
        }
        respond(true);
        break;
      case 'close-tabs': {
        const tabIds = Array.isArray(message.tabIds) ? message.tabIds : [];
        if (!tabIds.length) {
          respond([]);
          break;
        }

        // Capture tab info
        const tabs = [];
        for (const id of tabIds) {
          try {
            const t = await chrome.tabs.get(id);
            tabs.push({
              url: t.url || t.pendingUrl,
              windowId: t.windowId,
              index: t.index,
              pinned: t.pinned,
              title: t.title
            });
          } catch (e) {/* ignore */ }
        }

        respond(
          await commandManager.execute(
            {
              type: 'close-tabs',
              timestamp: Date.now(),
              data: { tabIds, tabs }
            },
            async () => {
              const results = [];
              for (const tabId of tabIds) {
                try {
                  await chrome.tabs.remove(tabId);
                  results.push({ tabId, success: true });
                } catch (err) {
                  results.push({ tabId, success: false, error: err.message || String(err) });
                }
              }
              return results;
            }
          )
        );
        break;
      }
      case 'create-window': {
        const command = { type: 'create-window', timestamp: Date.now(), data: {} };
        respond(
          await commandManager.execute(command, async () => {
            const win = await chrome.windows.create({});
            command.data.newWindowId = win.id;
            return win;
          })
        );
        break;
      }
      case 'undo':
        try {
          await commandManager.undo();
          respond(true);
        } catch (e) { respond(e, true); }
        break;
      case 'redo':
        try {
          await commandManager.redo();
          respond(true);
        } catch (e) { respond(e, true); }
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
