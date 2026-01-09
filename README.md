# Heaps O' Tabs

**Boldly Manage Heaps of Tabs (HOTs)**

A powerful, performance-focused Chromium extension for managing massive numbers of open tabs and windows. Built with vanilla JavaScript for maximum speed and minimal overhead.

## Key Features

### 🚀 High Performance

* **Progressive Rendering**: Handles hundreds of open tabs smoothly by rendering them in chunks during idle time.
* **Interactive vs. Read-Only Modes**:
  * **Read-Only (Default)**: A lightweight, text-only view for quick scanning. Displays favicons (greyscale) and URLs.
  * **Interactive (Eye Toggle)**: Switch any window to full interactive mode to enable drag-and-drop, selection, and management.

### 🛠️ Powerful Management

* **Drag & Drop**: Move tabs between windows, into groups, or create new windows by dropping into empty spaces.
* **Tab Groups**: First-class support for Native Chrome Tab Groups.
* **Bulk Actions**: Select multiple tabs or groups to Close, Group, or Move them in batch.
* **Undo/Redo**: Accidentally closed a tab or moved a group? Press `Ctrl+Z` (or `Cmd+Z` on Mac) to undo.

### 📊 Visualization & context

* **Window Ordering**: Numbered window cards (`[1]`, `[2]`) to match your physical window layout.
* **Visual Feedback**: Beautiful toast notifications for all actions.
* **Trace History**: (Optional) Color-code tabs and windows based on recency of access.

### 💾 Export

* **Save Session**: Export the URLs of a specific window or all windows to Markdown/Text to save for later.

## Installation

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **"Developer mode"** in the top right corner.
4. Click **"Load unpacked"**.
5. Select the folder containing this project.

## Usage Guide

* **Toggle Modes**: Click the **Eye Icon** (👁️/🔒) in the window header to switch between Read-Only and Interactive modes.
* **Keyboard Shortcuts**:
  * `Cmd/Ctrl + Z`: Undo last action.
  * `Cmd/Ctrl + Shift + Z`: Redo last action.
* **Selection**: Check the box next to tabs to select them. Use the header actions to Close (🗑️), Group (🏷️), or Save (📥) selected items.
* **Settings**: Click the gear icon to configure options like "Show Window Order Numbers" or "Trace History".

## License

MIT License
