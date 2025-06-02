import { TFile } from 'obsidian';
import { SVNClient } from '../../../services/SVNClient';
import { SVNFileData } from '../../../services/SVNDataStore';
import { UIState } from '../SVNUIController';
import { SVNStatusDisplay } from '.';
import { SVNViewStateManager } from './SVNViewStateManager';

/**
 * Manages status updates and display logic for the FileHistoryView
 * Extracted from FileHistoryView to reduce complexity
 */
export class SVNViewStatusManager {
    private svnClient: SVNClient;
    private statusDisplay: SVNStatusDisplay;
    private stateManager: SVNViewStateManager;

    constructor(svnClient: SVNClient, statusDisplay: SVNStatusDisplay, stateManager: SVNViewStateManager) {
        this.svnClient = svnClient;
        this.statusDisplay = statusDisplay;
        this.stateManager = stateManager;
    }

    /**
     * Update status display section only
     */
    async updateStatusDisplay(state: UIState, statusContainer: HTMLElement | null, currentFile: TFile | null): Promise<void> {
        if (!statusContainer) return;
        
        // If we have fresh direct status data, override and render immediately
        const protectionWindowMs = this.stateManager.getProtectionWindowMs();
        if (this.stateManager.isWithinProtectionWindow()) {
            statusContainer.empty();
            const directData = this.stateManager.getLastDirectStatusData();
            if (directData) {
                this.renderStatusWithData(statusContainer, directData as any, currentFile);
            }
            return;
        }
        
        // Preserve existing status during loading states to avoid flicker
        if (state.showLoading && this.stateManager.getLastStatusHash() && this.stateManager.getLastStatusHash() !== 'no-data') {
            return;
        }
        
        // Calculate status hash to avoid unnecessary rebuilds
        const currentStatusHash = this.stateManager.calculateStatusHash(state, currentFile?.path);
        if (currentStatusHash === this.stateManager.getLastStatusHash()) {
            return;
        }
        
        statusContainer.empty();
        if (state.data && !state.showLoading) {
            this.renderStatusWithData(statusContainer, state.data, currentFile);
        } else if (currentFile) {
            this.statusDisplay.render(statusContainer, currentFile);
        }
        
        // Only update the hash if we're not in a loading state
        if (!state.showLoading) {
            this.stateManager.setLastStatusHash(currentStatusHash);
        }
    }

    /**
     * Render status display with loaded data
     */
    private renderStatusWithData(container: HTMLElement, data: SVNFileData, currentFile: TFile | null): void {
        container.empty();
        
        if (!data.isWorkingCopy) {
            container.createEl('span', { 
                text: 'Not in SVN working copy',
                cls: 'svn-status-text svn-status-warning'
            });
            return;
        }

        // Create status container with comprehensive revision info
        const statusContainer = container.createEl('div', { cls: 'svn-status-container' });
        
        // Show current revision with full details
        if (data.info && data.info.revision) {
            const revisionEl = statusContainer.createEl('span', { 
                cls: 'svn-status-revision'
            });
            
            // Revision number with badge styling
            revisionEl.createEl('span', { 
                text: 'r' + data.info.revision,
                cls: 'svn-revision-badge'
            });
            
            // Author information
            if (data.info.lastChangedAuthor) {
                revisionEl.createEl('span', { 
                    text: ` by ${data.info.lastChangedAuthor}`,
                    cls: 'svn-author-info'
                });
            }
            
            // Date information
            if (data.info.lastChangedDate) {
                const dateStr = new Date(data.info.lastChangedDate).toLocaleDateString();
                revisionEl.createEl('span', { 
                    text: ` on ${dateStr}`,
                    cls: 'svn-date-info'
                });
            }
        }
        
        // Show file modification status
        const statusTextEl = statusContainer.createEl('span', { cls: 'svn-status-text' });
        
        if (!data.status || data.status.length === 0) {
            statusTextEl.setText('Up to date');
            statusTextEl.addClass('svn-status-clean');
        } else {
            // Find status for current file
            const fileStatus = data.status.find(item => 
                item.filePath.includes(currentFile?.name || '') || 
                item.filePath.endsWith(currentFile?.path || '')
            );
            
            if (!fileStatus) {
                statusTextEl.setText('Up to date');
                statusTextEl.addClass('svn-status-clean');
            } else {
                const statusText = this.getStatusText(fileStatus.status);
                statusTextEl.setText(statusText);
                statusTextEl.addClass(this.getStatusClass(fileStatus.status));
            }
        }
    }

    /**
     * Get human-readable status text
     */
    private getStatusText(status: string): string {
        switch (status) {
            case 'M': return 'Modified';
            case 'A': return 'Added';
            case 'D': return 'Deleted';
            case 'R': return 'Replaced';
            case 'C': return 'Conflicted';
            case '?': return 'Unversioned';
            case '!': return 'Missing';
            default: return status || 'Unknown';
        }
    }

