const WINDOW_TITLES_KEY = 'tab-manager:window-titles';
const MANAGER_URL = chrome.runtime.getURL('manager.html');
let storagePromise = Promise.resolve();

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
      case 'rename-window':
        respond(await saveWindowTitle(message.windowId, message.title));
        break;
      case 'rename-group':
        respond(await chrome.tabGroups.update(message.groupId, { title: message.title || '' }));
        break;
      case 'update-group':
        respond(await chrome.tabGroups.update(message.groupId, message.updateProperties));
        break;
      case 'move-tab': {
        const tabIds = Array.isArray(message.tabIds) ? message.tabIds : [message.tabId];
        respond(
          await chrome.tabs.move(tabIds, {
            windowId: message.windowId,
            index: message.index,
          }),
        );
        break;
      }
      case 'assign-group':
        respond(await assignToGroup(message));
        break;
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
      case 'move-group':
        respond(await chrome.tabGroups.move(message.groupId, { index: message.index, windowId: message.windowId }));
        break;
      case 'move-to-new-window': {
        let result;
        if (message.kind === 'tab') {
          result = await chrome.windows.create({ tabId: message.tabId });
        } else if (message.kind === 'tabs') {
          const tabIds = message.tabIds;
          const first = tabIds[0];
          const others = tabIds.slice(1);
          result = await chrome.windows.create({ tabId: first });
          if (others.length) {
            await chrome.tabs.move(others, { windowId: result.id, index: -1 });
          }
        } else if (message.kind === 'group') {
          result = await moveGroupToNewWindow(message.groupId, message.windowId);
        } else {
          throw new Error('Unknown move target');
        }
        await refocusManager(sender);
        respond(result);
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
        const results = [];
        for (const tabId of tabIds) {
          try {
            await chrome.tabs.remove(tabId);
            results.push({ tabId, success: true });
          } catch (err) {
            results.push({ tabId, success: false, error: err.message || String(err) });
          }
        }
        respond(results);
        break;
      }
      case 'create-window':
        respond(await chrome.windows.create({}));
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
