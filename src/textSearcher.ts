import * as vscode from 'vscode';
import { SearchResult, SearchType } from './types';
import * as path from 'path';

interface FileIndex {
    content: string;
    lines: string[];
    lastModified: number;
    uri: vscode.Uri;
    fileName: string;
    relativePath: string;
}

interface SearchState {
    isReady: boolean;
    isSearching: boolean;
    lastSearchTime: number;
    pendingSearches: number;
}

export class TextSearcher {
    private static readonly BATCH_SIZE = 50;
    private static readonly EXCLUDED_EXTENSIONS = new Set([
        '.zip', '.tar', '.gz', '.rar', '.7z',
        '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico',
        '.mp3', '.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv',
        '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
        '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
        '.db', '.sqlite', '.sqlite3',
        '.woff', '.woff2', '.ttf', '.otf', '.eot'
    ]);

    private fileIndex = new Map<string, FileIndex>();
    private isIndexing = false;
    private lastIndexTime = 0;
    private indexingPromise: Promise<void> | null = null;
    private static readonly MAX_INDEX_SIZE = 8000;
    private static readonly MAX_FILE_SIZE = 1024 * 1024;
    private static readonly INDEX_CLEANUP_INTERVAL = 300000;
    private lastCleanupTime = 0;
    
    private searchState: SearchState = {
        isReady: false,
        isSearching: false,
        lastSearchTime: 0,
        pendingSearches: 0
    };
    
    private progressCallback?: (message: string, progress?: number) => void;
    
    private readyPromise: Promise<void>;

    constructor() {
        this.readyPromise = this.initialize();
    }

    private async initialize(): Promise<void> {
        try {
            await this.updateIndex();
            this.searchState.isReady = true;
        } catch (error) {
            console.error('Failed to initialize search index:', error);
            this.searchState.isReady = true;
        }
    }

    public setProgressCallback(callback: (message: string, progress?: number) => void): void {
        this.progressCallback = callback;
    }

    private reportProgress(message: string, progress?: number): void {
        if (this.progressCallback) {
            this.progressCallback(message, progress);
        }
    }

    async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
        const results: SearchResult[] = [];
        
        if (query.length < 2) {
            return results;
        }

        if (signal?.aborted) {
            throw new Error('Search aborted');
        }

        if (!this.searchState.isReady) {
            this.reportProgress('Initializing search index...');
            await this.readyPromise;
        }

        this.searchState.isSearching = true;
        this.searchState.pendingSearches++;
        this.searchState.lastSearchTime = Date.now();

        try {
            await this.ensureIndexIsUpdated();

            if (signal?.aborted) {
                throw new Error('Search aborted');
            }

            this.reportProgress('Searching files...');
            
            const lowerQuery = query.toLowerCase();
            const isMultiLineQuery = query.includes('\n') || query.includes('\r\n') || query.includes('\r');
            
            let processedFiles = 0;
            const totalFiles = this.fileIndex.size;

            const fileEntries = Array.from(this.fileIndex.entries());
            
            for (let i = 0; i < fileEntries.length; i += TextSearcher.BATCH_SIZE) {
                if (signal?.aborted) {
                    throw new Error('Search aborted');
                }
                
                const batch = fileEntries.slice(i, i + TextSearcher.BATCH_SIZE);
                
                for (const [filePath, fileIndex] of batch) {
                    try {
                        if (isMultiLineQuery) {
                            this.searchMultiLineInIndex(fileIndex, query, results);
                        } else {
                            this.searchSingleLineInIndex(fileIndex, query, results);
                        }
                        processedFiles++;
                    } catch (fileError) {
                        continue;
                    }
                }
                
                const progress = Math.round((processedFiles / totalFiles) * 100);
                this.reportProgress(`Searching... ${processedFiles}/${totalFiles} files`, progress);
                
                if (i % (TextSearcher.BATCH_SIZE * 4) === 0) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }

        } catch (error) {
            console.error('Text search error:', error);
            throw error;
        } finally {
            this.searchState.isSearching = false;
            this.searchState.pendingSearches = Math.max(0, this.searchState.pendingSearches - 1);
        }

