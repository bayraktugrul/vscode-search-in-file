import * as vscode from 'vscode';
import { SearchResult, SearchType } from './types';
import * as path from 'path';
import * as crypto from 'crypto';

interface FileIndex {
    content: string;
    lines: string[];
    lastModified: number;
    uri: vscode.Uri;
    fileName: string;
    relativePath: string;
    hash?: string; 
}

interface SearchState {
    isReady: boolean;
    isSearching: boolean;
    lastSearchTime: number;
    pendingSearches: number;
}

interface CachedIndex {
    version: string;
    workspaceHash: string;
    lastIndexTime: number;
    fileIndex: { [filePath: string]: Omit<FileIndex, 'uri'> & { uriPath: string } };
    stats: {
        totalFiles: number;
        totalSize: number;
        excludedFiles: number;
    };
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
    private static readonly CACHE_VERSION = '1.2.0'; // Increment when changing cache format
    private static readonly CACHE_KEY = 'textSearchIndex';
    private static readonly MAX_CACHE_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
    private lastCleanupTime = 0;
    
    private context: vscode.ExtensionContext;
    private workspaceRoot: string;
    private workspaceHash: string;
    
    private searchState: SearchState = {
        isReady: false,
        isSearching: false,
        lastSearchTime: 0,
        pendingSearches: 0
    };
    
    private progressCallback?: (message: string, progress?: number) => void;
    private readyPromise: Promise<void>;
    
    private scheduledTimeouts: NodeJS.Timeout[] = [];
    private disposed = false;
    private abortController: AbortController | null = null;
    
