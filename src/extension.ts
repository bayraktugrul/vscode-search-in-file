import * as vscode from 'vscode';
import { SearchModal } from './searchModal';

export function activate(context: vscode.ExtensionContext) {
    const searchCommand = vscode.commands.registerCommand('easySearch.searchInFiles', async () => {
        SearchModal.createOrShow(context);
    });
    
    context.subscriptions.push(searchCommand);
}

export function deactivate() {} 