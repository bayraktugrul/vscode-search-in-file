# EasySearch - Search in Files

Fast and powerful file search extension with JetBrains-like functionality. Search text across all files in your workspace with instant results and navigation.

## Demo

 <img src="https://github.com/bayraktugrul/vscode-search-in-file/blob/main/images/demo-comp.gif?raw=true" width="650" height="400" alt="demo"/>

*See EasySearch in action: Press `Cmd+Shift+F` (macOS) or `Ctrl+Shift+F` (Windows/Linux), type your search query, navigate with arrow keys, and open files instantly!*

## Features

- **Lightning Fast Search**: Optimized file indexing and search algorithms for instant results
- **Smart Navigation**: Use arrow keys to navigate through search results
- **Real-time Results**: See search results as you type with intelligent debouncing
- **Performance Optimized**: 
  - Batch processing for large codebases
  - Memory-efficient file indexing with cleanup
  - Automatic search cancellation to prevent freezing
- **User-Friendly Interface**: Clean, intuitive search modal with highlighted matches
- **Keyboard Shortcuts**: Quick access with `Cmd+Shift+F` (macOS) or `Ctrl+Shift+F` (Windows/Linux) shortcut
- **Multi-line Search Support**: Search across multiple lines in files
- **Safe Search**: Handles special characters and regex patterns safely

## Installation

1. Open Visual Studio Code
2. Go to Extensions (Ctrl+Shift+X)
3. Search for "EasySearch - Search in Files"
4. Click Install

## Usage

### Quick Start

1. Press `Cmd+Shift+F` (macOS) or `Ctrl+Shift+F` (Windows/Linux) to open the search modal
2. Type your search query
3. Use arrow keys (↑/↓) to navigate through results
4. Press `Enter` to open the selected file
5. Press `Escape` to close the search modal

### Commands

- **EasySearch: Find in Files** - Opens the search interface

### Keyboard Shortcuts

- `Cmd+Shift+F` (macOS) / `Ctrl+Shift+F` (Windows/Linux) - Open search modal
- `↑/↓` Arrow keys - Navigate search results
- `Enter` - Open selected file at the matching line
- `Escape` - Close search modal

## Performance Features

- **File Indexing**: Intelligent caching system to avoid re-reading unchanged files
- **Batch Processing**: Processes files in batches of 20 for optimal performance
- **Memory Management**: Automatic cleanup of old index entries every 5 minutes
- **Search Cancellation**: Cancels previous searches when starting new ones
- **Size Limits**: Respects file size limits (512KB max) and total index limits (5000 files max)

## Requirements

- Visual Studio Code 1.74.0 or higher
- Node.js (for development)

## Extension Settings

This extension doesn't require any configuration - it works out of the box!

## Customizing Keybindings

You can customize the keyboard shortcut to your preference:

### Method 1: Using VS Code UI
1. Open Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Windows/Linux)
2. Type "Preferences: Open Keyboard Shortcuts" and select it
3. Search for "EasySearch" or "searchInFiles"
4. Click the pencil icon next to the command
5. Press your desired key combination
6. Press `Enter` to save

### Method 2: Using keybindings.json
1. Open Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Windows/Linux)
2. Type "Preferences: Open Keyboard Shortcuts (JSON)" and select it
3. Add your custom keybinding:

```json
{
    "key": "your-preferred-shortcut",
    "command": "easySearch.searchInFiles"
}
```

**Example custom keybindings:**
- `"key": "alt+f"` - Alt+F
- `"key": "cmd+f cmd+f"` - Double Cmd+F (chord)
- `"key": "ctrl+alt+s"` - Ctrl+Alt+S

## Known Issues

None currently. If you encounter any issues, please report them in the repository.

## Release Notes

### 1.0.0

Initial release of EasySearch - Search in Files

- Fast file search with JetBrains-like functionality
- Optimized performance with file indexing
- Memory-efficient batch processing
- Safe handling of special characters
- Intuitive keyboard navigation

## Contributing

This is an open source project. Contributions are welcome.

## License

MIT License

---

**Enjoy fast and efficient file searching with EasySearch!** 