    private caseSensitive = true; 
    private static readonly CASE_SENSITIVE_KEY = 'searchCaseSensitive';

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        this.workspaceHash = this.calculateWorkspaceHash();
        this.loadCaseSensitivePreference();
        this.readyPromise = this.initialize();
    }

    private calculateWorkspaceHash(): string {
        const workspaceName = vscode.workspace.name || 'default';
        const workspacePath = this.workspaceRoot;
        return crypto.createHash('md5').update(`${workspaceName}:${workspacePath}`).digest('hex').substring(0, 8);
    }

    private loadCaseSensitivePreference(): void {
        const saved = this.context.globalState.get<boolean>(TextSearcher.CASE_SENSITIVE_KEY);
        this.caseSensitive = saved !== undefined ? saved : true; // Default true
    }

    public async setCaseSensitive(caseSensitive: boolean): Promise<void> {
        this.caseSensitive = caseSensitive;
        await this.context.globalState.update(TextSearcher.CASE_SENSITIVE_KEY, caseSensitive);
    }

    public getCaseSensitive(): boolean {
        return this.caseSensitive;
    }

    private async initialize(): Promise<void> {
        try {
            this.reportProgress('Loading search index...');
            
            const loaded = await this.loadIndexFromCache();
            if (loaded) {
                this.reportProgress(`Loaded ${this.fileIndex.size} files from cache`);
                
                this.scheduleIncrementalUpdate();
            } else {
                this.reportProgress('Building search index...');
                await this.updateIndex();
            }
            
            this.searchState.isReady = true;
            this.reportProgress(`Search ready: ${this.fileIndex.size} files indexed`);
        } catch (error) {
            console.error('Failed to initialize search index:', error);
            this.searchState.isReady = true;
        }
    }

    private async loadIndexFromCache(): Promise<boolean> {
        try {
            const cached = this.context.workspaceState.get<CachedIndex>(TextSearcher.CACHE_KEY);
            
            if (!cached || 
                cached.version !== TextSearcher.CACHE_VERSION ||
                cached.workspaceHash !== this.workspaceHash ||
                Date.now() - cached.lastIndexTime > TextSearcher.MAX_CACHE_AGE) {
                
                this.reportProgress('Cache outdated, rebuilding index...');
                return false;
            }

            this.reportProgress(`Loading ${Object.keys(cached.fileIndex).length} files from cache...`);
            
            this.fileIndex.clear();
            let loadedCount = 0;
            
            for (const [filePath, cachedFile] of Object.entries(cached.fileIndex)) {
                try {
                    const uri = vscode.Uri.file(cachedFile.uriPath);
                    const stat = await vscode.workspace.fs.stat(uri);
                    
                    if (stat.mtime === cachedFile.lastModified) {
                        this.fileIndex.set(filePath, {
                            ...cachedFile,
                            uri: uri
                        });
                        loadedCount++;
                    }
                } catch (error) {
                    continue;
                }
            }

            this.lastIndexTime = cached.lastIndexTime;
            
            this.reportProgress(`Loaded ${loadedCount} files from cache (${Object.keys(cached.fileIndex).length - loadedCount} outdated)`);
            
            if (loadedCount < Object.keys(cached.fileIndex).length * 0.8) {
                this.reportProgress('Too many outdated files, rebuilding index...');
                return false;
            }

            return true;
        } catch (error) {
            console.error('Failed to load cache:', error);
            return false;
        }
    }

    private async saveIndexToCache(): Promise<void> {
        try {
            const cacheData: CachedIndex = {
                version: TextSearcher.CACHE_VERSION,
                workspaceHash: this.workspaceHash,
                lastIndexTime: this.lastIndexTime,
                fileIndex: {},
                stats: {
                    totalFiles: this.fileIndex.size,
                    totalSize: 0,
                    excludedFiles: 0
                }
            };

            // Convert file index to cacheable format
            for (const [filePath, fileIndex] of this.fileIndex) {
                const { uri, ...rest } = fileIndex;
                cacheData.fileIndex[filePath] = {
                    ...rest,
                    uriPath: uri.fsPath
                };
            }

            await this.context.workspaceState.update(TextSearcher.CACHE_KEY, cacheData);
            this.reportProgress('Index cached successfully');
        } catch (error) {
            console.error('Failed to save cache:', error);
        }
    }

    private async scheduleIncrementalUpdate(): Promise<void> {
        if (this.disposed) {
            return;
        }
        
        const timeout = setTimeout(async () => {
            const index = this.scheduledTimeouts.indexOf(timeout);
            if (index > -1) {
                this.scheduledTimeouts.splice(index, 1);
            }
            
            if (!this.disposed && !this.isIndexing) {
                try {
                    await this.performIncrementalUpdate();
                } catch (error) {console.error('Background incremental update failed:', error);
                }
            }
        }, 2000);
        
        this.scheduledTimeouts.push(timeout);
    }

    private async performIncrementalUpdate(): Promise<void> {
        if (this.disposed) {
            return;
        }
        
        try {
            const files = await vscode.workspace.findFiles(
                '**/*', 
                '{**/node_modules/**,**/dist/**,**/build/**,**/out/**,**/.git/**,**/coverage/**,**/.vscode/**,**/target/**,**/bin/**,**/obj/**,**/.next/**,**/.nuxt/**,**/vendor/**}', 
                15000
            );
            
            if (this.disposed) {
                return; 
            }
            
            const textFiles = files.filter(file => {
                const ext = path.extname(file.fsPath).toLowerCase();
                return !TextSearcher.EXCLUDED_EXTENSIONS.has(ext);
            });

            let updatedFiles = 0;
            let newFiles = 0;
            let removedFiles = 0;
            
            for (const file of textFiles) {
                if (this.disposed) {
                    return; 
                }
                
                try {
                    const stat = await vscode.workspace.fs.stat(file);
                    const existing = this.fileIndex.get(file.fsPath);
                    
                    if (!existing) {
                        await this.indexSingleFile(file, stat);
                        newFiles++;
                    } else if (existing.lastModified < stat.mtime) {
                        await this.indexSingleFile(file, stat);
                        updatedFiles++;
                    }
                } catch (error) {
                    continue;
                }
            }
            
            if (this.disposed) {
                return;
            }
            
            const currentFilePaths = new Set(textFiles.map(f => f.fsPath));
            const indexedPaths = Array.from(this.fileIndex.keys());
            
            for (const indexedPath of indexedPaths) {
                if (!currentFilePaths.has(indexedPath)) {
                    this.fileIndex.delete(indexedPath);
                    removedFiles++;
                }
            }
            
            if (!this.disposed && (newFiles > 0 || updatedFiles > 0 || removedFiles > 0)) {
                this.lastIndexTime = Date.now();
                await this.saveIndexToCache();
                console.log(`Index updated: +${newFiles} new, ~${updatedFiles} modified, -${removedFiles} removed`);
            }
            
        } catch (error) {
            if (!this.disposed) {
                console.error('Incremental update failed:', error);
            }
        }
    }

    private async indexSingleFile(file: vscode.Uri, stat: vscode.FileStat): Promise<void> {
        try {
            if (stat.size > TextSearcher.MAX_FILE_SIZE) {
                return;
            }

            const document = await vscode.workspace.openTextDocument(file);
            const content = document.getText();
            
            const fileName = path.basename(file.fsPath);
            const relativePath = vscode.workspace.asRelativePath(file);
            
            const lines = content.split('\n');
            this.fileIndex.set(file.fsPath, {
                content: '', 
                lines,
                lastModified: stat.mtime,
                uri: file,
                fileName,
                relativePath
            });
        } catch (error) {
        }
    }

    public setProgressCallback(callback: (message: string, progress?: number) => void): void {
        this.progressCallback = callback;
    }

    private reportProgress(message: string, progress?: number): void {
        if (this.disposed || !this.progressCallback) {
            return;
        }
        
        if (message.includes('file changes') || message.includes('Updated:') || message.includes('No file changes')) {
            const isActiveOperation = this.searchState.isSearching || this.searchState.pendingSearches > 0;
            if (!isActiveOperation) {
                return; 
            }
        }
        
        try {
            this.progressCallback(message, progress);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.log('Progress reporting failed (webview likely disposed):', errorMessage);
            this.progressCallback = undefined; // Clear callback to prevent future errors
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
            
            // Case sensitive logic
            const searchQuery = this.caseSensitive ? query : query.toLowerCase();
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
                            this.searchMultiLineInIndex(fileIndex, query, searchQuery, results);
                        } else {
                            this.searchSingleLineInIndex(fileIndex, query, searchQuery, results);
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
        
        if (indexAge > 2 * 60 * 60 * 1000 || this.fileIndex.size === 0) {
            if (this.indexingPromise) {
                await this.indexingPromise;
            } else {
                this.indexingPromise = this.updateIndex();
                await this.indexingPromise;
                this.indexingPromise = null;
            }
        }
        else if (indexAge > 5 * 60 * 1000) { // 5 minutes
            await this.performIncrementalUpdate();
        }
    }

    private async updateIndex(): Promise<void> {
        if (this.isIndexing) return;
        
        this.isIndexing = true;
        try {
            this.reportProgress('Full indexing workspace files...');
            
            const files = await vscode.workspace.findFiles(
                '**/*', 
                '{**/node_modules/**,**/dist/**,**/build/**,**/out/**,**/.git/**,**/coverage/**,**/.vscode/**,**/target/**,**/bin/**,**/obj/**,**/.next/**,**/.nuxt/**,**/vendor/**}', 
                15000
            );
            
            const textFiles = files.filter(file => {
                const ext = path.extname(file.fsPath).toLowerCase();
                return !TextSearcher.EXCLUDED_EXTENSIONS.has(ext);
            });

            this.reportProgress(`Full indexing ${textFiles.length} files...`);

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
            
            await this.saveIndexToCache();
            
            this.reportProgress(`Full index updated: ${newIndex.size} files cached`);
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

    private searchSingleLineInIndex(fileIndex: FileIndex, originalQuery: string, searchQuery: string, results: SearchResult[]): void {
        for (let lineIndex = 0; lineIndex < fileIndex.lines.length; lineIndex++) {
            const line = fileIndex.lines[lineIndex];
            const searchLine = this.caseSensitive ? line : line.toLowerCase();
            
            let searchIndex = 0;
            let matchIndex = searchLine.indexOf(searchQuery, searchIndex);
            
            while (matchIndex !== -1) {
                const lineNumber = lineIndex + 1;
                const range = new vscode.Range(
                    lineIndex, matchIndex,
                    lineIndex, matchIndex + originalQuery.length
                );
                
                const highlightedLine = this.createHighlightedLine(line, matchIndex, originalQuery.length);
                
                results.push({
                    label: `${fileIndex.fileName}:${lineNumber}`,
                    description: fileIndex.relativePath,
                    detail: highlightedLine,
                    type: SearchType.Text,
                    uri: fileIndex.uri,
                    range: range,
                    score: this.calculateScore(originalQuery, line, range)
                });
                
                searchIndex = matchIndex + 1;
                matchIndex = searchLine.indexOf(searchQuery, searchIndex);
            }
        }
    }

    private searchMultiLineInIndex(fileIndex: FileIndex, originalQuery: string, searchQuery: string, results: SearchResult[]): void {
        const fullText = fileIndex.lines.join('\n');
        const searchText = this.caseSensitive ? fullText : fullText.toLowerCase();
        
        const normalizedSearchQuery = searchQuery.replace(/\r\n|\r|\n/g, '\n');
        
        let searchIndex = 0;
        let matchIndex = searchText.indexOf(normalizedSearchQuery, searchIndex);
        
        while (matchIndex !== -1) {
            const beforeMatch = fullText.substring(0, matchIndex);
            const lineNumber = beforeMatch.split('\n').length;
            const lineStartIndex = beforeMatch.lastIndexOf('\n') + 1;
            const columnIndex = matchIndex - lineStartIndex;
            
            const matchEnd = matchIndex + normalizedSearchQuery.length;
            const afterMatch = fullText.substring(0, matchEnd);
            const endLineNumber = afterMatch.split('\n').length;
            const endLineStartIndex = afterMatch.lastIndexOf('\n') + 1;
            const endColumnIndex = matchEnd - endLineStartIndex;
            
            const range = new vscode.Range(
                lineNumber - 1, columnIndex,
                endLineNumber - 1, endColumnIndex
            );
            
            const lines = fullText.split('\n');
            const contextLine = lines[lineNumber - 1] || '';
            const highlightedLine = this.createHighlightedLine(contextLine, columnIndex, Math.min(originalQuery.replace(/\r\n|\r|\n/g, '\n').length, contextLine.length - columnIndex));
            
            results.push({
                label: `${fileIndex.fileName}:${lineNumber}`,
                description: fileIndex.relativePath,
                detail: highlightedLine + ' (multi-line)',
                type: SearchType.Text,
                uri: fileIndex.uri,
                range: range,
                score: this.calculateScore(originalQuery, contextLine, range) + 10
            });
            
            searchIndex = matchIndex + 1;
            matchIndex = searchText.indexOf(normalizedSearchQuery, searchIndex);
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
        this.disposed = true;
        
        this.scheduledTimeouts.forEach(timeout => {
            clearTimeout(timeout);
        });
        this.scheduledTimeouts = [];
        
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        
        this.progressCallback = undefined;
        
        this.fileIndex.clear();
        
    }
} 