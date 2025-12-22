# Project Overview

This is a Chrome extension that provides a user interface for managing browser windows and tabs. It allows users to:

*   View all open windows and their tabs.
*   Save a window or all windows as a "session" for later restoration.
*   Rename windows for better organization.
*   Drag and drop tabs between windows and groups.
*   Create, rename, and move tab groups.
*   Launch saved sessions.

The extension is built with vanilla JavaScript, HTML, and CSS. It uses the Chrome Extension APIs extensively to interact with browser tabs, tab groups, and windows. Data is stored locally using `chrome.storage.local`.

# Building and Running

This is a simple browser extension with no build process. To run it:

1.  Open Chrome and navigate to `chrome://extensions`.
2.  Enable "Developer mode".
3.  Click "Load unpacked".
4.  Select the directory containing this project.

The extension's icon will appear in the Chrome toolbar. Clicking it will open the tab manager interface.

# Development Conventions

*   The code is written in modern JavaScript (ESM).
*   The project follows a simple structure with `background.js` for the service worker, `manager.js` for the UI logic of `manager.html`, and `styles.css` for the styling.
*   Communication between the background script and the manager UI is done via `chrome.runtime.sendMessage`.
*   Asynchronous operations are handled with `async/await`.
*   There are no explicit tests in the project.
