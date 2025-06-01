import { Plugin, TFile, Notice, WorkspaceLeaf, FileSystemAdapter, addIcon } from 'obsidian';
import { SvnSettingTab } from './settings';
import { SvnPluginSettings } from './types';
import { registerCommands } from './core/commands';
import { SVNClient } from './services/SVNClient';
import { FileHistoryView, FILE_HISTORY_VIEW_TYPE } from './ui/views/FileHistoryView';
import { PLUGIN_CONSTANTS, DEFAULT_SETTINGS, SVN_ICON_SVG } from './core/constants';

/**
 * Main plugin class for Obsidian SVN integration
 * Handles plugin lifecycle, view registration, and core functionality
 */
export default class ObsidianSvnPlugin extends Plugin {
    settings: SvnPluginSettings;
    svnClient: SVNClient;
    private statusBarItem: HTMLElement | null = null;

    async onload() {
        console.log(`Loading ${PLUGIN_CONSTANTS.PLUGIN_NAME} plugin`);
        
        // Register SVN icon
        addIcon(PLUGIN_CONSTANTS.ICON_ID, SVN_ICON_SVG);
        
        // Load settings
        await this.loadSettings();

        // Initialize SVN client
        this.initializeSvnClient();

        // Register UI components
        this.registerUI();

        // Register commands
        registerCommands(this);

        // Setup features based on settings
        this.setupFeatures();

        // Initialize workspace
        this.initializeWorkspace();
    }

    onunload() {
        this.cleanup();
    }

    /**
     * Initialize the SVN client with proper vault path
     */
    private initializeSvnClient() {
        this.svnClient = new SVNClient(this.settings.svnBinaryPath);
        
        const adapter = this.app.vault.adapter;
        if (adapter instanceof FileSystemAdapter) {
            this.svnClient.setVaultPath(adapter.getBasePath());
        } else {
            new Notice('SVN plugin requires file system access and may not work with this vault type');
        }
    }

    /**
     * Register all UI components (views, ribbon, settings)
     */
    private registerUI() {
        // Register the file history view
        this.registerView(
            FILE_HISTORY_VIEW_TYPE,
            (leaf: WorkspaceLeaf) => new FileHistoryView(leaf, this)
        );

        // Add settings tab
        this.addSettingTab(new SvnSettingTab(this.app, this));

        // Add ribbon icon
        this.addRibbonIcon(PLUGIN_CONSTANTS.ICON_ID, 'Open SVN Manager', () => {
            this.openFileHistoryView();
        });

        // Add main command to open view
        this.addCommand({
            id: 'svn-open-file-history-view',
            name: 'Open SVN Manager',
            callback: () => {
                this.activateView();
            }
        });
    }

    /**
     * Setup optional features based on settings
     */
    private setupFeatures() {
        if (this.settings.showStatusInStatusBar) {
            this.setupStatusBar();
        }

        if (this.settings.autoCommit) {
            this.setupAutoCommit();
        }
    }

    /**
     * Initialize workspace-related functionality
     */
    private initializeWorkspace() {
        // Refresh views after configuration
        this.refreshFileHistoryViews();
        
        // Refresh again after delay for plugin reload scenarios
        setTimeout(() => {
            this.refreshFileHistoryViews();
        }, PLUGIN_CONSTANTS.UI.REFRESH_DELAY);

        // Update SVN client when workspace is ready
        this.app.workspace.onLayoutReady(() => {
            this.updateSvnClient();
        });
    }

    /**
     * Open the file history view
     */
    async openFileHistoryView() {
        await this.activateView();
    }

    /**
     * Activate the SVN file history view
     */
    async activateView() {
        this.app.workspace.detachLeavesOfType(FILE_HISTORY_VIEW_TYPE);

        const rightLeaf = this.app.workspace.getRightLeaf(false);
        if (rightLeaf) {
            await rightLeaf.setViewState({
                type: FILE_HISTORY_VIEW_TYPE,
                active: true,
            });

            this.app.workspace.revealLeaf(
                this.app.workspace.getLeavesOfType(FILE_HISTORY_VIEW_TYPE)[0]
            );
        }
    }

    /**
     * Load plugin settings
     */
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    /**
     * Save plugin settings
     */
    async saveSettings() {
        await this.saveData(this.settings);
        
        // Update SVN client path when settings change
        this.updateSvnClient();
        
        // Update status bar based on settings
        this.updateStatusBarVisibility();
    }

    /**
     * Update SVN client configuration
     */
    private updateSvnClient() {
        this.svnClient = new SVNClient(this.settings.svnBinaryPath);
        
        // Set the vault path if using FileSystemAdapter
        const adapter = this.app.vault.adapter;
        if (adapter instanceof FileSystemAdapter) {
            this.svnClient.setVaultPath(adapter.getBasePath());
        }
        
        // Refresh file history views with the new client
        this.refreshFileHistoryViews();
    }

