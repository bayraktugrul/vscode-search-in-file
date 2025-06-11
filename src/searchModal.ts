import * as vscode from 'vscode';
import * as path from 'path';
import { SearchProvider } from './searchProvider';

export class SearchModal {
    private static currentModal: SearchModal | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly searchProvider: SearchProvider;
    private disposables: vscode.Disposable[] = [];
    private currentResults: any[] = [];
    private currentSearchId: number = 0;
    private abortController: AbortController | null = null;

    public static createOrShow(context: vscode.ExtensionContext): SearchModal {
        if (SearchModal.currentModal) {
            SearchModal.currentModal.panel.reveal();
            // Send focus message to existing panel
            SearchModal.currentModal.panel.webview.postMessage({
                type: 'focusSearch'
            });
            return SearchModal.currentModal;
        }

        const panel = vscode.window.createWebviewPanel(
            'easySearchModal',
            'Find in Files',
            {
                viewColumn: vscode.ViewColumn.Active,
                preserveFocus: false
            },
            {
                enableScripts: true,
                retainContextWhenHidden: false,
                localResourceRoots: [context.extensionUri]
            }
        );

        SearchModal.currentModal = new SearchModal(panel, context);
        return SearchModal.currentModal;
    }

    private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
        this.panel = panel;
        this.searchProvider = new SearchProvider(context);

        this.searchProvider.setProgressCallback((message: string, progress?: number) => {
            this.panel.webview.postMessage({
                type: 'searchProgress',
                message: message,
                progress: progress
            });
        });

