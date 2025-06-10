import * as vscode from 'vscode';
import { SearchResult, SearchType } from './types';
import * as path from 'path';

export class TextSearcher {
    async search(query: string): Promise<SearchResult[]> {
        const results: SearchResult[] = [];
        
        if (query.length < 2) {
            return results;
        }

        try {
            const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 500);
            
            for (const file of files) {
                try {
                    const document = await vscode.workspace.openTextDocument(file);
                    const text = document.getText();
                    const fileName = path.basename(file.fsPath);
                    const relativePath = vscode.workspace.asRelativePath(file);
                    
                    // Check if query contains newlines (multi-line search)
                    const isMultiLineQuery = query.includes('\n') || query.includes('\r\n') || query.includes('\r');
                    
                    if (isMultiLineQuery) {
                        // Multi-line search
                        const normalizedQuery = query.replace(/\r\n|\r|\n/g, '\n').toLowerCase();
                        const normalizedText = text.replace(/\r\n|\r|\n/g, '\n').toLowerCase();
                        const originalNormalizedText = text.replace(/\r\n|\r|\n/g, '\n');
                        
                        let searchIndex = 0;
                        let matchIndex = normalizedText.indexOf(normalizedQuery, searchIndex);
                        
                        while (matchIndex !== -1) {
                            // Find the line number where the match starts
                            const beforeMatch = originalNormalizedText.substring(0, matchIndex);
                            const lineNumber = beforeMatch.split('\n').length;
                            const lineStartIndex = beforeMatch.lastIndexOf('\n') + 1;
                            const columnIndex = matchIndex - lineStartIndex;
                            
                            // Find where the match ends
                            const matchEnd = matchIndex + normalizedQuery.length;
                            const afterMatch = originalNormalizedText.substring(0, matchEnd);
                            const endLineNumber = afterMatch.split('\n').length;
                            const endLineStartIndex = afterMatch.lastIndexOf('\n') + 1;
                            const endColumnIndex = matchEnd - endLineStartIndex;
                            
                            const range = new vscode.Range(
                                lineNumber - 1, columnIndex,
                                endLineNumber - 1, endColumnIndex
                            );
                            
                            // Get the context line for display (first line of match)
                            const lines = originalNormalizedText.split('\n');
                            const contextLine = lines[lineNumber - 1] || '';
                            const highlightedLine = this.createHighlightedLine(contextLine, columnIndex, Math.min(query.replace(/\r\n|\r|\n/g, '\n').length, contextLine.length - columnIndex));
                            
                            const fileType = this.getFileTypeIcon(fileName);
                            results.push({
                                label: `${fileType} ${fileName} $(symbol-numeric) ${lineNumber}`,
                                description: `$(folder-opened) ${relativePath}`,
                                detail: highlightedLine + ' (multi-line)',
                                type: SearchType.Text,
                                uri: file,
                                range: range,
                                score: this.calculateScore(query, contextLine, range) + 10 // Boost score for multi-line matches
                            });
                            
                            searchIndex = matchIndex + 1;
                            matchIndex = normalizedText.indexOf(normalizedQuery, searchIndex);
                        }
                    } else {
                        // Single-line search (original logic)
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
                                
                                const fileType = this.getFileTypeIcon(fileName);
                                results.push({
                                    label: `${fileType} ${fileName} $(symbol-numeric) ${lineNumber}`,
                                    description: `$(folder-opened) ${relativePath}`,
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
                } catch (fileError) {
                    continue;
                }
            }
        } catch (error) {
            console.error('Text search error:', error);
        }

        return this.sortAndLimitResults(results);
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

    private getFileTypeIcon(fileName: string): string {
        const ext = path.extname(fileName).toLowerCase();
        const iconMap: { [key: string]: string } = {
            '.ts': '$(file-code)',
            '.js': '$(file-code)',
            '.tsx': '$(file-code)',
            '.jsx': '$(file-code)',
            '.py': '$(file-code)',
            '.go': '$(file-code)',
            '.java': '$(file-code)',
            '.cpp': '$(file-code)',
            '.c': '$(file-code)',
            '.cs': '$(file-code)',
            '.php': '$(file-code)',
            '.rb': '$(file-code)',
            '.rs': '$(file-code)',
            '.swift': '$(file-code)',
            '.kt': '$(file-code)',
            '.dart': '$(file-code)',
            '.html': '$(file-code)',
            '.css': '$(file-css)',
            '.scss': '$(file-css)',
            '.json': '$(json)',
            '.xml': '$(file-code)',
            '.md': '$(file-text)',
            '.txt': '$(file-text)',
            '.yml': '$(file-code)',
            '.yaml': '$(file-code)',
            '.sql': '$(database)',
            '.sh': '$(terminal)',
            '.bat': '$(terminal)',
            '.dockerfile': '$(file-code)',
            '.gitignore': '$(file)',
            '.env': '$(file)'
        };
        
        return iconMap[ext] || '$(file)';
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
            finalResults.push(...fileResults.slice(0, 5));
        }

        return finalResults.slice(0, 50);
    }
} 