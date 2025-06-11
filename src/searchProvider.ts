import * as vscode from 'vscode';
import { SearchResult, SearchType } from './types';
import { TextSearcher } from './textSearcher';

export class SearchProvider {
    private textSearcher: TextSearcher;
    private progressCallback?: (message: string, progress?: number) => void;

    constructor(context: vscode.ExtensionContext) {
        this.textSearcher = new TextSearcher(context);
        
        // Set up progress reporting
        this.textSearcher.setProgressCallback((message: string, progress?: number) => {
            if (this.progressCallback) {
                this.progressCallback(message, progress);
            }
        });
    }

    public setProgressCallback(callback: (message: string, progress?: number) => void): void {
        this.progressCallback = callback;
    }

    async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
        try {
            // Ensure searcher is ready before starting search
            await this.textSearcher.waitForReady();
            return await this.textSearcher.search(query, signal);
        } catch (error) {
            if (signal?.aborted) {
                throw new Error('Search cancelled');
            }
            console.error('Search provider error:', error);
            throw error;
        }
    }

    public getSearchState() {
        return this.textSearcher.getSearchState();
    }

    public async waitForReady(): Promise<void> {
        await this.textSearcher.waitForReady();
    }

    public async setCaseSensitive(caseSensitive: boolean): Promise<void> {
        await this.textSearcher.setCaseSensitive(caseSensitive);
    }

    public getCaseSensitive(): boolean {
        return this.textSearcher.getCaseSensitive();
    }

    public async setExcludePatterns(patterns: string[], enabled: boolean): Promise<void> {
        await this.textSearcher.setExcludePatterns(patterns, enabled);
    }

    public async getExcludePatterns(): Promise<{patterns: string[], enabled: boolean}> {
        return await this.textSearcher.getExcludePatterns();
    }

    public dispose(): void {
        this.textSearcher.dispose();
    }
} 