    /**
     * Update status bar visibility based on settings
     */
    private updateStatusBarVisibility() {
        if (this.settings.showStatusInStatusBar && !this.statusBarItem) {
            this.setupStatusBar();
        } else if (!this.settings.showStatusInStatusBar && this.statusBarItem) {
            this.statusBarItem.remove();
            this.statusBarItem = null;
        }
    }

    /**
     * Setup status bar functionality
     */
    private setupStatusBar() {
        this.statusBarItem = this.addStatusBarItem();
        this.statusBarItem.addClass('mod-clickable');
        this.statusBarItem.addEventListener('click', () => {
            this.activateView();
        });
        this.updateStatusBar();
        
        // Register event handlers for status updates
        this.registerStatusBarEvents();
    }

    /**
     * Register event handlers for status bar updates
     */
    private registerStatusBarEvents() {
        // Update status bar when switching files
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                this.updateStatusBar();
            })
        );
        
        // Update status bar when files are modified
        this.registerEvent(
            this.app.vault.on('modify', (file: TFile) => {
                this.handleFileChange(file);
            })
        );
        
        // Update status bar when files are created
        this.registerEvent(
            this.app.vault.on('create', (file: TFile) => {
                this.handleFileChange(file);
            })
        );
        
        // Update status bar when files are deleted
        this.registerEvent(
            this.app.vault.on('delete', () => {
                this.scheduleStatusUpdate();
            })
        );
        
        // Update status bar when files are renamed
        this.registerEvent(
            this.app.vault.on('rename', (file: TFile) => {
                this.handleFileChange(file);
            })
        );
    }

    /**
     * Handle file changes for status bar updates
     */
    private handleFileChange(file: TFile) {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && file.path === activeFile.path) {
            this.scheduleStatusUpdate();
        }
    }

    /**
     * Schedule a status bar update with delay
     */
    private scheduleStatusUpdate() {
        setTimeout(() => {
            this.updateStatusBar();
        }, PLUGIN_CONSTANTS.UI.STATUS_UPDATE_DELAY);
    }

    /**
     * Update the status bar content
     */
    private async updateStatusBar() {
        if (!this.statusBarItem) return;

        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            this.clearStatusBar();
            return;
        }

        try {
            const isWorkingCopy = await this.svnClient.isWorkingCopy(activeFile.path);
            if (!isWorkingCopy) {
                this.clearStatusBar();
                return;
            }

            const status = await this.svnClient.getStatus(activeFile.path);
            this.displayStatus(status);
        } catch (error) {
            this.displayErrorStatus();
        }
    }

    /**
     * Clear status bar content
     */
    private clearStatusBar() {
        if (this.statusBarItem) {
            this.statusBarItem.setText('');
            this.statusBarItem.removeClass('svn-status-clean', 'svn-status-modified', 'svn-status-error');
        }
    }

    /**
     * Display SVN status in status bar
     */
    private displayStatus(status: any[]) {
        if (!this.statusBarItem) return;
        
        if (status.length === 0) {
            this.statusBarItem.setText('SVN: Clean');
            this.statusBarItem.removeClass('svn-status-modified', 'svn-status-error');
            this.statusBarItem.addClass('svn-status-clean');
        } else {
            const statusText = status.map(s => s.status).join('');
            this.statusBarItem.setText(`SVN: ${statusText}`);
            this.statusBarItem.removeClass('svn-status-clean', 'svn-status-error');
            this.statusBarItem.addClass('svn-status-modified');
        }
    }

    /**
     * Display error status in status bar
     */
    private displayErrorStatus() {
        if (this.statusBarItem) {
            this.statusBarItem.setText('SVN: Error');
            this.statusBarItem.removeClass('svn-status-clean', 'svn-status-modified');
            this.statusBarItem.addClass('svn-status-error');
        }
    }

    /**
     * Setup auto-commit functionality
     */
    private setupAutoCommit() {
        this.registerEvent(
            this.app.vault.on('modify', async (file: TFile) => {
                if (!this.settings.autoCommit) return;

                try {
                    const isWorkingCopy = await this.svnClient.isWorkingCopy(file.path);
                    if (isWorkingCopy) {
                        await this.svnClient.commitFile(file.path, this.settings.commitMessage);
                        new Notice(`Auto-committed: ${file.name}`);
                        
                        // Update status bar and refresh views
                        this.updateStatusBar();
                        setTimeout(() => {
                            this.refreshFileHistoryViews();
                        }, PLUGIN_CONSTANTS.UI.REFRESH_DELAY);
                    }
                } catch (error) {
                    console.error('Auto-commit failed:', error);
                    // Don't show notice for auto-commit failures to avoid spam
                }
            })
        );
    }

    /**
     * Refresh all open file history views
     */
    refreshFileHistoryViews() {
        let refreshedCount = 0;
        this.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view instanceof FileHistoryView) {
                leaf.view.refreshView();
                refreshedCount++;
            }
        });
        console.log(`Refreshed ${refreshedCount} file history views`);
    }

    /**
     * Cleanup resources on plugin unload
     */
    private cleanup() {
        if (this.statusBarItem) {
            this.statusBarItem.remove();
            this.statusBarItem = null;
        }
    }
}
