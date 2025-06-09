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
            const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 100);
            
            for (const file of files) {
                try {
                    const document = await vscode.workspace.openTextDocument(file);
                    const text = document.getText();
                    const fileName = path.basename(file.fsPath);
                    const relativePath = vscode.workspace.asRelativePath(file);
                    
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
                            
                            const contextBefore = this.getContextBefore(line, matchIndex);
                            const contextAfter = this.getContextAfter(line, matchIndex + query.length);
                            
                            results.push({
                                label: `${fileName}:${lineNumber}`,
                                description: `$(search) ${relativePath}`,
                                detail: `${contextBefore}${line.substring(matchIndex, matchIndex + query.length)}${contextAfter}`,
                                type: SearchType.Text,
                                uri: file,
                                range: range,
                                score: this.calculateScore(query, line, range)
                            });
                            
                            searchIndex = matchIndex + 1;
                            matchIndex = lowerLine.indexOf(lowerQuery, searchIndex);
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

    private getContextBefore(lineText: string, startChar: number): string {
        const contextStart = Math.max(0, startChar - 20);
        let context = lineText.substring(contextStart, startChar);
        
        if (contextStart > 0) {
            context = '...' + context;
        }
        
        return context;
    }

    private getContextAfter(lineText: string, endChar: number): string {
        const contextEnd = Math.min(lineText.length, endChar + 20);
        let context = lineText.substring(endChar, contextEnd);
        
        if (contextEnd < lineText.length) {
            context = context + '...';
        }
        
        return context;
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