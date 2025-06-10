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

export class TextSearcher {
    private static readonly BATCH_SIZE = 20;
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
    private static readonly MAX_INDEX_SIZE = 5000; 
    private static readonly MAX_FILE_SIZE = 512 * 1024; 
    private static readonly INDEX_CLEANUP_INTERVAL = 300000; 
    private lastCleanupTime = 0;

    async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
        const results: SearchResult[] = [];
        
        if (query.length < 2) {
            return results;
        }

        if (signal?.aborted) {
            throw new Error('Search aborted');
        }

        await this.ensureIndexIsUpdated();

        try {
            const lowerQuery = query.toLowerCase();
            const isMultiLineQuery = query.includes('\n') || query.includes('\r\n') || query.includes('\r');

            for (const [filePath, fileIndex] of this.fileIndex) {
                if (signal?.aborted) {
                    throw new Error('Search aborted');
                }
                
                try {
                    if (isMultiLineQuery) {
                        this.searchMultiLineInIndex(fileIndex, query, results);
                    } else {
                        this.searchSingleLineInIndex(fileIndex, query, results);
                    }
                } catch (fileError) {
                    continue;
                }
            }
        } catch (error) {
            console.error('Text search error:', error);
        }

        return this.sortAndLimitResults(results);
    }

    private async ensureIndexIsUpdated(): Promise<void> {
        const now = Date.now();
        const indexAge = now - this.lastIndexTime;
        
        if (indexAge > 30000 || this.fileIndex.size === 0) {
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
            const files = await vscode.workspace.findFiles(
                '**/*', 
                '{**/node_modules/**,**/dist/**,**/build/**,**/out/**,**/.git/**,**/coverage/**,**/.vscode/**,**/target/**,**/bin/**,**/obj/**}', 
                10000
            );
            
            const textFiles = files.filter(file => {
                const ext = path.extname(file.fsPath).toLowerCase();
                return !TextSearcher.EXCLUDED_EXTENSIONS.has(ext);
            });

            const newIndex = new Map<string, FileIndex>();
            
            for (let i = 0; i < textFiles.length; i += TextSearcher.BATCH_SIZE) {
                const batch = textFiles.slice(i, i + TextSearcher.BATCH_SIZE);
                await this.indexBatch(batch, newIndex);
            }

            this.fileIndex = newIndex;
            this.lastIndexTime = Date.now();
        } finally {
            this.isIndexing = false;
        }
    }

    private async indexBatch(files: vscode.Uri[], index: Map<string, FileIndex>): Promise<void> {
        for (const file of files) {
            try {
                const stat = await vscode.workspace.fs.stat(file);
                const existing = this.fileIndex.get(file.fsPath);
                
                if (existing && existing.lastModified >= stat.mtime) {
                    index.set(file.fsPath, existing);
                    continue;
                }

                const document = await vscode.workspace.openTextDocument(file);
                const content = document.getText();
                
                if (content.length > TextSearcher.MAX_FILE_SIZE) {
                    continue;
                }
                
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
                continue;
            }
        }
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

    private async processBatch(files: vscode.Uri[], query: string, results: SearchResult[]): Promise<void> {
        for (const file of files) {
            try {
                const document = await vscode.workspace.openTextDocument(file);
                const text = document.getText();
                const fileName = path.basename(file.fsPath);
                const relativePath = vscode.workspace.asRelativePath(file);
                
                if (text.length > 1024 * 1024) {
                    continue;
                }
                
                const isMultiLineQuery = query.includes('\n') || query.includes('\r\n') || query.includes('\r');
                
                if (isMultiLineQuery) {
                    this.processMultiLineQuery(file, text, query, fileName, relativePath, results);
                } else {
                    this.processSingleLineQuery(file, text, query, fileName, relativePath, results);
                }
            } catch (fileError) {
                continue;
            }
        }
    }

    private processMultiLineQuery(file: vscode.Uri, text: string, query: string, fileName: string, relativePath: string, results: SearchResult[]): void {
        const normalizedQuery = query.replace(/\r\n|\r|\n/g, '\n').toLowerCase();
        const normalizedText = text.replace(/\r\n|\r|\n/g, '\n').toLowerCase();
        const originalNormalizedText = text.replace(/\r\n|\r|\n/g, '\n');
        
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
                label: `${fileName}:${lineNumber}`,
                description: relativePath,
                detail: highlightedLine + ' (multi-line)',
                type: SearchType.Text,
                uri: file,
                range: range,
                score: this.calculateScore(query, contextLine, range) + 10
            });
            
            searchIndex = matchIndex + 1;
            matchIndex = normalizedText.indexOf(normalizedQuery, searchIndex);
        }
    }

    private processSingleLineQuery(file: vscode.Uri, text: string, query: string, fileName: string, relativePath: string, results: SearchResult[]): void {
        const lines = text.split('\n');
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const line = lines[lineIndex];
            const lowerLine = line.toLowerCase();
            const lowerQuery = query.toLowerCase();
            
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
                    label: `${fileName}:${lineNumber}`,
                    description: relativePath,
                    detail: highlightedLine,
                    type: SearchType.Text,
                    uri: file,
                    range: range,
                    score: this.calculateScore(query, line, range)
                });
                
                searchIndex = matchIndex + 1;
                matchIndex = lowerLine.indexOf(lowerQuery, searchIndex);
            }
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