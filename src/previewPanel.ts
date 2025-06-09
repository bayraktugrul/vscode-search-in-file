import * as vscode from 'vscode';
import * as path from 'path';

export class PreviewPanel {
    private static currentPanel: PreviewPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri): PreviewPanel {
        const column = vscode.ViewColumn.Two;

        if (PreviewPanel.currentPanel) {
            PreviewPanel.currentPanel.panel.reveal(column);
            return PreviewPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            'jetbrainsSearchPreview',
            'Search Preview',
            column,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri]
            }
        );

        PreviewPanel.currentPanel = new PreviewPanel(panel, extensionUri);
        return PreviewPanel.currentPanel;
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this.panel = panel;

        this.update();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    public async showFileContent(filePath: string, lineNumber?: number, searchTerm?: string): Promise<void> {
        try {
            const uri = vscode.Uri.file(filePath);
            const document = await vscode.workspace.openTextDocument(uri);
            const content = document.getText();
            const fileName = path.basename(filePath);
            const relativePath = vscode.workspace.asRelativePath(filePath);
            
            this.panel.webview.html = this.getWebviewContent(
                fileName, 
                relativePath, 
                content, 
                lineNumber, 
                searchTerm
            );
            
            this.panel.reveal(vscode.ViewColumn.Two);
        } catch (error) {
            this.panel.webview.html = this.getErrorContent(`Failed to load file: ${error}`);
        }
    }

    public showEmpty(): void {
        this.panel.webview.html = this.getEmptyContent();
    }

    private update(): void {
        this.panel.webview.html = this.getEmptyContent();
    }

    private getWebviewContent(fileName: string, relativePath: string, content: string, highlightLine?: number, searchTerm?: string): string {
        const lines = content.split('\n');
        let htmlLines = lines.map((line, index) => {
            const lineNumber = index + 1;
            let htmlLine = this.escapeHtml(line);
            
            if (searchTerm) {
                const regex = new RegExp(`(${this.escapeRegex(searchTerm)})`, 'gi');
                htmlLine = htmlLine.replace(regex, '<mark class="highlight">$1</mark>');
            }
            
            const isHighlighted = highlightLine === lineNumber;
            return `<div class="line ${isHighlighted ? 'current-line' : ''}" data-line="${lineNumber}">
                        <span class="line-number">${lineNumber}</span>
                        <span class="line-content">${htmlLine || '&nbsp;'}</span>
                    </div>`;
        }).join('');

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Preview</title>
            <style>
                body {
                    font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
                    font-size: 12px;
                    line-height: 1.4;
                    margin: 0;
                    padding: 10px;
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                }
                .header {
                    padding: 10px 0;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    margin-bottom: 10px;
                }
                .file-name {
                    font-weight: bold;
                    color: var(--vscode-textLink-foreground);
                }
                .file-path {
                    color: var(--vscode-descriptionForeground);
                    font-size: 11px;
                }
                .content {
                    white-space: pre;
                    overflow-x: auto;
                }
                .line {
                    display: flex;
                    min-height: 17px;
                }
                .line:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                .current-line {
                    background-color: var(--vscode-editor-lineHighlightBackground) !important;
                    border-left: 3px solid var(--vscode-textLink-foreground);
                }
                .line-number {
                    color: var(--vscode-editorLineNumber-foreground);
                    min-width: 40px;
                    text-align: right;
                    padding-right: 10px;
                    user-select: none;
                    flex-shrink: 0;
                }
                .line-content {
                    flex-grow: 1;
                    white-space: pre;
                }
                .highlight {
                    background-color: var(--vscode-editor-findMatchHighlightBackground);
                    color: var(--vscode-editor-findMatchForeground);
                    border-radius: 2px;
                    padding: 1px 2px;
                }
            </style>
        </head>
        <body>
            <div class="header">
                <div class="file-name">${fileName}</div>
                <div class="file-path">${relativePath}</div>
            </div>
            <div class="content">
                ${htmlLines}
            </div>
            <script>
                ${highlightLine ? `
                    const currentLine = document.querySelector('[data-line="${highlightLine}"]');
                    if (currentLine) {
                        currentLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                ` : ''}
            </script>
        </body>
        </html>`;
    }

    private getEmptyContent(): string {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Preview</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    font-size: 13px;
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    height: 100vh;
                    margin: 0;
                }
                .empty-message {
                    text-align: center;
                    color: var(--vscode-descriptionForeground);
                }
            </style>
        </head>
        <body>
            <div class="empty-message">
                <p>Select a file to preview its content</p>
            </div>
        </body>
        </html>`;
    }

    private getErrorContent(error: string): string {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Error</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-errorForeground);
                    padding: 20px;
                }
            </style>
        </head>
        <body>
            <h3>Error</h3>
            <p>${this.escapeHtml(error)}</p>
        </body>
        </html>`;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    private escapeRegex(text: string): string {
        return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    public dispose(): void {
        PreviewPanel.currentPanel = undefined;

        this.panel.dispose();

        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
} 