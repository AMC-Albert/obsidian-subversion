import { ItemView, WorkspaceLeaf, TFile, Notice, Modal, ButtonComponent } from 'obsidian';
import { SVNClient } from '../../services/SVNClient';
import { SvnLogEntry } from '../../types';
import type ObsidianSvnPlugin from '../../main';
import { CommitModal, ConfirmRevertModal, ConfirmRemoveModal, DiffModal, BlameModal } from '../modals';
import { PLUGIN_CONSTANTS } from '../../core/constants';

export const FILE_HISTORY_VIEW_TYPE = PLUGIN_CONSTANTS.VIEW_TYPE;

export class FileHistoryView extends ItemView {
    private plugin: ObsidianSvnPlugin;
    private svnClient: SVNClient;
    private currentFile: TFile | null = null;
    private isRendering: boolean = false;
    private renderTimeout: NodeJS.Timeout | null = null;
    
    // UI Caching system
    private viewCache: Map<string, string> = new Map(); // filename -> cached HTML
    private statusCache: Map<string, { status: string, className: string }> = new Map();
    private lastRenderTime: number = 0;
    private cacheTimeout: number = 5000; // Cache for 5 seconds
    private isExternalRefresh: boolean = false;
    
    // Persistent DOM elements to prevent rebuilding
    private persistentContainer: HTMLElement | null = null;
    private persistentToolbar: HTMLElement | null = null;
    private persistentInfoPanel: HTMLElement | null = null;
    private persistentStatusDisplay: HTMLElement | null = null;
    private persistentContentArea: HTMLElement | null = null;
    private isDomInitialized: boolean = false;

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
        // Force complete cleanup and re-initialization
        this.resetDomState();
        this.containerEl.empty();
        
