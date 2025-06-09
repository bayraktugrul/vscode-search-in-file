import * as vscode from 'vscode';
import { SearchModal } from './searchModal';

export function activate(context: vscode.ExtensionContext) {
    const searchCommand = vscode.commands.registerCommand('jetbrainsSearch.searchEverywhere', async () => {
        SearchModal.createOrShow(context);
    });
    
    context.subscriptions.push(searchCommand);
}

export function deactivate() {} 