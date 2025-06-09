import * as vscode from 'vscode';
import { SearchProvider } from './searchProvider';

export class SearchModal {
    private static currentModal: SearchModal | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly searchProvider: SearchProvider;
    private disposables: vscode.Disposable[] = [];
    private currentResults: any[] = [];

    public static createOrShow(context: vscode.ExtensionContext): SearchModal {
        if (SearchModal.currentModal) {
            SearchModal.currentModal.panel.reveal(vscode.ViewColumn.One);
            return SearchModal.currentModal;
        }

        const panel = vscode.window.createWebviewPanel(
            'jetbrainsSearchModal',
            'Find in Files',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [context.extensionUri]
            }
        );

        SearchModal.currentModal = new SearchModal(panel, context);
        return SearchModal.currentModal;
    }

    private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
        this.panel = panel;
        this.searchProvider = new SearchProvider();

        this.panel.webview.html = this.getWebviewContent();
        
        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'search':
                        await this.performSearch(message.query);
                        break;
                    case 'selectFile':
                        await this.showFilePreview(message.filePath, message.lineNumber, message.query);
                        break;
                    case 'openFile':
                        await this.openFile(message.filePath, message.lineNumber);
                        break;
                }
            },
            undefined,
            this.disposables
        );

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    private async performSearch(query: string): Promise<void> {
        if (query.length < 2) {
            this.currentResults = [];
            this.panel.webview.postMessage({
                type: 'searchResults',
                results: [],
                query: query
            });
            return;
        }

        try {
            const results = await this.searchProvider.search(query);
            this.currentResults = results.map(r => ({
                filePath: r.uri?.fsPath || '',
                fileName: r.uri ? require('path').basename(r.uri.fsPath) : '',
                relativePath: r.uri ? vscode.workspace.asRelativePath(r.uri) : '',
                lineNumber: r.range ? r.range.start.line + 1 : 1,
                lineText: r.detail || '',
                range: r.range
            }));

            this.panel.webview.postMessage({
                type: 'searchResults',
                results: this.currentResults,
                query: query
            });

            if (this.currentResults.length > 0) {
                await this.showFilePreview(
                    this.currentResults[0].filePath,
                    this.currentResults[0].lineNumber,
                    query
                );
            }
        } catch (error) {
            console.error('Search error:', error);
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
                fileName: require('path').basename(filePath),
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
            
            let searchTimeout;
            let currentResults = [];
            let selectedIndex = 0;
            searchInput.focus();
            
            searchInput.addEventListener('input', (e) => {
                clearTimeout(searchTimeout);
                searchTimeout = setTimeout(() => {
                    vscode.postMessage({
                        type: 'search',
                        query: e.target.value
                    });
                }, 300);
            });
            
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    navigateResults(1);
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    navigateResults(-1);
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    if (currentResults[selectedIndex]) {
                        openCurrentFile();
                    }
                }
            });
            
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
                    currentResults = message.results;
                    selectedIndex = 0;
                    renderResults(message.results, message.query);
                } else if (message.type === 'filePreview') {
                    renderPreview(message);
                }
            });
            
            function renderResults(results, query) {
                if (results.length === 0) {
                    resultsContainer.innerHTML = '<div class="empty-state">No results found</div>';
                    return;
                }
                
                const html = results.map((result, index) => 
                    '<div class="result-item ' + (index === 0 ? 'selected' : '') + '" onclick="selectResult(' + index + ')" ondblclick="openResult(' + index + ')">' +
                        '<span class="result-icon">📄</span>' +
                        '<div class="result-info">' +
                            '<div class="result-file">' + result.fileName + ':' + result.lineNumber + '</div>' +
                            '<div class="result-path">' + result.relativePath + '</div>' +
                            '<div class="result-line">' + highlightText(result.lineText, query) + '</div>' +
                        '</div>' +
                    '</div>'
                ).join('');
                
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
            
            function renderPreview(data) {
                previewHeader.textContent = data.fileName;
                
                const lines = data.content.split('\\n');
                const html = lines.map((line, index) => {
                    const lineNumber = index + 1;
                    const isHighlight = lineNumber === data.lineNumber;
                    const highlightedLine = highlightText(line, data.query);
                    
                    return '<div class="code-line ' + (isHighlight ? 'highlight' : '') + '" data-line="' + lineNumber + '">' +
                        '<span class="line-number">' + lineNumber + '</span>' +
                        '<span class="line-content">' + highlightedLine + '</span>' +
                    '</div>';
                }).join('');
                
                previewContent.innerHTML = html;
                
                setTimeout(() => {
                    const highlightLine = previewContent.querySelector('.highlight');
                    if (highlightLine) {
                        highlightLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                }, 100);
            }
            
            function highlightText(text, query) {
                if (!query || query.length < 2) return escapeHtml(text);
                
                const escapedText = escapeHtml(text);
                const escapedQuery = escapeHtml(query);
                
                const parts = escapedText.split(new RegExp('(' + escapedQuery + ')', 'gi'));
                return parts.map(part => {
                    if (part.toLowerCase() === escapedQuery.toLowerCase()) {
                        return '<span class="search-highlight">' + part + '</span>';
                    }
                    return part;
                }).join('');
            }
            
            function escapeHtml(text) {
                const div = document.createElement('div');
                div.textContent = text;
                return div.innerHTML;
            }
            
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
                    font-family: var(--vscode-font-family);
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    height: 100vh;
                    display: flex;
                    flex-direction: column;
                }
                
                .search-container {
                    padding: 10px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                
                .search-input {
                    width: 100%;
                    padding: 8px;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 3px;
                    font-size: 13px;
                }
                
                .search-input:focus {
                    outline: none;
                    border-color: var(--vscode-focusBorder);
                }
                
                .content-container {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                }
                
                .results-container {
                    flex: 1;
                    overflow-y: auto;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    max-height: 40%;
                }
                
                .result-item {
                    padding: 6px 12px;
                    cursor: pointer;
                    border-bottom: 1px solid var(--vscode-list-inactiveSelectionBackground);
                    display: flex;
                    align-items: center;
                    user-select: none;
                }
                
                .result-item:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                
                .result-item.selected {
                    background-color: var(--vscode-list-activeSelectionBackground);
                    color: var(--vscode-list-activeSelectionForeground);
                }
                
                .result-icon {
                    margin-right: 8px;
                    opacity: 0.7;
                }
                
                .result-info {
                    flex: 1;
                }
                
                .result-file {
                    font-weight: 500;
                    margin-bottom: 2px;
                }
                
                .result-path {
                    font-size: 11px;
                    opacity: 0.7;
                }
                
                .result-line {
                    font-size: 11px;
                    opacity: 0.8;
                    font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
                }
                
                .preview-container {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                }
                
                .preview-header {
                    padding: 8px 12px;
                    background-color: var(--vscode-editorGroupHeader-tabsBackground);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    font-size: 12px;
                }
                
                .preview-content {
                    flex: 1;
                    overflow: auto;
                    padding: 0;
                    font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
                    font-size: 12px;
                    line-height: 1.4;
                }
                
                .code-line {
                    display: flex;
                    min-height: 18px;
                    padding: 0 8px;
                }
                
                .code-line:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                
                .code-line.highlight {
                    background-color: var(--vscode-editor-lineHighlightBackground);
                    border-left: 3px solid var(--vscode-textLink-foreground);
                }
                
                .line-number {
                    color: var(--vscode-editorLineNumber-foreground);
                    min-width: 50px;
                    text-align: right;
                    padding-right: 12px;
                    user-select: none;
                    flex-shrink: 0;
                }
                
                .line-content {
                    flex: 1;
                    white-space: pre;
                    overflow-x: auto;
                }
                
                .search-highlight {
                    background-color: var(--vscode-editor-findMatchHighlightBackground);
                    color: var(--vscode-editor-findMatchForeground);
                    border-radius: 2px;
                    padding: 1px;
                }
                
                .empty-state {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    height: 100%;
                    color: var(--vscode-descriptionForeground);
                    font-style: italic;
                }
            </style>
        </head>
        <body>
            <div class="search-container">
                <input type="text" class="search-input" placeholder="Type to search in files..." autofocus>
            </div>
            
            <div class="content-container">
                <div class="results-container">
                    <div class="empty-state">Start typing to search...</div>
                </div>
                
                <div class="preview-container">
                    <div class="preview-header">Select a file to preview</div>
                    <div class="preview-content">
                        <div class="empty-state">No preview available</div>
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
        this.panel.dispose();

        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
} 