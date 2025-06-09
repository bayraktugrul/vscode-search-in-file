import * as vscode from 'vscode';
import { SearchResult, SearchType } from './types';
import { TextSearcher } from './textSearcher';

export class SearchProvider {
    private textSearcher: TextSearcher;

    constructor() {
        this.textSearcher = new TextSearcher();
    }

    async search(query: string): Promise<SearchResult[]> {
        return await this.textSearcher.search(query);
    }


} 