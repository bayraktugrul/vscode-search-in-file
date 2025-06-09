import * as vscode from 'vscode';
import * as path from 'path';

export class SearchResultsProvider implements vscode.TreeDataProvider<SearchResultItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<SearchResultItem | undefined | null | void> = new vscode.EventEmitter<SearchResultItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<SearchResultItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private results: Map<string, SearchResultItem[]> = new Map();
    private query: string = '';

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    setResults(query: string, results: SearchResultItem[]): void {
        this.query = query;
        this.results.clear();
        
        const groupedResults = new Map<string, SearchResultItem[]>();
        for (const result of results) {
            const filePath = result.filePath;
            if (!groupedResults.has(filePath)) {
                groupedResults.set(filePath, []);
            }
            groupedResults.get(filePath)!.push(result);
        }
        
        this.results = groupedResults;
        this.refresh();
    }

    getTreeItem(element: SearchResultItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: SearchResultItem): Thenable<SearchResultItem[]> {
        if (!element) {
            const fileItems: SearchResultItem[] = [];
            for (const [filePath, matches] of this.results) {
                const fileName = path.basename(filePath);
                const relativePath = vscode.workspace.asRelativePath(filePath);
                
                const fileItem = new SearchResultItem(
                    `${fileName} (${matches.length} matches)`,
                    vscode.TreeItemCollapsibleState.Expanded,
                    'file',
                    filePath,
                    0,
                    relativePath
                );
                fileItems.push(fileItem);
            }
            return Promise.resolve(fileItems);
        } else if (element.type === 'file') {
            const matches = this.results.get(element.filePath) || [];
            return Promise.resolve(matches);
        }
        
        return Promise.resolve([]);
    }
}

export class SearchResultItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type: 'file' | 'match',
        public readonly filePath: string,
        public readonly lineNumber: number,
        public readonly description?: string,
        public readonly matchText?: string
    ) {
        super(label, collapsibleState);
        
        this.tooltip = this.description || this.label;
        this.description = description;
        
        if (type === 'file') {
            this.iconPath = new vscode.ThemeIcon('file');
            this.contextValue = 'searchFile';
        } else {
            this.iconPath = new vscode.ThemeIcon('search');
            this.contextValue = 'searchMatch';
            this.command = {
                command: 'jetbrainsSearch.openMatch',
                title: 'Open Match',
                arguments: [this.filePath, this.lineNumber]
            };
        }
    }
} 