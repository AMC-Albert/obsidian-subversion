import { ItemView, WorkspaceLeaf, TFile, Notice, Modal, ButtonComponent } from 'obsidian';
import { SVNClient } from '../../services/SVNClient';
import { SvnLogEntry } from '../../types';
import type ObsidianSvnPlugin from '../../main';
import { CommitModal, ConfirmRevertModal, ConfirmRemoveModal, StatusModal, DiffModal } from '../modals';
import { PLUGIN_CONSTANTS } from '../../core/constants';

export const FILE_HISTORY_VIEW_TYPE = PLUGIN_CONSTANTS.VIEW_TYPE;

export class FileHistoryView extends ItemView {
    private plugin: ObsidianSvnPlugin;
    private svnClient: SVNClient;
    private currentFile: TFile | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: ObsidianSvnPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.svnClient = plugin.svnClient; // Use the properly configured SVNClient from the plugin
    }

    getViewType(): string {
        return FILE_HISTORY_VIEW_TYPE;
    }

    getDisplayText(): string {
        return "SVN Manager";
    }

    getIcon(): string {
        return PLUGIN_CONSTANTS.ICON_ID;
    }

    async onOpen() {
        this.containerEl.empty();
        
        this.renderView();
        
        // Listen for active file changes
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                this.updateCurrentFile();
            })
        );
        
        this.updateCurrentFile();
    }

    async refreshView() {
        // Update the SVNClient reference in case it was reinitialized
        this.svnClient = this.plugin.svnClient;
        // Force a re-render of the current view
        console.log('FileHistoryView: Forcing refresh of view');
        this.renderView();
    }

    private renderView() {
        this.containerEl.empty();
        
        if (!this.currentFile) {
            const contentEl = this.containerEl.createEl('div', { cls: 'svn-history-content' });
            contentEl.createEl('p', { 
                text: 'No file selected', 
                cls: 'svn-no-file' 
            });
            return;
        }
        
        // Add toolbar with icon buttons
        this.renderToolbar(this.containerEl);
        
        // Add main content area
        const contentEl = this.containerEl.createEl('div', { cls: 'svn-history-content' });
        this.loadFileHistory(contentEl);
    }

    private renderToolbar(container: HTMLElement) {
        const navHeaderEl = container.createEl('div', { cls: 'nav-header' });
        const toolbarEl = navHeaderEl.createEl('div', { cls: 'nav-buttons-container' });

        // Commit button
        new ButtonComponent(toolbarEl)
            .setIcon('check')
            .setTooltip('Commit file')
            .setClass('clickable-icon')
            .onClick(() => this.quickCommit());
               
        // Status button
        new ButtonComponent(toolbarEl)
            .setIcon('info')
            .setTooltip('Show file status')
            .setClass('clickable-icon')
            .onClick(() => this.showFileStatus());
        
        // Diff button
        new ButtonComponent(toolbarEl)
            .setIcon('file-diff')
            .setTooltip('Show diff')
            .setClass('clickable-icon')
            .onClick(() => this.showCurrentDiff());
        
        // Revert button
        new ButtonComponent(toolbarEl)
            .setIcon('undo')
            .setTooltip('Revert file')
            .setClass('clickable-icon')
            .onClick(() => this.revertFile());

        // Remove from SVN button
        new ButtonComponent(toolbarEl)
            .setIcon('trash')
            .setTooltip('Remove file from version control')
            .setClass('clickable-icon')
            .onClick(() => this.removeFromSvn());

        // Refresh button
        new ButtonComponent(toolbarEl)
            .setIcon('refresh-cw')
            .setTooltip('Refresh history')
            .setClass('clickable-icon')
            .onClick(() => this.renderView());
    }

    private async updateCurrentFile() {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile !== this.currentFile) {
            this.currentFile = activeFile;
            // Add a small delay to ensure SVNClient is ready
            setTimeout(() => {
                this.renderView();
            }, 100);
        }
    }

    private async loadFileHistory(container: HTMLElement) {
        if (!this.currentFile) return;
        
        // Check if SVNClient is properly initialized
        if (!this.isSvnClientReady()) {
            container.createEl('p', { 
                text: 'SVN client not initialized. Please check plugin settings.',
                cls: 'mod-warning'
            });
            return;
        }
        
        const loadingEl = container.createEl('p', { 
            text: 'Loading file history...', 
            cls: 'svn-loading' 
        });
        
        try {
            const isWorkingCopy = await this.svnClient.isWorkingCopy(this.currentFile.path);
            if (!isWorkingCopy) {
                loadingEl.setText('File is not in an SVN working copy');
                loadingEl.className = 'mod-warning';
                return;
            }
            
            // Check if file is tracked in SVN before trying to get history
            const isFileInSvn = await this.svnClient.isFileInSvn(this.currentFile.path);
            if (!isFileInSvn) {
                loadingEl.remove();
                this.renderNotInSvn(container);
                return;
            }
            
            // Try to get file history
            const history = await this.svnClient.getFileHistory(this.currentFile.path);
            loadingEl.remove();
            
            if (history.length === 0) {
                container.createEl('p', { 
                    text: 'No history found for this file',
                    cls: 'svn-no-history'
                });
                return;
            }
            
            this.renderHistory(container, history);
            
        } catch (error) {
            loadingEl.remove();
            
            // Log the error for debugging
            console.log('SVN Error Details:', error.message);
            
            // Check if this is a "file not in SVN" error - be more comprehensive
            const errorMessage = error.message.toLowerCase();
            if (errorMessage.includes('node was not found') || 
                errorMessage.includes('is not a working copy') ||
                errorMessage.includes('is not under version control') ||
                errorMessage.includes('no such file or directory') ||
                errorMessage.includes('path not found') ||
                errorMessage.includes('file not found') ||
                errorMessage.includes('not found in repository') ||
                // SVN specific error patterns
                errorMessage.includes('svn: e155007') || // not a working copy
                errorMessage.includes('svn: e155010') || // node not found
                errorMessage.includes('svn: e200009') || // node not found (different context)
                errorMessage.includes('svn: e160013')) { // path not found
                
                this.renderNotInSvn(container);
            } else if (errorMessage.includes('has no committed revision') || 
                       errorMessage.includes('svn: e195002')) { // no committed revision
                
                this.renderAddedButNotCommitted(container);
            } else {
                // Other errors
                console.error('Unhandled SVN Error:', error);
                const errorEl = container.createEl('p', { 
                    text: `Error loading history: ${error.message}`,
                    cls: 'mod-warning'
                });
            }
        }
    }

    private isSvnClientReady(): boolean {
        return this.svnClient && 
               this.plugin.svnClient && 
               this.svnClient === this.plugin.svnClient &&
               // Check if vault path is set (simple way to verify client is configured)
               typeof this.svnClient.setVaultPath === 'function';
    }

    private renderNotInSvn(container: HTMLElement) {
        const notInSvnEl = container.createEl('div', { cls: 'svn-not-in-repo' });
        
        notInSvnEl.createEl('p', { 
            text: 'This file is not added to SVN yet.',
            cls: 'svn-info-text'
        });
        
        const addBtn = notInSvnEl.createEl('button', { 
            text: 'Add to SVN',
            cls: 'mod-cta svn-add-btn'
        });
        
        addBtn.onclick = async () => {
            if (!this.currentFile) return;
            
            try {
                // Add the file to SVN
                await this.svnClient.addFile(this.currentFile.path);
                new Notice(`File ${this.currentFile.name} added to SVN`);
                
                // Refresh the view
                this.renderView();
                
            } catch (error) {
                console.error('Failed to add file to SVN:', error);
                new Notice(`Failed to add file to SVN: ${error.message}`);
            }
        };
        
        const commitBtn = notInSvnEl.createEl('button', { 
            text: 'Add & Commit',
            cls: 'mod-cta svn-commit-btn'
        });
        
        commitBtn.onclick = async () => {
            if (!this.currentFile) return;
            
            const modal = new CommitModal(
                this.app,
                'Add & Commit',
                `Add ${this.currentFile.name}`,
                async (message: string) => {
                    try {
                        await this.svnClient.addFile(this.currentFile!.path);
                        await this.svnClient.commitFile(this.currentFile!.path, message);
                        new Notice(`File ${this.currentFile!.name} added and committed`);
                        // Add delay before refresh to ensure commit is fully processed
                        setTimeout(() => {
                            this.renderView();
                        }, 500);
                    } catch (error) {
                        console.error('Failed to commit file:', error);
                        new Notice(`Failed to commit: ${error.message}`);
                    }
                }
            );
            modal.open();
        };
    }

    private renderAddedButNotCommitted(container: HTMLElement) {
        const addedEl = container.createEl('div', { cls: 'svn-added-not-committed' });
        
        addedEl.createEl('p', { 
            text: 'This file has been added to SVN but not yet committed.',
            cls: 'svn-info-text'
        });
        
        const commitBtn = addedEl.createEl('button', { 
            text: 'Commit File',
            cls: 'mod-cta svn-commit-btn'
        });
        
        commitBtn.onclick = async () => {
            if (!this.currentFile) return;
            
            const modal = new CommitModal(
                this.app,
                'Commit File',
                `Add ${this.currentFile.name}`,
                async (message: string) => {
                    try {
                        await this.svnClient.commitFile(this.currentFile!.path, message);
                        new Notice(`File ${this.currentFile!.name} committed successfully`);
                        // Add delay before refresh to ensure commit is fully processed
                        setTimeout(() => {
                            this.renderView();
                        }, 500);
                    } catch (error) {
                        console.error('Failed to commit file:', error);
                        new Notice(`Failed to commit: ${error.message}`);
                    }
                }
            );
            modal.open();
        };
        
        addedEl.createEl('p', { 
            text: 'Or continue editing and commit later.',
            cls: 'svn-secondary-text'
        });
    }

    private renderHistory(container: HTMLElement, history: SvnLogEntry[]) {
        const historyContainer = container.createEl('div', { cls: 'svn-history-list' });
        
        history.forEach((entry, index) => {
            const entryEl = historyContainer.createEl('div', { cls: 'svn-history-entry' });
            
            const headerEl = entryEl.createEl('div', { cls: 'svn-entry-header' });
            headerEl.createEl('span', { 
                text: `r${entry.revision}`,
                cls: 'svn-revision-number'
            });
            headerEl.createEl('span', { 
                text: entry.author,
                cls: 'svn-author'
            });
            headerEl.createEl('span', { 
                text: new Date(entry.date).toLocaleDateString(),
                cls: 'svn-date'
            });
            
            if (entry.message) {
                entryEl.createEl('div', { 
                    text: entry.message,
                    cls: 'svn-message'
                });
            }
            
            const actionsEl = entryEl.createEl('div', { cls: 'svn-entry-actions' });
            
            const checkoutBtn = actionsEl.createEl('button', { 
                text: 'Checkout',
                cls: 'mod-cta svn-action-btn'
            });
            checkoutBtn.onclick = () => this.checkoutRevision(entry.revision);
            
            const diffBtn = actionsEl.createEl('button', { 
                text: 'Diff',
                cls: 'svn-action-btn'
            });
            diffBtn.onclick = () => this.showDiff(entry.revision);
            
            // Add separator except for last item
            if (index < history.length - 1) {
                historyContainer.createEl('hr', { cls: 'svn-separator' });
            }
        });
    }

    private async checkoutRevision(revision: string) {
        if (!this.currentFile) return;
        
        try {
            await this.svnClient.checkoutRevision(this.currentFile.path, revision);
            
            // Reload the file content in the editor
            const content = await this.app.vault.adapter.read(this.currentFile.path);
            const activeView = this.app.workspace.getActiveViewOfType(ItemView);
            if (activeView && 'editor' in activeView) {
                (activeView as any).editor.setValue(content);
            }
            
            new Notice(`Checked out revision ${revision}`);
            
        } catch (error) {
            console.error('Failed to checkout revision:', error);
            new Notice(`Failed to checkout revision: ${error.message}`);
        }
    }

    private async showDiff(revision: string) {
        if (!this.currentFile) return;
        
        try {
            const diff = await this.svnClient.getDiff(this.currentFile.path, revision);
            const modal = new DiffModal(
                this.app, 
                this.currentFile.name, 
                diff || 'No differences found',
                `Diff for revision ${revision}`
            );
            modal.open();
        } catch (error) {
            console.error('Failed to get diff:', error);
            new Notice(`Failed to get diff: ${error.message}`);
        }
    }

    private async quickCommit() {
        if (!this.currentFile) {
            new Notice('No file selected');
            return;
        }

        const modal = new CommitModal(
            this.app,
            'Quick Commit',
            `Update ${this.currentFile.name}`,
            async (message: string) => {
                try {
                    await this.svnClient.commitFile(this.currentFile!.path, message);
                    new Notice(`File ${this.currentFile!.name} committed successfully`);
                    // Refresh the view after commit
                    setTimeout(() => {
                        this.renderView();
                    }, 500);
                } catch (error) {
                    console.error('Failed to commit file:', error);
                    new Notice(`Failed to commit: ${error.message}`);
                }
            }
        );
        modal.open();
    }

    private async showFileStatus() {
        if (!this.currentFile) {
            new Notice('No file selected');
            return;
        }

        try {
            const status = await this.svnClient.getStatus(this.currentFile.path);
            const modal = new StatusModal(this.app, this.currentFile.name, status);
            modal.open();
        } catch (error) {
            console.error('Failed to get file status:', error);
            new Notice(`Failed to get status: ${error.message}`);
        }
    }

    private async showCurrentDiff() {
        if (!this.currentFile) {
            new Notice('No file selected');
            return;
        }

        try {
            const diff = await this.svnClient.getDiff(this.currentFile.path);
            const modal = new DiffModal(this.app, this.currentFile.name, diff);
            modal.open();
        } catch (error) {
            console.error('Failed to get diff:', error);
            new Notice(`Failed to get diff: ${error.message}`);
        }
    }

    private async revertFile() {
        if (!this.currentFile) {
            new Notice('No file selected');
            return;
        }

        const revertAction = async () => {
            try {
                await this.svnClient.revertFile(this.currentFile!.path);
                
                // Reload the file content in the editor
                const content = await this.app.vault.adapter.read(this.currentFile!.path);
                const activeView = this.app.workspace.getActiveViewOfType(ItemView);
                if (activeView && 'editor' in activeView) {
                    (activeView as any).editor.setValue(content);
                }
                
                new Notice(`File ${this.currentFile!.name} reverted to last committed version`);
                
                // Refresh the view
                setTimeout(() => {
                    this.renderView();
                }, 500);
                
            } catch (error) {
                console.error('Failed to revert file:', error);
                new Notice(`Failed to revert: ${error.message}`);
            }
        };

        // For markdown files, skip the modal since changes can be undone in Obsidian
        if (this.currentFile.extension === 'md') {
            await revertAction();
        } else {
            // For non-markdown files, show confirmation modal since changes can't be undone
            const modal = new ConfirmRevertModal(
                this.app,
                this.currentFile.name,
                revertAction
            );
            modal.open();
        }
    }

    private async removeFromSvn() {
        if (!this.currentFile) {
            new Notice('No file selected');
            return;
        }

        const modal = new ConfirmRemoveModal(
            this.app,
            this.currentFile.name,
            async () => {
                try {
                    await this.svnClient.removeFile(this.currentFile!.path);
                    new Notice(`File ${this.currentFile!.name} scheduled for removal from SVN (commit to complete)`);
                    
                    // Refresh the view
                    setTimeout(() => {
                        this.renderView();
                    }, 500);
                    
                } catch (error) {
                    console.error('Failed to remove file from SVN:', error);
                    new Notice(`Failed to remove from SVN: ${error.message}`);
                }
            }
        );
        modal.open();
    }

    async onClose() {
        // Cleanup
    }
}