    /**
     * Get CSS class for status
     */
    private getStatusClass(status: string): string {
        switch (status) {
            case 'M': return 'svn-status-modified';
            case 'A': return 'svn-status-added';
            case 'D': return 'svn-status-deleted';
            case 'R': return 'svn-status-replaced';
            case 'C': return 'svn-status-conflicted';
            case '?': return 'svn-status-unversioned';
            case '!': return 'svn-status-missing';
            default: return 'svn-status-unknown';
        }
    }

    /**
     * Direct status update without retry logic - for simple refreshes
     */
    async updateFileStatusDirect(currentFile: TFile | null, statusContainer: HTMLElement | null): Promise<void> {
        if (!currentFile || !statusContainer) return;
        
        console.log('[SVN ViewStatusManager] Performing direct status update for:', currentFile.path);
        
        try {            // Get fresh status data directly without retry logic
            const statusResult = await this.svnClient.getStatus(currentFile.path);
            const infoResult = await this.svnClient.getInfo(currentFile.path);
            
            const statusData = {
                isWorkingCopy: true,
                status: statusResult || [],
                info: infoResult || null
            };
            
            // Store the direct status data with protection window
            this.stateManager.setLastDirectStatusData(statusData);
            
            // Calculate and store the new status hash
            const newStatusHash = this.stateManager.calculateStatusHashFromData(
                statusData, 
                currentFile.path, 
                currentFile.name
            );
            this.stateManager.setLastStatusHash(newStatusHash);
            
            // Render the updated status immediately
            statusContainer.empty();
            this.renderStatusWithData(statusContainer, statusData as any, currentFile);
            
            console.log('[SVN ViewStatusManager] Direct status update completed successfully');
            
        } catch (error) {
            console.error('[SVN ViewStatusManager] Error in direct status update:', error);
        }
    }

    /**
     * Analyze the type of changes in a diff to determine if they're substantial or just whitespace
     */
    analyzeDiffChanges(diff: string): { type: string, isWhitespaceOnly: boolean, description: string } {
        console.log('[SVN ViewStatusManager] Analyzing diff changes, input length:', diff.length);
        
        if (!diff || diff.trim().length === 0) {
            return { type: 'no-changes', isWhitespaceOnly: true, description: 'No changes detected' };
        }
        
        // Split diff into lines and analyze changes
        const lines = diff.split('\n');
        const changeLines = lines.filter(line => line.startsWith('+') || line.startsWith('-'));
        
        console.log('[SVN ViewStatusManager] Diff analysis:', {
            totalLines: lines.length,
            changeLines: changeLines.length,
            sampleChangeLines: changeLines.slice(0, 5)
        });
        
        if (changeLines.length === 0) {
            return { type: 'no-changes', isWhitespaceOnly: true, description: 'No visible changes' };
        }
        
        // Analyze the actual content changes
        let hasContentChanges = false;
        let hasWhitespaceChanges = false;
        let hasLineEndingChanges = false;
        
        for (const line of changeLines) {
            const content = line.substring(1); // Remove +/- prefix
            const trimmedContent = content.trim();
            
            if (trimmedContent.length > 0) {
                // This line has actual content
                hasContentChanges = true;
            } else if (content.length > 0) {
                // This line has only whitespace
                hasWhitespaceChanges = true;
            }
        }
        
        // Detect line ending changes by looking for lines that differ only in invisible characters
        const addedLines = changeLines.filter(l => l.startsWith('+')).map(l => l.substring(1));
        const removedLines = changeLines.filter(l => l.startsWith('-')).map(l => l.substring(1));
        
        if (addedLines.length === removedLines.length) {
            const hasLineEndingDifferences = addedLines.some((added, index) => {
                const removed = removedLines[index];
                return !!(removed && added.trim() === removed.trim() && added !== removed);
            });
            
            if (hasLineEndingDifferences) {
                hasLineEndingChanges = true;
            }
        }
        
        // Determine the overall type of changes
        const result = (() => {
            if (hasContentChanges) {
                return { 
                    type: 'content', 
                    isWhitespaceOnly: false, 
                    description: 'Content changes with possible whitespace changes' 
                };
            } else if (hasLineEndingChanges) {
                return { 
                    type: 'line-endings', 
                    isWhitespaceOnly: true, 
                    description: 'Line ending differences only' 
                };
            } else if (hasWhitespaceChanges) {
                return { 
                    type: 'whitespace', 
                    isWhitespaceOnly: true, 
                    description: 'Whitespace changes only' 
                };
            } else {
                return { 
                    type: 'unknown', 
                    isWhitespaceOnly: false, 
                    description: 'Unknown change type' 
                };
            }
        })();
        
        console.log('[SVN ViewStatusManager] Diff analysis result:', {
            hasContentChanges,
            hasWhitespaceChanges,
            hasLineEndingChanges,
            result
        });
        
        return result;
    }
}