        this.reportProgress(`Found ${results.length} results`);
        return this.sortAndLimitResults(results);
    }

    private async ensureIndexIsUpdated(): Promise<void> {
        const now = Date.now();
        const indexAge = now - this.lastIndexTime;
        
        if (indexAge > 60000 || this.fileIndex.size === 0) {
            if (this.indexingPromise) {
                await this.indexingPromise;
            } else {
                this.indexingPromise = this.updateIndex();
                await this.indexingPromise;
                this.indexingPromise = null;
            }
        }
    }

    private async updateIndex(): Promise<void> {
        if (this.isIndexing) return;
        
        this.isIndexing = true;
        try {
            this.reportProgress('Indexing workspace files...');
            
            const files = await vscode.workspace.findFiles(
                '**/*', 
                '{**/node_modules/**,**/dist/**,**/build/**,**/out/**,**/.git/**,**/coverage/**,**/.vscode/**,**/target/**,**/bin/**,**/obj/**,**/.next/**,**/.nuxt/**,**/vendor/**}', 
                15000
            );
            
            const textFiles = files.filter(file => {
                const ext = path.extname(file.fsPath).toLowerCase();
                return !TextSearcher.EXCLUDED_EXTENSIONS.has(ext);
            });

            this.reportProgress(`Indexing ${textFiles.length} files...`);

            const newIndex = new Map<string, FileIndex>();
            let processedCount = 0;
            
            for (let i = 0; i < textFiles.length; i += TextSearcher.BATCH_SIZE) {
                const batch = textFiles.slice(i, i + TextSearcher.BATCH_SIZE);
                await this.indexBatch(batch, newIndex);
                
                processedCount += batch.length;
                const progress = Math.round((processedCount / textFiles.length) * 100);
                this.reportProgress(`Indexed ${processedCount}/${textFiles.length} files`, progress);
                
                if (i % (TextSearcher.BATCH_SIZE * 2) === 0) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }

            this.fileIndex = newIndex;
            this.lastIndexTime = Date.now();
            this.reportProgress(`Index updated: ${newIndex.size} files`);
        } finally {
            this.isIndexing = false;
        }
    }

    private async indexBatch(files: vscode.Uri[], index: Map<string, FileIndex>): Promise<void> {
        const promises = files.map(async (file) => {
            try {
                const stat = await vscode.workspace.fs.stat(file);
                const existing = this.fileIndex.get(file.fsPath);
                
                if (existing && existing.lastModified >= stat.mtime) {
                    index.set(file.fsPath, existing);
                    return;
                }

                if (stat.size > TextSearcher.MAX_FILE_SIZE) {
                    return;
                }

                const document = await vscode.workspace.openTextDocument(file);
                const content = document.getText();
                
                const fileName = path.basename(file.fsPath);
                const relativePath = vscode.workspace.asRelativePath(file);
                
                const lines = content.split('\n');
                index.set(file.fsPath, {
                    content: '', 
                    lines,
                    lastModified: stat.mtime,
                    uri: file,
                    fileName,
                    relativePath
                });
                
                if (index.size > TextSearcher.MAX_INDEX_SIZE) {
                    this.cleanupOldEntries(index);
                }
            } catch (error) {
                return;
            }
        });

        await Promise.all(promises);
    }

    public getSearchState(): SearchState {
        return { ...this.searchState };
    }

    public async waitForReady(): Promise<void> {
        await this.readyPromise;
    }

    private cleanupOldEntries(index: Map<string, FileIndex>): void {
        const now = Date.now();
        if (now - this.lastCleanupTime < TextSearcher.INDEX_CLEANUP_INTERVAL) {
            return;
        }
    
        const entries = Array.from(index.entries());
        entries.sort(([,a], [,b]) => a.lastModified - b.lastModified);
        
        const removeCount = Math.floor(entries.length * 0.2);
        for (let i = 0; i < removeCount; i++) {
            index.delete(entries[i][0]);
        }
        
        this.lastCleanupTime = now;
    }

    private searchSingleLineInIndex(fileIndex: FileIndex, query: string, results: SearchResult[]): void {
        const lowerQuery = query.toLowerCase();
        
        for (let lineIndex = 0; lineIndex < fileIndex.lines.length; lineIndex++) {
            const line = fileIndex.lines[lineIndex];
            const lowerLine = line.toLowerCase();
            
            let searchIndex = 0;
            let matchIndex = lowerLine.indexOf(lowerQuery, searchIndex);
            
            while (matchIndex !== -1) {
                const lineNumber = lineIndex + 1;
                const range = new vscode.Range(
                    lineIndex, matchIndex,
                    lineIndex, matchIndex + query.length
                );
                
                const highlightedLine = this.createHighlightedLine(line, matchIndex, query.length);
                
                results.push({
                    label: `${fileIndex.fileName}:${lineNumber}`,
                    description: fileIndex.relativePath,
                    detail: highlightedLine,
                    type: SearchType.Text,
                    uri: fileIndex.uri,
                    range: range,
                    score: this.calculateScore(query, line, range)
                });
                
                searchIndex = matchIndex + 1;
                matchIndex = lowerLine.indexOf(lowerQuery, searchIndex);
            }
        }
    }

    private searchMultiLineInIndex(fileIndex: FileIndex, query: string, results: SearchResult[]): void {
        const normalizedQuery = query.replace(/\r\n|\r|\n/g, '\n').toLowerCase();
        const reconstructedContent = fileIndex.lines.join('\n');
        const normalizedText = reconstructedContent.toLowerCase();
        const originalNormalizedText = reconstructedContent;
        
        let searchIndex = 0;
        let matchIndex = normalizedText.indexOf(normalizedQuery, searchIndex);
        
        while (matchIndex !== -1) {
            const beforeMatch = originalNormalizedText.substring(0, matchIndex);
            const lineNumber = beforeMatch.split('\n').length;
            const lineStartIndex = beforeMatch.lastIndexOf('\n') + 1;
            const columnIndex = matchIndex - lineStartIndex;
            
            const matchEnd = matchIndex + normalizedQuery.length;
            const afterMatch = originalNormalizedText.substring(0, matchEnd);
            const endLineNumber = afterMatch.split('\n').length;
            const endLineStartIndex = afterMatch.lastIndexOf('\n') + 1;
            const endColumnIndex = matchEnd - endLineStartIndex;
            
            const range = new vscode.Range(
                lineNumber - 1, columnIndex,
                endLineNumber - 1, endColumnIndex
            );
            
            const lines = originalNormalizedText.split('\n');
            const contextLine = lines[lineNumber - 1] || '';
            const highlightedLine = this.createHighlightedLine(contextLine, columnIndex, Math.min(query.replace(/\r\n|\r|\n/g, '\n').length, contextLine.length - columnIndex));
            
            results.push({
                label: `${fileIndex.fileName}:${lineNumber}`,
                description: fileIndex.relativePath,
                detail: highlightedLine + ' (multi-line)',
                type: SearchType.Text,
                uri: fileIndex.uri,
                range: range,
                score: this.calculateScore(query, contextLine, range) + 10
            });
            
            searchIndex = matchIndex + 1;
            matchIndex = normalizedText.indexOf(normalizedQuery, searchIndex);
        }
    }

    private createHighlightedLine(line: string, matchIndex: number, matchLength: number): string {
        const trimmedLine = line.trim();
        if (trimmedLine.length === 0) {
            return line;
        }
        
        const lineStart = line.search(/\S/);
        const adjustedMatchIndex = matchIndex - lineStart;
        
        if (adjustedMatchIndex < 0) {
            return trimmedLine;
        }
        
        const before = trimmedLine.substring(0, adjustedMatchIndex);
        const match = trimmedLine.substring(adjustedMatchIndex, adjustedMatchIndex + matchLength);
        const after = trimmedLine.substring(adjustedMatchIndex + matchLength);
        
        const maxLength = 80;
        let result = before + match + after;
        
        if (result.length > maxLength) {
            const halfMax = Math.floor(maxLength / 2);
            const matchStart = before.length;
            const matchEnd = matchStart + match.length;
            
            let start = Math.max(0, matchStart - halfMax);
            let end = Math.min(result.length, matchEnd + halfMax);
            
            result = result.substring(start, end);
            if (start > 0) result = '...' + result;
            if (end < before.length + match.length + after.length) result = result + '...';
        }
        
        return result;
    }

    private calculateScore(query: string, lineText: string, range: vscode.Range): number {
        const lowerQuery = query.toLowerCase();
        const lowerLine = lineText.toLowerCase();
        
        let score = 50;
        
        const queryIndex = lowerLine.indexOf(lowerQuery);
        if (queryIndex === 0) {
            score += 30;
        } else if (queryIndex > 0) {
            const charBefore = lineText[queryIndex - 1];
            if (/\s/.test(charBefore)) {
                score += 20;
            }
        }
        
        const wordCount = lineText.trim().split(/\s+/).length;
        if (wordCount < 10) {
            score += 10;
        }
        
        const isComment = lineText.trim().startsWith('//') || lineText.trim().startsWith('/*');
        if (!isComment) {
            score += 15;
        }
        
        return score;
    }

    private sortAndLimitResults(results: SearchResult[]): SearchResult[] {
        const sortedResults = results.sort((a, b) => {
            if (a.score !== undefined && b.score !== undefined) {
                return b.score - a.score;
            }
            return a.label.localeCompare(b.label);
        });

        const groupedResults = new Map<string, SearchResult[]>();
        
        for (const result of sortedResults) {
            const fileKey = result.uri?.fsPath || '';
            if (!groupedResults.has(fileKey)) {
                groupedResults.set(fileKey, []);
            }
            groupedResults.get(fileKey)!.push(result);
        }

        const finalResults: SearchResult[] = [];
        for (const [, fileResults] of groupedResults) {
            finalResults.push(...fileResults);
        }

        return finalResults;
    }

    public dispose(): void {
        this.fileIndex.clear();
        this.indexingPromise = null;
        this.isIndexing = false;
        this.lastIndexTime = 0;
        this.lastCleanupTime = 0;
    }
} 