import * as vscode from 'vscode';
import { SearchProvider } from './searchProvider';
import { SearchResult, SearchType } from './types';

export function activate(context: vscode.ExtensionContext) {
    const searchProvider = new SearchProvider();
    
    const disposable = vscode.commands.registerCommand('jetbrainsSearch.searchEverywhere', async () => {
        const quickPick = vscode.window.createQuickPick<SearchResult>();
        quickPick.placeholder = 'Search text in files...';
        quickPick.matchOnDescription = true;
        quickPick.matchOnDetail = true;
        
        const updateItems = async (query: string) => {
            if (query.length < 2) {
                quickPick.items = [];
                return;
            }
            
            quickPick.busy = true;
            try {
                const results = await searchProvider.search(query);
                quickPick.items = results;
            } catch (error) {
                console.error('Search error:', error);
                quickPick.items = [];
            } finally {
                quickPick.busy = false;
            }
        };
        
        quickPick.onDidChangeValue(updateItems);
        
        quickPick.onDidAccept(() => {
            const selected = quickPick.selectedItems[0];
            if (selected) {
                handleSelection(selected);
            }
            quickPick.hide();
        });
        

        
        quickPick.show();
    });
    
    context.subscriptions.push(disposable);
}

async function handleSelection(result: SearchResult) {
    if (result.uri && result.range) {
        const document = await vscode.workspace.openTextDocument(result.uri);
        const editor = await vscode.window.showTextDocument(document);
        editor.selection = new vscode.Selection(result.range.start, result.range.end);
        editor.revealRange(result.range);
    }
}

export function deactivate() {} 