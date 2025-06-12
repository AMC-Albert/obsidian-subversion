import { Plugin, TFile, Notice, WorkspaceLeaf, FileSystemAdapter, addIcon, TAbstractFile } from 'obsidian';
import { SvnSettingTab } from '@/settings';
import { SvnPluginSettings } from '@/types';
import { registerCommands } from '@/core';
import { SVNClient } from '@/services';
import { SVNView as FileHistoryView, FILE_HISTORY_VIEW_TYPE } from '@/views';
import { PLUGIN_CONSTANTS, DEFAULT_SETTINGS, SVN_ICON_SVG } from '@/core';
import { initLogger, loggerDebug, loggerInfo, loggerError, loggerWarn, registerLoggerClass, initializeDebugSystem } from '@/utils/obsidian-logger'; // Added setLoggerPluginId
import { basename, dirname } from 'path'; // Added basename and dirname

/**
 * Main plugin class for Obsidian SVN integration
 * Handles plugin lifecycle, view registration, and core functionality
 */
export default class ObsidianSvnPlugin extends Plugin {
	settings: SvnPluginSettings;
	svnClient: SVNClient;
	private statusUpdateTimer: number | null = null;
	private lastActiveFile: string | null = null;
	async onload() {
		// Initialize logger with plugin instance
		initLogger(this);

		registerLoggerClass(this, 'ObsidianSvnPlugin');
		
		// Initialize debug logging
		loggerDebug(this, 'onload', `Loading ${PLUGIN_CONSTANTS.PLUGIN_NAME} plugin`);
		
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

		// Ensure debug system persists after Obsidian layout is ready (handles reloads/rebuilds)
		this.app.workspace.onLayoutReady(() => {
			initializeDebugSystem();
		});
	}

	onunload() {
		this.cleanup();
	}

	/**
	 * Initialize the SVN client with proper vault path
	 */
	private initializeSvnClient() {
		// Set the vault path if using FileSystemAdapter
		const adapter = this.app.vault.adapter;
		let vaultPath = '';
		
		if (adapter instanceof FileSystemAdapter) {
			vaultPath = adapter.getBasePath();
			loggerDebug(this, 'initializeSvnClient: Vault path from FileSystemAdapter:', vaultPath);
		} else {
			loggerWarn(this, 'initializeSvnClient: Vault adapter is not FileSystemAdapter, type:', typeof adapter);
		}
		
		this.svnClient = new SVNClient(this.app, this.settings.svnBinaryPath, vaultPath);
		
		// Double-check that the vault path was set correctly
		const actualVaultPath = this.svnClient.getVaultPath();
		loggerDebug(this, 'initializeSvnClient: SVNClient vault path after construction:', actualVaultPath);
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
		this.addRibbonIcon(PLUGIN_CONSTANTS.ICON_ID, 'Open Subversion view', () => {
			this.openFileHistoryView();
		});

		// Add main command to open view
		this.addCommand({
			id: 'svn-open-file-history-view',
			name: 'Open Subversion view',
			callback: () => {
				this.activateView();
			}
		});
	}
	
	/**
	 * Setup optional features based on settings
	 */
	private setupFeatures() {
		if (this.settings.autoCommit) {
			this.setupAutoCommit();
		}
		
		// Setup file change monitoring for status updates
		this.setupFileChangeMonitoring();
	}

