import { Component, Notice, WorkspaceLeaf } from 'obsidian';
import { ButtonComponent } from 'obsidian';
import { SVNClient } from '../../../services/SVNClient';
import { DiffModal } from '../../modals/DiffModal';
import { SvnLogEntry } from '../../../types';

export class SVNHistoryRenderer {
    private svnClient: SVNClient;
    private plugin: any;
    private refreshCallback: () => void;

    constructor(svnClient: SVNClient, plugin: any, refreshCallback: () => void) {
        this.svnClient = svnClient;
        this.plugin = plugin;
        this.refreshCallback = refreshCallback;
    }

    renderHistory(historyEl: HTMLElement, filePath: string): void {
        
        historyEl.empty();
        
        this.svnClient.getFileHistory(filePath).then((history: SvnLogEntry[]) => {
            if (history.length === 0) {
                historyEl.createEl('p', { text: 'No history found for this file.' });
                return;
            }

            const historyList = historyEl.createEl('ul', { cls: 'svn-history-list' });
            history.forEach((entry, index) => {
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
                });                // Add commit message
                if (entry.message) {
                    const messageEl = contentEl.createEl('div', { cls: 'svn-message' });
                    messageEl.setText(entry.message);
                }                // Add action buttons container (right-aligned and vertically centered)
                const actionsEl = listItem.createEl('div', { cls: 'svn-history-actions' });
                  // Diff button (not available for first revision)
                if (index > 0) {
                    const diffBtn = new ButtonComponent(actionsEl)
                        .setIcon('file-diff')
                        .setTooltip(`Show diff from r${history[index - 1].revision} to r${entry.revision}`)
                        .setClass('clickable-icon');
                    
                    diffBtn.buttonEl.addEventListener('click', (evt) => {
                        evt.preventDefault();
                        evt.stopPropagation();
                        this.showDiff(filePath, parseInt(history[index - 1].revision), parseInt(entry.revision));
                    });
                }// Checkout button  
                const checkoutBtn = new ButtonComponent(actionsEl)
                    .setIcon('circle-arrow-down')
                    .setTooltip(`Checkout revision ${entry.revision}`)
                    .setClass('clickable-icon');
                  // Add click handler directly to the button element
                checkoutBtn.buttonEl.addEventListener('click', async (evt) => {
                    evt.preventDefault();
                    evt.stopPropagation();
                    
                    try {
                        await this.checkoutRevision(filePath, entry.revision);
                    } catch (error) {
                        console.error('Error in checkout button handler:', error);
                    }
                });
            });
        }).catch((error: any) => {
            historyEl.createEl('p', { 
                text: `Error loading history: ${error.message}`,
                cls: 'svn-error'
            });
        });
    }

    private showDiff(filePath: string, fromRevision: number, toRevision: number): void {
        // Use getDiff method from SVNClient - it accepts an optional revision parameter
        this.svnClient.getDiff(filePath, toRevision.toString()).then((diffContent: string) => {
            new DiffModal(this.plugin.app, diffContent, `r${fromRevision} → r${toRevision}`).open();
        }).catch((error: any) => {
            console.error('Error getting diff:', error);
            // Could show a notice here
        });
    }    private async checkoutRevision(filePath: string, revision: string): Promise<void> {
        try {
            // Check if file has modifications before checkout
            let hadModifications = false;
            try {
                const statusArray = await this.svnClient.getStatus(filePath);
                
                // Check if we have any results and if any file shows modifications
                hadModifications = statusArray && statusArray.length > 0 && 
                                   statusArray.some(item => item.status.charAt(0) === 'M');
                
                // Fallback: If status check returned empty, assume no modifications
                if (!statusArray || statusArray.length === 0) {
                    hadModifications = false;
                }
                
            } catch (statusError) {
                // Continue with checkout even if status check fails
                console.warn('Could not check file status before checkout:', statusError);
            }            // Perform the checkout
            await this.svnClient.checkoutRevision(filePath, revision);
            
            // Verify the checkout worked by checking the current revision
            try {
                const info = await this.svnClient.getInfo(filePath);
                if (info && info.revision !== revision) {
                    console.warn(`Checkout may have failed: expected r${revision}, got r${info.revision}`);
                }
            } catch (verifyError) {
                console.warn('Could not verify checkout success:', verifyError);
            }
              // Force Obsidian to reload the file from disk
            await this.forceFileReload(filePath);
            
            // Show appropriate success message
            if (hadModifications) {
                new Notice(
                    `Checked out revision ${revision}. Your local modifications were discarded.\n` +
                    `To recover: Press Ctrl+Z to undo, then commit your changes first.`,
                    8000  // Show for 8 seconds
                );            } else {
                new Notice(`Checked out revision ${revision}.`);
            }
                console.log(`Checked out revision ${revision} for ${filePath}`);
            
            // Call refresh immediately - no need for delay since we have debouncing in the view
            this.refreshCallback();
        } catch (error: any) {
            console.error('Error checking out revision:', error);
            new Notice(`Failed to checkout revision ${revision}: ${error.message}`, 5000);
        }
    }    private async forceFileReload(filePath: string): Promise<void> {
        try {
            // Get the TFile object for the changed file
            const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
            if (file) {
                // Force Obsidian to read the file from disk and trigger change events
                const content = await this.plugin.app.vault.adapter.read(filePath);
                
                // Trigger file modification event to refresh any open editors
                this.plugin.app.vault.trigger('changed', file);
                
                // Also trigger a modified event to ensure all listeners are notified
                this.plugin.app.vault.trigger('modify', file);
                
                // Update open editors more efficiently
                this.plugin.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
                    if (leaf.view.getViewType() === 'markdown') {
                        const markdownView = leaf.view as any;
                        if (markdownView.file?.path === filePath) {
                            // Force the editor to refresh its content
                            if (markdownView.previewMode) {
                                markdownView.previewMode.rerender();
                            }
                            // Also try to reload the editor content
                            if (markdownView.editor) {
                                markdownView.editor.refresh();
                            }
                            // Force a complete reload of the view
                            markdownView.onLoadFile(file);
                        }
                    }
                });
            }
        } catch (error) {
            console.warn('Could not force file reload:', error);
            // Continue anyway - the SVN view will still be updated
        }
    }
}
