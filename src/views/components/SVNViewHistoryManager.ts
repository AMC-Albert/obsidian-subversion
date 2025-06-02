import { TFile } from 'obsidian';
import { SVNClient } from '../../services/SVNClient';
import { SVNFileData } from '../../services/SVNDataStore';
import { UIState } from '../SVNUIController';
import { SVNHistoryRenderer, SVNFileStateRenderer, SVNRepositoryHandler } from '.';
import type ObsidianSvnPlugin from '../../main';

/**
 * Manages history rendering and content display for the FileHistoryView
 * Extracted from FileHistoryView to reduce complexity
 */
export class SVNViewHistoryManager {
    private svnClient: SVNClient;
    private plugin: ObsidianSvnPlugin;
    private historyRenderer: SVNHistoryRenderer;
    private fileStateRenderer: SVNFileStateRenderer;
    private repositoryHandler: SVNRepositoryHandler;

    constructor(
        svnClient: SVNClient, 
        plugin: ObsidianSvnPlugin,
        historyRenderer: SVNHistoryRenderer,
        fileStateRenderer: SVNFileStateRenderer,
        repositoryHandler: SVNRepositoryHandler
    ) {
        this.svnClient = svnClient;
        this.plugin = plugin;
        this.historyRenderer = historyRenderer;
        this.fileStateRenderer = fileStateRenderer;
        this.repositoryHandler = repositoryHandler;
    }

    /**
     * Render history content with state
     */
    renderHistoryContentWithState(container: HTMLElement, state: UIState, currentFile: TFile | null): void {
        if (state.showLoading) {
            container.createEl('p', { 
                text: 'Loading SVN data...', 
                cls: 'svn-loading' 
            });
            return;
        }

        if (state.error) {
            container.createEl('p', { 
                text: `Error: ${state.error}`,
                cls: 'mod-warning'
            });
            return;
        }

        if (!state.data || !currentFile) {
            container.createEl('p', { 
                text: 'No file selected',
                cls: 'svn-no-file'
            });
            return;
        }

        const data = state.data;

        // Handle different file states based on loaded data
        if (!data.isWorkingCopy) {
            this.repositoryHandler.renderRepositorySetup(container, currentFile);
            return;
        }

        if (!data.isFileInSvn) {
            this.fileStateRenderer.renderNotInSvn(container, currentFile);
            return;
        }

        // Check if file is added but not committed
        const isAddedNotCommitted = data.status.some((s: any) => s.status === 'A');
        if (isAddedNotCommitted) {
            this.fileStateRenderer.renderAddedButNotCommitted(container, currentFile);
            return;
        }

        // Render history if we have it
        if (data.history.length === 0) {
            container.createEl('p', { 
                text: 'No history found for this file',
                cls: 'svn-no-history'
            });
            return;
        }

        this.renderHistoryWithData(container, data, currentFile);
    }

    /**
     * Render history data efficiently
     */
    renderHistoryWithData(container: HTMLElement, data: SVNFileData, currentFile: TFile | null): void {
        // Check if we can reuse existing history list
        let historyList = container.querySelector('.svn-history-list') as HTMLElement;
        const existingItems = historyList?.querySelectorAll('.svn-history-item') || [];
        
        // Only rebuild if history count changed significantly or container is empty
        const shouldRebuild = !historyList || 
                             existingItems.length !== data.history.length ||
                             this.historyStructureChanged(existingItems, data.history);
        
        if (shouldRebuild) {
            container.empty();
            historyList = container.createEl('ul', { cls: 'svn-history-list' });
            
            // Build all history items
            data.history.forEach((entry, index) => {
                this.createHistoryItem(historyList, entry, index, data.history, currentFile);
            });
        } else {
            // Reuse existing structure, just update action buttons efficiently
            data.history.forEach((entry, index) => {
                const historyItem = existingItems[index] as HTMLElement;
                if (historyItem) {
                    this.updateHistoryItemActions(historyItem, entry, index, data.history, currentFile);
                }
            });
        }
    }

    /**
     * Check if the history structure has changed (different revisions)
     */
    private historyStructureChanged(existingItems: NodeListOf<Element>, newHistory: any[]): boolean {
        if (existingItems.length !== newHistory.length) return true;
        
        for (let i = 0; i < Math.min(existingItems.length, newHistory.length); i++) {
            const existingRevision = existingItems[i].querySelector('.svn-revision')?.textContent;
            const newRevision = `r${newHistory[i].revision}`;
            if (existingRevision !== newRevision) {
                return true;
            }
        }
        return false;
    }

    /**
     * Update just the action buttons of an existing history item
     */
    private updateHistoryItemActions(historyItem: HTMLElement, entry: any, index: number, fullHistory: any[], currentFile: TFile | null): void {
        const actionsEl = historyItem.querySelector('.svn-history-actions') as HTMLElement;
        if (actionsEl && currentFile) {
            // Only update if actions container exists and we have the file
            actionsEl.empty();
            this.historyRenderer.addHistoryItemActions(actionsEl, currentFile.path, entry, index, fullHistory);
        }
    }

    /**
     * Create a single history item
     */
    private createHistoryItem(historyList: HTMLElement, entry: any, index: number, fullHistory: any[], currentFile: TFile | null): void {
        const listItem = historyList.createEl('li', { cls: 'svn-history-item' });
        
        // Create main content container
        const contentEl = listItem.createEl('div', { cls: 'svn-history-content' });
        
        // Create header with revision info
        const headerEl = contentEl.createEl('div', { cls: 'svn-history-header' });
        headerEl.createEl('span', { 
            text: `r${entry.revision}`,
            cls: 'svn-revision'
        });
        headerEl.createEl('span', { 
            text: entry.author,
            cls: 'svn-author'
        });
        headerEl.createEl('span', { 
            text: new Date(entry.date).toLocaleString(),
            cls: 'svn-date'
        });

        // Add commit message
        if (entry.message) {
            const messageEl = contentEl.createEl('div', { cls: 'svn-message' });
            messageEl.setText(entry.message);
        }

        // Add action buttons
        if (currentFile) {
            const actionsEl = listItem.createEl('div', { cls: 'svn-history-actions' });
            this.historyRenderer.addHistoryItemActions(actionsEl, currentFile.path, entry, index, fullHistory);
        }
    }
}