	/**
	 * Initialize workspace-related functionality
	 */
	private initializeWorkspace() {
		// Refresh views after configuration
		this.refreshFileHistoryViews();

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
		
		// Update SVN client path when settings change (but don't auto-refresh views)
		this.updateSvnClient();
		
		// Notify views that settings have changed (with a small delay to ensure debounced saves complete)
		setTimeout(() => {
			this.notifyViewsOfSettingsChange();
		}, 100);
	}
	/**
	 * Update SVN client configuration
	 */
	private updateSvnClient() {
		// Set the vault path if using FileSystemAdapter
		const adapter = this.app.vault.adapter;
		let vaultPath = '';
		
		if (adapter instanceof FileSystemAdapter) {
			vaultPath = adapter.getBasePath();
			loggerInfo(this, 'updateSvnClient: Vault path from FileSystemAdapter:', vaultPath);
		} else {
			loggerWarn(this, 'updateSvnClient: Vault adapter is not FileSystemAdapter, type:', typeof adapter);
		}
		
		this.svnClient = new SVNClient(this.app, this.settings.svnBinaryPath, vaultPath);
		
		// Double-check that the vault path was set correctly
		const actualVaultPath = this.svnClient.getVaultPath();
		loggerInfo(this, 'updateSvnClient: SVNClient vault path after construction:', actualVaultPath);
		
		// Don't automatically refresh views here - let user manually refresh if needed
		// Automatic refresh on every settings keystroke creates race conditions
		loggerInfo(this, 'updateSvnClient: SVN client updated, views will refresh on next user action');
	}

	/**
	 * Notify views that settings have changed
	 */
	private notifyViewsOfSettingsChange() {
		loggerDebug(this, 'Notifying views of settings change');
		let notifiedCount = 0;
		this.app.workspace.iterateAllLeaves(leaf => {
			if (leaf.view instanceof FileHistoryView) {
				// Call a method on the view to handle settings change
				if (typeof (leaf.view as any).onSettingsChanged === 'function') {
					(leaf.view as any).onSettingsChanged();
					notifiedCount++;
				}
			}
		});
		loggerInfo(this, `Notified ${notifiedCount} file history views of settings change`);
	}

