import * as vscode from 'vscode';

export enum SearchType {
    Text = 'text'
}

export interface SearchResult extends vscode.QuickPickItem {
    type: SearchType;
    uri?: vscode.Uri;
    range?: vscode.Range;
    command?: string;
    score?: number;
} 