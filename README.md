# EasySearch - Search in Files

Fast and powerful file search extension with JetBrains-like functionality. Search text across all files in your workspace with instant results and navigation.

## Demo

![EasySearch Demo](https://github.com/user-attachments/assets/3469a14f-1c90-49c4-960c-6f21019f7985)

*See EasySearch in action: Press `Shift+F`, type your search query, navigate with arrow keys, and open files instantly!*

## Features

- **Lightning Fast Search**: Optimized file indexing and search algorithms for instant results
- **Smart Navigation**: Use arrow keys to navigate through search results
- **Real-time Results**: See search results as you type with intelligent debouncing
- **Performance Optimized**: 
  - Batch processing for large codebases
  - Memory-efficient file indexing with cleanup
  - Automatic search cancellation to prevent freezing
- **User-Friendly Interface**: Clean, intuitive search modal with highlighted matches
- **Keyboard Shortcuts**: Quick access with `Shift+F` shortcut
- **Multi-line Search Support**: Search across multiple lines in files
- **Safe Search**: Handles special characters and regex patterns safely

## Installation

1. Open Visual Studio Code
2. Go to Extensions (Ctrl+Shift+X)
3. Search for "EasySearch - Search in Files"
4. Click Install

## Usage

### Quick Start

1. Press `Shift+F` to open the search modal
2. Type your search query
3. Use arrow keys (↑/↓) to navigate through results
4. Press `Enter` to open the selected file
5. Press `Escape` to close the search modal

### Commands

- **EasySearch: Find in Files** - Opens the search interface

### Keyboard Shortcuts

- `Shift+F` - Open search modal
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