	/**
	 * Setup file change monitoring for status updates
	 */
	private setupFileChangeMonitoring() {
		// Update status when switching files (with smart refresh)
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				const activeFile = this.app.workspace.getActiveFile();
				const newActiveFilePath = activeFile?.path ?? null;

				if (this.lastActiveFile !== newActiveFilePath) {
					loggerInfo(this, `Observed active file change in main.ts. Old: ${this.lastActiveFile}, New: ${newActiveFilePath}. SVNView instances handle their own updates.`);
					this.lastActiveFile = newActiveFilePath;
					// No call to this.refreshFileHistoryViews() here.
					// SVNView's internal 'active-leaf-change' listener calls its 'updateCurrentFile()',
					// which uses 'uiController.setCurrentFile()', which is cache-aware.
				}
			})
		);
		
		// Update status when files are modified (status-only refresh)
		this.registerEvent(
			this.app.vault.on('modify', (file: TFile) => {
				this.handleFileChange(file);
			})
		);
		
		// Update status when files are created (status-only refresh)
		this.registerEvent(
			this.app.vault.on('create', (file: TFile) => {
				this.handleFileChange(file);
			})
		);
		
		// Update status when files are deleted (status-only refresh)
		this.registerEvent(
			this.app.vault.on('delete', () => {
				this.scheduleStatusRefresh();
			})
		);
		
		// Update history views when files are renamed
		this.registerEvent(
			this.app.vault.on('rename', async (file: TAbstractFile, oldPath: string) => {
				loggerInfo(this, `Obsidian rename event: from "${oldPath}" to "${file.path}"`);

				try {
					const result = await this.svnClient.move(oldPath, file.path);
					
					if (result.skipped) {
						const message = result.message || `SVN move skipped for ${basename(oldPath)}.`;
						loggerInfo(this, message);
						new Notice(message, 7000);
					} else if (result.success) {
						const message = `SVN: Moved ${basename(oldPath)} to ${file.path}`;
						loggerInfo(this, message + (result.output ? ` Output: ${result.output}` : ''));
						new Notice(message, 5000);
					} else {
						// This case should ideally be covered by errors thrown from svnClient.move
						const errorMessage = result.error || result.output || `SVN move failed for ${basename(oldPath)}.`;
						loggerError(this, `SVN move reported failure for ${oldPath} to ${file.path}: ${errorMessage}`);
						new Notice(errorMessage, 10000);
					}
				} catch (error) {
					let errorMessage = `SVN: Error moving ${basename(oldPath)}`;
					if (error instanceof Error) {
						errorMessage += `: ${error.message}`;
					} else {
						errorMessage += `: An unknown error occurred.`;
					}
					loggerError(this, `Error during SVN move for ${oldPath} to ${file.path}:`, error);
					new Notice(errorMessage, 15000);
				} finally {
					// Schedule a general status refresh.
					// The svnClient.move method invalidates its caches,
					// which in turn calls SVNDataStore.clearAllLocalCaches via callback.
					// This refresh will then fetch fresh data.
					this.scheduleStatusRefresh();
				}
			})
		);
	}
	/**
	 * Handle file changes for status updates
	 */
	private handleFileChange(file: TFile) {
		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile && file.path === activeFile.path) {
			// Invalidate cache for the modified file - this will automatically trigger UI refresh via cache invalidation callback
			loggerDebug(this, `File modified: ${file.path} - invalidating cache (UI refresh will be triggered automatically)`);
			this.svnClient.invalidateCacheForPath(file.path);
			
			// No need to call scheduleStatusRefresh() - the cache invalidation callback will handle it
		}
	}
	
	/**
	 * Schedule a status refresh with delay
	 */
	private scheduleStatusRefresh() {
		if (this.statusUpdateTimer) {
			clearTimeout(this.statusUpdateTimer);
		}
		  this.statusUpdateTimer = window.setTimeout(() => {
			this.refreshStatusInViews();
			this.statusUpdateTimer = null;
		}, 150); // Reduced delay since FileHistoryView now has intelligent retry logic
	}

	/**
	 * Setup auto-commit functionality
	 */
	private setupAutoCommit() {
		this.registerEvent(
			this.app.vault.on('modify', async (file: TFile) => {
				if (!this.settings.autoCommit) return;

				try {
					// Use isFileInSvn to check if the file is under SVN control
					const isUnderSvn = await this.svnClient.isFileInSvn(file.path);
					if (isUnderSvn) {
						// Use the standard commit method
						await this.svnClient.commit([file.path], this.settings.commitMessage);
						new Notice(`Auto-committed: ${file.name}.`);
						  // Refresh status after auto-commit
						setTimeout(() => {
							this.refreshStatusInViews();
						}, PLUGIN_CONSTANTS.UI.REFRESH_DELAY);
					}
				} catch (error) {
					loggerError(this, 'setupAutoCommit', 'Auto-commit failed:', error);
					// Don't show notice for auto-commit failures to avoid spam
				}
			})
		);
	}
	
	/**
	 * Refresh all open file history views (with throttling to prevent spam)
	 */
	private lastRefreshTime = 0;
	private static readonly REFRESH_THROTTLE_MS = 1000; // 1 second throttle
	
	refreshFileHistoryViews() {
		const now = Date.now();
		if (now - this.lastRefreshTime < ObsidianSvnPlugin.REFRESH_THROTTLE_MS) {
			loggerDebug(this, `Throttling refreshFileHistoryViews - last refresh ${now - this.lastRefreshTime}ms ago`);
			return;
		}
		
		this.lastRefreshTime = now;
		
		let refreshedCount = 0;
		this.app.workspace.iterateAllLeaves(leaf => {
			if (leaf.view instanceof FileHistoryView) {
				leaf.view.refreshView();
				refreshedCount++;
			}
		});
		loggerDebug(this, `Refreshed ${refreshedCount} file history views`);
	}

	/**
	 * Refresh only the status display in all open file history views
	 */
	refreshStatusInViews() {
		let refreshedCount = 0;
		this.app.workspace.iterateAllLeaves(leaf => {
			if (leaf.view instanceof FileHistoryView) {
				// Use refreshFromCache to leverage SVNDataStore's caching
				(leaf.view as any).refreshFromCache(); 
				refreshedCount++;
			}
		});
		loggerDebug(this, `Requested cache-aware refresh in ${refreshedCount} file history views`);
	}
	/**
	 * Cleanup resources on plugin unload
	 */
	private cleanup() {
		if (this.statusUpdateTimer) {
			clearTimeout(this.statusUpdateTimer);
			this.statusUpdateTimer = null;
		}
		// Cleanup debug logging
		loggerDebug(this, 'Plugin cleanup completed');
	}
}