        this.panel.webview.html = this.getWebviewContent();
        
        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'initializeSearch':
                        await this.initializeSearch();
                        break;
                    case 'search':
                        await this.performSearch(message.query);
                        break;
                    case 'selectFile':
                        await this.showFilePreview(message.filePath, message.lineNumber, message.query);
                        break;
                    case 'openFile':
                        await this.openFile(message.filePath, message.lineNumber);
                        break;
                    case 'close':
                        this.panel.dispose();
                        break;
                }
            },
            undefined,
            this.disposables
        );

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    private async initializeSearch(): Promise<void> {
        try {
            await this.searchProvider.waitForReady();
            this.panel.webview.postMessage({
                type: 'searchInitialized'
            });
        } catch (error) {
            console.error('Search initialization error:', error);
            this.panel.webview.postMessage({
                type: 'searchInitializationError',
                error: error instanceof Error ? error.message : 'Failed to initialize search'
            });
        }
    }

    private async performSearch(query: string): Promise<void> {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        
        const searchId = ++this.currentSearchId;
        this.abortController = new AbortController();
        
        if (query.length < 2) {
            this.currentResults = [];
            this.panel.webview.postMessage({
                type: 'searchResults',
                results: [],
                query: query,
                searchId: searchId
            });
            this.panel.webview.postMessage({
                type: 'clearPreview'
            });
            return;
        }

        try {
            const results = await this.searchProvider.search(query, this.abortController.signal);
            
            // Check if this search is still the latest one
            if (searchId !== this.currentSearchId) {
                return; // Ignore outdated results
            }
            
            this.currentResults = results.map(r => ({
                filePath: r.uri?.fsPath || '',
                fileName: r.uri ? path.basename(r.uri.fsPath) : '',
                relativePath: r.uri ? vscode.workspace.asRelativePath(r.uri) : '',
                lineNumber: r.range ? r.range.start.line + 1 : 1,
                lineText: r.detail || '',
                range: r.range
            }));

            this.panel.webview.postMessage({
                type: 'searchResults',
                results: this.currentResults,
                query: query,
                searchId: searchId
            });

            if (this.currentResults.length > 0) {
                await this.showFilePreview(
                    this.currentResults[0].filePath,
                    this.currentResults[0].lineNumber,
                    query
                );
            } else {
                // Clear preview when no results found
                this.panel.webview.postMessage({
                    type: 'clearPreview'
                });
            }
        } catch (error) {
            console.error('Search error:', error);
            
            // Check if this search is still the latest one
            if (searchId === this.currentSearchId) {
                this.panel.webview.postMessage({
                    type: 'searchError',
                    error: error instanceof Error ? error.message : 'Search failed',
                    query: query,
                    searchId: searchId
                });
                // Clear preview on error
                this.panel.webview.postMessage({
                    type: 'clearPreview'
                });
            }
        }
    }

    private async showFilePreview(filePath: string, lineNumber: number, query: string): Promise<void> {
        try {
            const uri = vscode.Uri.file(filePath);
            const document = await vscode.workspace.openTextDocument(uri);
            const content = document.getText();

            this.panel.webview.postMessage({
                type: 'filePreview',
                content: content,
                filePath: filePath,
                fileName: path.basename(filePath),
                lineNumber: lineNumber,
                query: query
            });
        } catch (error) {
            console.error('Preview error:', error);
        }
    }

    private async openFile(filePath: string, lineNumber: number): Promise<void> {
        try {
            const uri = vscode.Uri.file(filePath);
            const document = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(document, { 
                preview: false,
                preserveFocus: false 
            });
            const range = new vscode.Range(lineNumber - 1, 0, lineNumber - 1, 0);
            editor.selection = new vscode.Selection(range.start, range.end);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to open file: ${error}`);
        }
    }

    private getWebviewContent(): string {
        const scriptContent = `
            const vscode = acquireVsCodeApi();
            const searchInput = document.querySelector('.search-input');
            const resultsContainer = document.querySelector('.results-container');
            const previewHeader = document.querySelector('.preview-header');
            const previewContent = document.querySelector('.preview-content');
            const resultsCount = document.querySelector('.results-count');
            
            let searchTimeout;
            let focusTimeouts = [];
            let currentResults = [];
            let selectedIndex = 0;
            let currentSearchId = 0;
            let isSearching = false;
            let searchInitialized = false;
            
            showProgress('Initializing search index...');
            vscode.postMessage({ type: 'initializeSearch' });
            
            // Ensure focus on search input with multiple attempts
            function focusSearchInput() {
                searchInput.focus();
                searchInput.select();
            }
            
            // Try focusing immediately and with delays to ensure it works
            focusSearchInput();
            focusTimeouts.push(setTimeout(focusSearchInput, 50));
            
            function autoResize() {
                searchInput.style.height = 'auto';
                searchInput.style.height = Math.min(searchInput.scrollHeight, 80) + 'px';
            }
            
            searchInput.addEventListener('input', autoResize);
            searchInput.addEventListener('paste', () => setTimeout(autoResize, 0));
            
            searchInput.addEventListener('input', (e) => {
                clearTimeout(searchTimeout);
                const query = e.target.value;
                
                if (query.length === 0) {
                    resultsContainer.innerHTML = '<div class="empty-state"><div class="empty-text">Start typing to search...</div></div>';
                    updateResultsCount(0);
                } else if (query.length < 2) {
                    resultsContainer.innerHTML = '<div class="empty-state"><div class="empty-text">Type at least 2 characters...</div></div>';
                    updateResultsCount(0);
                } else {
                    resultsContainer.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><div class="loading-text">Searching...</div></div>';
                    updateResultsCount(0);
                }
                
                searchTimeout = setTimeout(() => {
                    if (!isSearching && searchInitialized) {
                        isSearching = true;
                        currentSearchId++;
                        vscode.postMessage({
                            type: 'search',
                            query: query,
                            searchId: currentSearchId
                        });
                    } else if (!searchInitialized && query.length >= 2) {
                         resultsContainer.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><div class="loading-text">Preparing search index...</div></div>';
                    }
                }, 150);
            });
            
             document.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    e.stopPropagation();
                    
                    if (e.key === 'ArrowDown') {
                        navigateResults(1);
                    } else if (e.key === 'ArrowUp') {
                        navigateResults(-1);
                    }
                }
            }, true);
            
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    if (e.shiftKey || e.ctrlKey || e.metaKey) {
                        // Allow new line with Shift+Enter, Ctrl+Enter, or Cmd+Enter
                        return;
                    }
                    e.preventDefault();
                    if (currentResults[selectedIndex]) {
                        openCurrentFile();
                    }
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    vscode.postMessage({ type: 'close' });
                }
            });
            
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    vscode.postMessage({ type: 'close' });
                }
            });
            
            function handleBackdropClick(event) {
                vscode.postMessage({ type: 'close' });
            }
            
            function navigateResults(direction) {
                if (currentResults.length === 0) return;
                
                selectedIndex = Math.max(0, Math.min(currentResults.length - 1, selectedIndex + direction));
                updateSelection();
                selectFile(currentResults[selectedIndex]);
            }
            
            function updateSelection() {
                document.querySelectorAll('.result-item').forEach((item, index) => {
                    item.classList.toggle('selected', index === selectedIndex);
                });
                
                const selectedItem = document.querySelector('.result-item.selected');
                if (selectedItem) {
                    selectedItem.scrollIntoView({
                        behavior: 'auto',
                        block: 'nearest',
                        inline: 'nearest'
                    });
                }
            }
            
            function updateResultsCount(count) {
                if (resultsCount) {
                    resultsCount.textContent = count > 0 ? \`\${count} result\${count === 1 ? '' : 's'}\` : '';
                }
            }
            
            function selectFile(result) {
                vscode.postMessage({
                    type: 'selectFile',
                    filePath: result.filePath,
                    lineNumber: result.lineNumber,
                    query: searchInput.value
                });
            }
            
            function openCurrentFile() {
                if (currentResults[selectedIndex]) {
                    vscode.postMessage({
                        type: 'openFile',
                        filePath: currentResults[selectedIndex].filePath,
                        lineNumber: currentResults[selectedIndex].lineNumber
                    });
                }
            }
            
            window.addEventListener('message', (event) => {
                const message = event.data;
                
                if (message.type === 'searchResults') {
                    // Only process if this is the latest search
                    if (!message.searchId || message.searchId >= currentSearchId) {
                        currentResults = message.results;
                        selectedIndex = 0;
                        renderResults(message.results, message.query);
                        updateResultsCount(message.results.length);
                        isSearching = false;
                    }
                } else if (message.type === 'searchError') {
                    // Only process if this is the latest search
                    if (!message.searchId || message.searchId >= currentSearchId) {
                        renderError(message.error);
                        isSearching = false;
                    }
                } else if (message.type === 'searchProgress') {
                   
                    showProgress(message.message, message.progress);
                } else if (message.type === 'searchInitialized') {
                  
                    searchInitialized = true;
                    resultsContainer.innerHTML = '<div class="empty-state"><div class="empty-text">Start typing to search...</div></div>';
                    focusSearchInput();
                } else if (message.type === 'searchInitializationError') {
                  
                    searchInitialized = false;
                    renderError(message.error || 'Failed to initialize search');
                } else if (message.type === 'filePreview') {
                    renderPreview(message);
                } else if (message.type === 'clearPreview') {
                    clearPreview();
                } else if (message.type === 'focusSearch') {
                    focusSearchInput();
                }
            });
            

            
            function showProgress(message, progress) {
                const progressHtml = progress !== undefined ? 
                    \`<div class="progress-bar">
                        <div class="progress-fill" style="width: \${progress}%"></div>
                    </div>\` : '';
                
                resultsContainer.innerHTML = \`<div class="loading-state">
                    <div class="loading-spinner"></div>
                    <div class="loading-text">\${message}</div>
                    \${progressHtml}
                </div>\`;
                updateResultsCount(0);
            }
            
            function renderError(errorMessage) {
                resultsContainer.innerHTML = \`<div class="empty-state">
                    <div class="empty-text">Search Error</div>
                    <div class="empty-subtext">\${errorMessage}</div>
                </div>\`;
                updateResultsCount(0);
            }
            
            function renderResults(results, query) {
                if (results.length === 0) {
                    resultsContainer.innerHTML = '<div class="empty-state"><div class="empty-text">No results found</div><div class="empty-subtext">Try a different search term</div></div>';
                    return;
                }
                
                                 const html = results.map((result, index) => {
                     return \`<div class="result-item \${index === 0 ? 'selected' : ''}" onclick="selectResult(\${index})" ondblclick="openResult(\${index})">
                         <div class="result-content">
                             <div class="result-line">\${highlightText(result.lineText.trim(), query)}</div>
                         </div>
                         <div class="result-file-info">
                             <div class="result-file">\${result.fileName}:\${result.lineNumber}</div>
                         </div>
                     </div>\`;
                 }).join('');
                
                resultsContainer.innerHTML = html;
            }
            
            function selectResult(index) {
                selectedIndex = index;
                updateSelection();
                selectFile(currentResults[index]);
            }
            
            function openResult(index) {
                if (currentResults[index]) {
                    vscode.postMessage({
                        type: 'openFile',
                        filePath: currentResults[index].filePath,
                        lineNumber: currentResults[index].lineNumber
                    });
                }
            }
            
                        function clearPreview() {
                previewHeader.innerHTML = \`
                    <div class="preview-file-info">
                        <div class="preview-file-name">Select a file to preview</div>
                    </div>
                \`;
                previewContent.innerHTML = \`
                    <div class="empty-state">
                        <div class="empty-text">No preview available</div>
                        <div class="empty-subtext">Click on a search result to preview</div>
                    </div>
                \`;
            }
            
            function renderPreview(data) {
                previewHeader.innerHTML = \`
                    <div class="preview-file-info">
                        <div class="preview-file-name">
                            \${data.fileName}
                        </div>
                        <div class="preview-file-path">\${vscode.workspace?.asRelativePath(data.filePath) || data.filePath}</div>
                    </div>
                \`;
                
                const lines = data.content.split('\\n');
                const html = lines.map((line, index) => {
                    const lineNumber = index + 1;
                    const isHighlight = lineNumber === data.lineNumber;
                    const highlightedLine = highlightText(line, data.query);
                    
                    return \`<div class="code-line \${isHighlight ? 'highlight' : ''}" data-line="\${lineNumber}">
                        <span class="line-number">\${lineNumber}</span>
                        <span class="line-content">\${highlightedLine}</span>
                    </div>\`;
                }).join('');
                
                previewContent.innerHTML = html;
                
                const highlightLine = previewContent.querySelector('.highlight');
                if (highlightLine) {
                    highlightLine.scrollIntoView({ behavior: 'auto', block: 'center' });
                }
            }
            
            function highlightText(text, query) {
                if (!query || query.length < 2) return escapeHtml(text);
                
                const escapedText = escapeHtml(text);
                const escapedQuery = escapeHtml(query);
                
                // Use indexOf for safe string matching instead of regex
                const lowerText = escapedText.toLowerCase();
                const lowerQuery = escapedQuery.toLowerCase();
                
                let result = '';
                let currentIndex = 0;
                let foundIndex = lowerText.indexOf(lowerQuery, currentIndex);
                
                while (foundIndex !== -1) {
                    // Add text before match
                    result += escapedText.substring(currentIndex, foundIndex);
                    // Add highlighted match
                    const matchText = escapedText.substring(foundIndex, foundIndex + escapedQuery.length);
                    result += '<span class="search-highlight">' + matchText + '</span>';
                    
                    currentIndex = foundIndex + escapedQuery.length;
                    foundIndex = lowerText.indexOf(lowerQuery, currentIndex);
                }
                
                // Add remaining text
                result += escapedText.substring(currentIndex);
                
                return result;
            }
            
            function escapeHtml(text) {
                if (typeof text !== 'string') return '';
                const div = document.createElement('div');
                div.textContent = text;
                return div.innerHTML;
            }
            
            function cleanup() {
                // Clear timeouts to prevent memory leaks
                if (searchTimeout) {
                    clearTimeout(searchTimeout);
                }
                focusTimeouts.forEach(timeout => clearTimeout(timeout));
                focusTimeouts = [];
                currentResults = [];
            }
            
            window.addEventListener('beforeunload', cleanup);
            
            window.selectResult = selectResult;
            window.openResult = openResult;
        `;

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Find in Files</title>
            <style>
                body {
                    margin: 0;
                    padding: 0;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', sans-serif;
                    background: rgba(0, 0, 0, 0.3);
                    color: var(--vscode-editor-foreground);
                    height: 100vh;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    overflow: hidden;
                    animation: fadeIn 0.2s ease-out;
                }
                
                @keyframes fadeIn {
                    from {
                        opacity: 0;
                        background: transparent;
                    }
                    to {
                        opacity: 1;
                        background: rgba(0, 0, 0, 0.3);
                    }
                }
                
                @keyframes slideIn {
                    from {
                        transform: scale(0.9) translateY(-20px);
                        opacity: 0;
                    }
                    to {
                        transform: scale(1) translateY(0);
                        opacity: 1;
                    }
                }
                
                .floating-window {
                    width: 900px;
                    height: 700px;
                    max-width: 90vw;
                    max-height: 85vh;
                    background: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 12px;
                    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                    position: relative;
                    animation: slideIn 0.3s ease-out;
                }
                
                .search-container {
                    padding: 12px;
                    background: var(--vscode-sideBar-background);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    position: relative;
                }
                
                .search-wrapper {
                    position: relative;
                    display: flex;
                    align-items: center;
                    gap: 12px;
                }
                
                .search-input {
                    width: 100%;
                    padding: 6px 12px;
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 4px;
                    font-size: 13px;
                    font-weight: 400;
                    transition: all 0.2s ease;
                    resize: vertical;
                    min-height: 28px;
                    max-height: 80px;
                    overflow-y: auto;
                    font-family: inherit;
                    line-height: 1.3;
                }
                
                .search-input:focus {
                    outline: none;
                    border-color: var(--vscode-focusBorder);
                }
                
                .search-input::placeholder {
                    color: var(--vscode-input-placeholderForeground);
                    opacity: 0.7;
                }
                
                .results-count {
                    color: var(--vscode-descriptionForeground);
                    font-size: 12px;
                    font-weight: 500;
                    white-space: nowrap;
                    opacity: 0.8;
                }
                
                .content-container {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                    min-height: 0;
                }
                
                .results-container {
                    flex: 0 0 45%;
                    overflow-y: auto;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    min-height: 0;
                    background: var(--vscode-sideBar-background);
                }
                
                .result-item {
                    padding: 6px 12px;
                    cursor: pointer;
                    border-bottom: 1px solid var(--vscode-list-inactiveSelectionBackground);
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    user-select: none;
                    transition: all 0.15s ease;
                    position: relative;
                    min-height: 28px;
                }
                
                .result-item:hover {
                    background: var(--vscode-list-hoverBackground);
                    transform: translateX(2px);
                }
                
                .result-item.selected {
                    background: var(--vscode-list-activeSelectionBackground);
                    color: var(--vscode-list-activeSelectionForeground);
                    border-left: 3px solid var(--vscode-textLink-foreground);
                    box-shadow: inset 0 0 10px rgba(0, 122, 255, 0.1);
                }
                
                .result-content {
                    flex: 1;
                    min-width: 0;
                    margin-right: 12px;
                }
                
                .result-line {
                    font-size: 11px;
                    font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', 'Source Code Pro', monospace;
                    color: var(--vscode-editor-foreground);
                    line-height: 1.3;
                    word-break: break-word;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                
                .result-file-info {
                    flex-shrink: 0;
                    text-align: right;
                }
                
                .result-file {
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    font-weight: 500;
                    opacity: 0.9;
                }
                
                .preview-container {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                    min-height: 0;
                    background: var(--vscode-editor-background);
                }
                
                .preview-header {
                    padding: 12px 16px;
                    background: var(--vscode-editorGroupHeader-tabsBackground);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    font-size: 13px;
                }
                
                .preview-file-info {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }
                
                .preview-file-name {
                    font-weight: 600;
                    color: var(--vscode-textLink-foreground);
                }
                
                .preview-file-path {
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    opacity: 0.8;
                }
                
                .preview-content {
                    flex: 1;
                    overflow: auto;
                    padding: 0;
                    font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', 'Source Code Pro', monospace;
                    font-size: 13px;
                    line-height: 1.5;
                    background: var(--vscode-editor-background);
                }
                
                .code-line {
                    display: flex;
                    min-height: 20px;
                    padding: 0 16px;
                    align-items: flex-start;
                    transition: background-color 0.15s ease;
                }
                
                .code-line:hover {
                    background: var(--vscode-list-hoverBackground);
                }
                
                .code-line.highlight {
                    background: var(--vscode-editor-lineHighlightBackground);
                    border-left: 3px solid var(--vscode-textLink-foreground);
                    box-shadow: inset 0 0 10px rgba(0, 122, 255, 0.1);
                }
                
                .line-number {
                    color: var(--vscode-editorLineNumber-foreground);
                    min-width: 60px;
                    text-align: right;
                    padding-right: 16px;
                    user-select: none;
                    flex-shrink: 0;
                    font-weight: 400;
                    opacity: 0.7;
                }
                
                .line-content {
                    flex: 1;
                    white-space: pre;
                    overflow-x: auto;
                    padding-top: 1px;
                }
                
                .search-highlight {
                    background: var(--vscode-editor-findMatchHighlightBackground);
                    color: var(--vscode-editor-findMatchForeground);
                    border-radius: 2px;
                    padding: 1px 2px;
                    font-weight: 500;
                }
                
                .empty-state, .loading-state {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    height: 100%;
                    padding: 20px;
                    text-align: center;
                    gap: 8px;
                }
                
                .empty-text {
                    color: var(--vscode-descriptionForeground);
                    font-size: 13px;
                    font-weight: 500;
                }
                
                .empty-subtext {
                    color: var(--vscode-descriptionForeground);
                    font-size: 11px;
                    opacity: 0.7;
                }
                
                .loading-spinner {
                    width: 32px;
                    height: 32px;
                    border: 3px solid var(--vscode-panel-border);
                    border-top: 3px solid var(--vscode-textLink-foreground);
                    border-radius: 50%;
                    animation: spin 1s linear infinite;
                    margin-bottom: 8px;
                }
                
                .loading-text {
                    color: var(--vscode-descriptionForeground);
                    font-size: 14px;
                    font-weight: 500;
                }
                
                .progress-bar {
                    width: 200px;
                    height: 4px;
                    background: var(--vscode-panel-border);
                    border-radius: 2px;
                    overflow: hidden;
                    margin-top: 12px;
                }
                
                .progress-fill {
                    height: 100%;
                    background: var(--vscode-textLink-foreground);
                    transition: width 0.3s ease;
                    border-radius: 2px;
                }
                
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
                
                ::-webkit-scrollbar {
                    width: 8px;
                    height: 8px;
                }
                
                ::-webkit-scrollbar-track {
                    background: var(--vscode-scrollbarSlider-background);
                }
                
                ::-webkit-scrollbar-thumb {
                    background: var(--vscode-scrollbarSlider-background);
                    border-radius: 4px;
                }
                
                ::-webkit-scrollbar-thumb:hover {
                    background: var(--vscode-scrollbarSlider-hoverBackground);
                }
                
                @media (max-width: 768px) {
                    .search-container {
                        padding: 12px;
                    }
                    
                    .search-input {
                        padding: 10px 10px 10px 36px;
                        font-size: 16px;
                    }
                    
                    .results-container {
                        flex: 0 0 50%;
                    }
                    
                    .result-item {
                        padding: 10px 12px;
                    }
                }
            </style>
        </head>
        <body onclick="handleBackdropClick(event)">
            <div class="floating-window" onclick="event.stopPropagation()">
                <div class="search-container">
                    <div class="search-wrapper">
                        <textarea class="search-input" placeholder="Search in files... (Shift+Enter for new line, Enter to open, Esc to close)" autofocus tabindex="0" rows="1"></textarea>
                        <div class="results-count"></div>
                    </div>
                </div>
                
                <div class="content-container">
                    <div class="results-container">
                        <div class="empty-state">
                            <div class="empty-text">Start typing to search...</div>
                        </div>
                    </div>
                    
                    <div class="preview-container">
                        <div class="preview-header">
                            <div class="preview-file-info">
                                <div class="preview-file-name">Select a file to preview</div>
                            </div>
                        </div>
                        <div class="preview-content">
                            <div class="empty-state">
                                <div class="empty-text">No preview available</div>
                                <div class="empty-subtext">Click on a search result to preview</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <script>
                ${scriptContent}
            </script>
        </body>
        </html>`;
    }



    public dispose(): void {
        SearchModal.currentModal = undefined;
        
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        
        this.currentResults = [];
        
        this.searchProvider.dispose();
        
        this.panel.dispose();

        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
} 