        // Listen for active file changes
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                this.updateCurrentFile();
            })
        );
        
        // Initial render
        this.updateCurrentFile();
    }

    async refreshView() {
        // Update the SVNClient reference in case it was reinitialized
        this.svnClient = this.plugin.svnClient;
        // Mark this as an external refresh
        this.isExternalRefresh = true;
        // Force a re-render of the current view
        console.log('FileHistoryView: External refresh triggered');
        this.debouncedRender();
    }
    
    // Cache management methods
    private getCacheKey(): string {
        return this.currentFile ? this.currentFile.path : 'no-file';
    }
    
    private isCacheValid(): boolean {
        const now = Date.now();
        return (now - this.lastRenderTime) < this.cacheTimeout;
    }
    
    private cacheViewContent(content: string) {
        const key = this.getCacheKey();
        this.viewCache.set(key, content);
        this.lastRenderTime = Date.now();
    }
    
    private getCachedViewContent(): string | null {
        const key = this.getCacheKey();
        return this.viewCache.get(key) || null;
    }
    
    private cacheStatusContent(status: string, className: string) {
        const key = this.getCacheKey();
        this.statusCache.set(key, { status, className });
    }
    
    private getCachedStatusContent(): { status: string, className: string } | null {
        const key = this.getCacheKey();
        return this.statusCache.get(key) || null;
    }
    
    private shouldUseCachedContent(): boolean {
        return this.isExternalRefresh && this.isCacheValid() && this.getCachedViewContent() !== null;
    }

    private debouncedRender() {
        // If DOM is already initialized and this is an external refresh, just update content
        if (this.isDomInitialized && this.isExternalRefresh) {
            console.log('FileHistoryView: External refresh detected, updating content only');
            this.updateViewContent();
            this.isExternalRefresh = false;
            return;
        }
        
        // Clear any existing timeout
        if (this.renderTimeout) {
            clearTimeout(this.renderTimeout);
        }
        
        // Set a new timeout to render after a short delay
        this.renderTimeout = setTimeout(() => {
            this.renderView();
            this.renderTimeout = null;
            this.isExternalRefresh = false; // Reset flag after render
        }, 50); // 50ms debounce
    }
    
    private renderCachedContent() {
        const cachedContent = this.getCachedViewContent();
        if (cachedContent) {
            this.containerEl.innerHTML = cachedContent;
            // Add visual indicator that this is cached content
            this.containerEl.addClass('svn-cached-content');
            console.log('FileHistoryView: Served cached content to prevent flashing');
            
            // Remove cached indicator after a brief moment
            setTimeout(() => {
                this.containerEl.removeClass('svn-cached-content');
            }, 200);
        }
    }
    
    private scheduleBackgroundRender() {
        // Schedule a background render after a delay to update data
        setTimeout(() => {
            this.isExternalRefresh = false;
            this.renderView();
        }, 1000); // 1 second delay for background update
    }

    async refreshStatus() {
        // Only refresh the status display without rebuilding the entire view
        if (!this.currentFile || !this.persistentStatusDisplay) {
            return;
        }
        
        // Update content in place without destroying the element
        this.persistentStatusDisplay.empty();
        await this.renderStatusContent(this.persistentStatusDisplay);
    }

    private async renderStatusContent(statusEl: HTMLElement) {
        if (!this.currentFile || !this.isSvnClientReady()) {
            return;
        }

        try {
            // Check if file is in working copy
            const isWorkingCopy = await this.svnClient.isWorkingCopy(this.currentFile.path);
            if (!isWorkingCopy) {
                statusEl.createEl('span', { 
                    text: 'Not in SVN working copy',
                    cls: 'svn-status-text svn-status-warning'
                });
                return;
            }

            // Get file status
            const statusArray = await this.svnClient.getStatus(this.currentFile.path);
            const statusTextEl = statusEl.createEl('span', { cls: 'svn-status-text' });
            
            if (!statusArray || statusArray.length === 0) {
                statusTextEl.setText('Up to date');
                statusTextEl.addClass('svn-status-clean');
            } else {
                // Find status for current file
                const fileStatus = statusArray.find(item => 
                    item.filePath.includes(this.currentFile!.name) || 
                    item.filePath.endsWith(this.currentFile!.path)
                );
                
                if (!fileStatus) {
                    statusTextEl.setText('Up to date');
                    statusTextEl.addClass('svn-status-clean');
                } else {
                    const statusCode = fileStatus.status.charAt(0);
                    
                    switch (statusCode) {
                        case 'M':
                            statusTextEl.setText('Modified');
                            statusTextEl.addClass('svn-status-modified');
                            break;
                        case 'A':
                            statusTextEl.setText('Added');
                            statusTextEl.addClass('svn-status-added');
                            break;
                        case 'D':
                            statusTextEl.setText('Deleted');
                            statusTextEl.addClass('svn-status-deleted');
                            break;
                        case '?':
                            statusTextEl.setText('Not tracked');
                            statusTextEl.addClass('svn-status-untracked');
                            break;
                        default:
                            statusTextEl.setText('Up to date');
                            statusTextEl.addClass('svn-status-clean');
                    }
                }
            }
            
        } catch (error) {
            statusEl.createEl('span', { 
                text: 'Error getting status',
                cls: 'svn-status-text svn-status-error'
            });
        }
    }

    private renderView() {
        // Prevent multiple simultaneous renders
        if (this.isRendering) {
            return;
        }
        
        this.isRendering = true;
        
        try {
            // Initialize persistent DOM structure if not already done
            if (!this.isDomInitialized) {
                this.initializePersistentDom();
            }
            
            // Update content without rebuilding DOM structure
            this.updateViewContent();
            
        } finally {
            this.isRendering = false;
        }
    }
    
    private initializePersistentDom() {
        // Prevent double initialization
        if (this.isDomInitialized) {
            console.log('FileHistoryView: DOM already initialized, skipping');
            return;
        }
        
        // Ensure container is completely clean
        this.containerEl.empty();
        
        // Create persistent container structure
        this.persistentContainer = this.containerEl.createEl('div', { cls: 'svn-view-container' });
        
        // Create persistent toolbar
        this.persistentToolbar = this.persistentContainer.createEl('div', { cls: 'nav-header' });
        this.renderToolbar(this.persistentToolbar);
        
        // Create persistent info panel (initially hidden)
        this.persistentInfoPanel = this.persistentContainer.createEl('div', { cls: 'svn-info-panel' });
        this.persistentInfoPanel.style.display = 'none';
        
        // Create persistent status display
        this.persistentStatusDisplay = this.persistentContainer.createEl('div', { cls: 'svn-status-display' });
        
        // Create persistent content area
        this.persistentContentArea = this.persistentContainer.createEl('div', { cls: 'svn-history-content' });
        
        this.isDomInitialized = true;
        console.log('FileHistoryView: Initialized persistent DOM structure');
    }
    
    private updateViewContent() {
        if (!this.persistentContentArea || !this.persistentStatusDisplay) {
            return;
        }
        
        if (!this.currentFile) {
            // Update content area for no file selected
            this.persistentContentArea.empty();
            this.persistentContentArea.createEl('p', { 
                text: 'No file selected', 
                cls: 'svn-no-file' 
            });
            
            // Clear status display
            this.persistentStatusDisplay.empty();
            return;
        }
        
        // Update status display
        this.updateStatusDisplay();
        
        // Update main content area
        this.updateMainContent();
    }
    
    private async updateStatusDisplay() {
        if (!this.persistentStatusDisplay) return;
        
        // Add visual feedback
        this.persistentStatusDisplay.addClass('updating');
        
        // Clear and update status without destroying the element
        this.persistentStatusDisplay.empty();
        await this.renderStatusContent(this.persistentStatusDisplay);
        
        // Remove visual feedback
        this.persistentStatusDisplay.removeClass('updating');
    }
    
    private async updateMainContent() {
        if (!this.persistentContentArea) return;
        
        // Add visual feedback
        this.persistentContentArea.addClass('updating');
        
        // Clear and update content without destroying the element
        this.persistentContentArea.empty();
        await this.loadFileHistory(this.persistentContentArea);
        
        // Remove visual feedback
        this.persistentContentArea.removeClass('updating');
    }

    private renderToolbar(container: HTMLElement) {
        // Clear existing toolbar content if any
        container.empty();
        
        const toolbarEl = container.createEl('div', { cls: 'nav-buttons-container' });

        // Commit button
        new ButtonComponent(toolbarEl)
            .setIcon('check')
            .setTooltip('Commit file')
            .setClass('clickable-icon')
            .onClick(() => this.quickCommit());
        
        // Diff button
        new ButtonComponent(toolbarEl)
            .setIcon('file-diff')
            .setTooltip('Show diff')
            .setClass('clickable-icon')
            .onClick(() => this.showCurrentDiff());
        
        // Blame button
        new ButtonComponent(toolbarEl)
            .setIcon('eye')
            .setTooltip('Show blame/annotate')
            .setClass('clickable-icon')
            .onClick(() => this.showBlame());
        
        // Info button
        new ButtonComponent(toolbarEl)
            .setIcon('info')
            .setTooltip('Show file info')
            .setClass('clickable-icon')
            .onClick(() => this.toggleInfoDisplay());
        
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
            .onClick(() => this.updateViewContent()); // Changed to use updateViewContent instead of renderView
    }

    private async renderStatusDisplay(container: HTMLElement) {
        if (!this.currentFile || !this.isSvnClientReady()) {
            return;
        }

        const statusEl = container.createEl('div', { cls: 'svn-status-display' });
        await this.renderStatusContent(statusEl);
    }

    private async updateCurrentFile() {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile !== this.currentFile) {
            this.currentFile = activeFile;
            this.isExternalRefresh = false; // This is a file change, not an external refresh
            this.renderView();
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
            
            // Make entire entry clickable for checkout
            entryEl.onclick = (e) => {
                // Don't trigger if clicking on action buttons
                if ((e.target as HTMLElement).closest('.svn-entry-actions')) {
                    return;
                }
                this.checkoutRevision(entry.revision);
            };
            
            // Create main content row with revision, author, date, and actions
            const mainRowEl = entryEl.createEl('div', { cls: 'svn-entry-main-row' });
            
            // Left side: revision info
            const infoEl = mainRowEl.createEl('div', { cls: 'svn-entry-info' });
            infoEl.createEl('span', { 
                text: `${entry.revision}`,
                cls: 'svn-revision'
            });
            infoEl.createEl('span', { 
                text: entry.author,
                cls: 'svn-author'
            });
            infoEl.createEl('span', { 
                text: new Date(entry.date).toLocaleDateString(),
                cls: 'svn-date'
            });
            
            // Right side: action buttons (only diff now)
            const actionsEl = mainRowEl.createEl('div', { cls: 'svn-entry-actions' });
            
            new ButtonComponent(actionsEl)
                .setIcon('file-diff')
                .setTooltip('Show diff')
                .setClass('clickable-icon')
                .onClick((e) => {
                    e.stopPropagation(); // Prevent triggering the entry click
                    this.showDiff(entry.revision);
                });
            
            // Message row (if exists) - collapsible
            if (entry.message) {
                const messageEl = entryEl.createEl('div', { 
                    text: entry.message,
                    cls: 'svn-message'
                });
            }
            
            // Add subtle separator except for last item
            if (index < history.length - 1) {
                historyContainer.createEl('div', { cls: 'svn-separator' });
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
        if (!this.currentFile || !this.isSvnClientReady()) return;

        const modal = new ConfirmRemoveModal(this.app, this.currentFile.name, async () => {
            try {
                await this.svnClient.removeFile(this.currentFile!.path);
                new Notice(`File removed from SVN: ${this.currentFile!.name}`);
                
                // Refresh the view to update status
                this.renderView();
            } catch (error: any) {
                console.error('Error removing file from SVN:', error);
                new Notice(`Error: ${error.message || 'Failed to remove file from SVN'}`);
            }
        });
        
        modal.open();
    }

    private async showBlame() {
        if (!this.currentFile || !this.isSvnClientReady()) return;

        try {
            // Check if file is in SVN
            const isWorkingCopy = await this.svnClient.isWorkingCopy(this.currentFile.path);
            if (!isWorkingCopy) {
                new Notice('File is not in an SVN working copy');
                return;
            }

            const isFileInSvn = await this.svnClient.isFileInSvn(this.currentFile.path);
            if (!isFileInSvn) {
                new Notice('File is not tracked in SVN');
                return;
            }

            // Get blame data
            const blameData = await this.svnClient.getBlame(this.currentFile.path);
            
            // Get current file content
            const fileContent = await this.app.vault.read(this.currentFile);
            const fileLines = fileContent.split('\n');

            // Open blame modal
            const modal = new BlameModal(this.app, this.plugin, this.currentFile, blameData, fileLines);
            modal.open();

        } catch (error: any) {
            console.error('Error getting blame data:', error);
            new Notice(`Error: ${error.message || 'Failed to get blame data'}`);
        }
    }

    private async toggleInfoDisplay() {
        if (!this.persistentInfoPanel) return;
        
        // Toggle visibility
        if (this.persistentInfoPanel.style.display === 'none' || !this.persistentInfoPanel.style.display) {
            // Show the panel
            this.persistentInfoPanel.style.display = 'block';
            await this.loadInfoContent(this.persistentInfoPanel);
        } else {
            // Hide the panel
            this.persistentInfoPanel.style.display = 'none';
            this.persistentInfoPanel.empty();
        }
    }

    private async loadInfoContent(infoPanel: HTMLElement) {
        if (!this.currentFile) return;

        infoPanel.empty();
        infoPanel.createEl('div', { text: 'Loading file info...', cls: 'svn-loading-small' });

        try {
            const info = await this.svnClient.getInfo(this.currentFile.path);
            infoPanel.empty();
            
            if (!info) {
                infoPanel.createEl('div', { text: 'No SVN info available', cls: 'svn-info-item' });
                return;
            }

            // Create info items
            if (info.lastChangedAuthor) {
                infoPanel.createEl('div', { 
                    text: `Last changed by: ${info.lastChangedAuthor}`,
                    cls: 'svn-info-item'
                });
            }
            
            if (info.lastChangedRev) {
                infoPanel.createEl('div', { 
                    text: `Last changed rev: ${info.lastChangedRev}`,
                    cls: 'svn-info-item'
                });
            }
            
            if (info.lastChangedDate) {
                const date = new Date(info.lastChangedDate);
                infoPanel.createEl('div', { 
                    text: `Last changed: ${date.toLocaleDateString()} ${date.toLocaleTimeString()}`,
                    cls: 'svn-info-item'
                });
            }
            
            if (info.url) {
                infoPanel.createEl('div', { 
                    text: `URL: ${info.url}`,
                    cls: 'svn-info-item svn-info-url'
                });
            }

            // Get and display properties
            try {
                const properties = await this.svnClient.getProperties(this.currentFile.path);
                if (Object.keys(properties).length > 0) {
                    const propHeader = infoPanel.createEl('div', { 
                        text: 'Properties:',
                        cls: 'svn-info-item svn-info-header'
                    });
                    propHeader.style.marginTop = 'var(--size-4-2)';
                    propHeader.style.fontWeight = 'var(--font-weight-medium)';
                    
                    for (const [key, value] of Object.entries(properties)) {
                        infoPanel.createEl('div', { 
                            text: `  ${key}: ${value}`,
                            cls: 'svn-info-item svn-info-prop'
                        });
                    }
                }
            } catch (propError) {
                // Properties are optional, don't show error for this
            }

        } catch (error: any) {
            infoPanel.empty();
            infoPanel.createEl('div', { 
                text: `Error: ${error.message || 'Failed to get file info'}`,
                cls: 'svn-info-item svn-error'
            });
        }
    }

    async onClose() {
        // Cleanup caches and timeouts
        this.clearCache();
        if (this.renderTimeout) {
            clearTimeout(this.renderTimeout);
            this.renderTimeout = null;
        }
        
        // Clean up persistent DOM references
        this.resetDomState();
    }
    
    private clearCache() {
        this.viewCache.clear();
        this.statusCache.clear();
        this.lastRenderTime = 0;
    }
    
    // Public methods for external cache management
    public forceCacheRefresh() {
        this.clearCache();
        this.isExternalRefresh = false;
        this.renderView();
    }
    
    public warmCache() {
        // Pre-render content to cache for smoother experience
        if (this.currentFile && !this.isRendering) {
            this.renderView();
        }
    }
    
    public setCacheTimeout(timeout: number) {
        this.cacheTimeout = timeout;
    }

    // Public method to force complete re-initialization (for troubleshooting)
    public forceFullReinit() {
        console.log('FileHistoryView: Forcing complete re-initialization');
        this.resetDomState();
        this.clearCache();
        this.renderView();
    }
    
    // Public method to check if DOM is stable
    public isDomStable(): boolean {
        return this.isDomInitialized && 
               this.persistentContainer !== null && 
               this.persistentContentArea !== null;
    }

    // Reset DOM state to prevent duplication
    private resetDomState() {
        this.persistentContainer = null;
        this.persistentToolbar = null;
        this.persistentInfoPanel = null;
        this.persistentStatusDisplay = null;
        this.persistentContentArea = null;
        this.isDomInitialized = false;
        console.log('FileHistoryView: DOM state reset');
    }
}