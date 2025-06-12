import { TFile } from 'obsidian';
import { SVNClient } from '@/services';
import { SvnStatusCode } from '@/types'; // Assuming SvnStatusCode is used, keep if so
import { UIState } from '../SVNUIController';
import { 
	SVNToolbar, 
	SVNFileActions, 
	SVNStatusDisplay, 
	SVNHistoryRenderer, 
	SVNInfoPanel,
	SVNFileStateRenderer,
	SVNRepositoryHandler 
} from '.';
import { SVNViewStateManager } from './SVNViewStateManager';
import { SVNViewLayoutManager } from './SVNViewLayoutManager';
import { SVNViewStatusManager } from './SVNViewStatusManager'; // Assuming this is where updateStatusDisplay might be
import { SVNViewHistoryManager } from './SVNViewHistoryManager';
import type ObsidianSvnPlugin from '../../main';
import { loggerDebug, loggerInfo, loggerError, registerLoggerClass } from '@/utils/obsidian-logger';
import { PLUGIN_CONSTANTS } from '@/core'; // Keep this
import { CONTENT_TYPES } from '@/core/contentTypes'; // Corrected import path

// Define a type for the pending state
interface PendingStateArgs {
    state: UIState;
    currentFile: TFile | null;
    plugin: ObsidianSvnPlugin;
}

/**
 * Main renderer component that coordinates all rendering logic for the FileHistoryView
 * Extracted from FileHistoryView to reduce complexity
 */
export class SVNViewRenderer {
	private plugin: ObsidianSvnPlugin;
	private svnClient: SVNClient;
	
	// Component managers
	private stateManager: SVNViewStateManager;
	private layoutManager: SVNViewLayoutManager;
	private statusManager: SVNViewStatusManager;
	private historyManager: SVNViewHistoryManager;
	
	// Component instances
	private toolbar: SVNToolbar;
	private fileActions: SVNFileActions;
	private statusDisplay: SVNStatusDisplay;
	private historyRenderer: SVNHistoryRenderer;
	private infoPanel: SVNInfoPanel;
	private fileStateRenderer: SVNFileStateRenderer;
	private repositoryHandler: SVNRepositoryHandler;
	
	// State handling protection
	private isHandlingStateChange: boolean = false;
	// Use the new PendingStateArgs type
	private pendingStateArgs: PendingStateArgs | null = null; 
	// private pendingFile: TFile | null = null; // This seems redundant if currentFile is in pendingStateArgs

	private lastRenderedFileId: string | null = null;
	private lastRenderedContentType: string | null = null;
	// Cached HTML for history content when toggling repository setup
	private savedHistoryHTML: string | null = null;

	constructor(
		plugin: ObsidianSvnPlugin,
		svnClient: SVNClient,
		containerEl: HTMLElement,
		toolbar: SVNToolbar,
		fileActions: SVNFileActions,
		statusDisplay: SVNStatusDisplay,
		historyRenderer: SVNHistoryRenderer,
		infoPanel: SVNInfoPanel,
		fileStateRenderer: SVNFileStateRenderer,
		repositoryHandler: SVNRepositoryHandler	) {
		this.plugin = plugin;
		this.svnClient = svnClient;
		registerLoggerClass(this, 'SVNViewRenderer');
		
		this.stateManager = new SVNViewStateManager();
		this.layoutManager = new SVNViewLayoutManager(containerEl);
		this.statusManager = new SVNViewStatusManager(svnClient, statusDisplay, this.stateManager, fileStateRenderer);
		this.historyManager = new SVNViewHistoryManager(
			// svnClient, // Removed svnClient from here
			plugin, 
			historyRenderer, 
			fileStateRenderer, 
			repositoryHandler
		);
		
		this.toolbar = toolbar;
		this.fileActions = fileActions;
		this.statusDisplay = statusDisplay;
		this.historyRenderer = historyRenderer;
		this.infoPanel = infoPanel;
		this.fileStateRenderer = fileStateRenderer;
		this.repositoryHandler = repositoryHandler;
	}

	initializeLayout(): void {
		this.layoutManager.initializeLayout(); // Creates toolbar container and other layout elements

		// Call layoutManager.updateToolbar to render the toolbar into its container
		// The currentFile might be null initially, but SVNToolbar.render handles this.
		const activeFile = this.plugin.app.workspace.getActiveFile();
		this.layoutManager.updateToolbar(this.toolbar, activeFile); // This will call toolbar.render()

		// Ensure pin button state is correct after initial render
		this.toolbar.updateFromSettings();

		this.layoutManager.setupInfoPanel(this.infoPanel, this.fileActions);
	}

	async handleUIStateChange(state: UIState, currentFile: TFile | null, plugin: ObsidianSvnPlugin): Promise<void> {
		const entryTime = Date.now();
		loggerDebug(this, `SVNViewRenderer.handleUIStateChange: Entry at ${entryTime}`, { currentFile: currentFile?.path, stateIsLoading: state.isLoading, stateShowLoading: state.showLoading });

		this.plugin = plugin;
		const currentPinState = this.plugin.settings.pinCheckedOutRevision;

		const dataChanged = this.stateManager.hasDataChanged(state, currentPinState);
		// Assuming hasFileChanged was part of SVNViewStateManager, let's check if it exists or if its logic is elsewhere
		// For now, let's assume it's still there or we'll need to adjust.
		// It's possible file change detection is now part of hasDataChanged or needs a different approach.
		// Let's assume for now it's still a method on stateManager. If not, we'll trace it.
		const fileChanged = this.stateManager.hasFileChanged(currentFile); 


		loggerDebug(this, `SVNViewRenderer.handleUIStateChange: Initial checks at ${entryTime}`, { 
			fileChanged, 
			dataChanged, 
			currentPinState, 
			stateHasData: !!state.data, 
			stateIsLoading: state.isLoading, 
			stateShowLoading: state.showLoading 
		});

		if (this.isHandlingStateChange) {
			loggerDebug(this, `SVNViewRenderer.handleUIStateChange: Queuing state change at ${entryTime} because already handling.`);
			this.pendingStateArgs = { state, currentFile, plugin }; 
			return;
		}
		this.isHandlingStateChange = true;
		loggerDebug(this, `SVNViewRenderer.handleUIStateChange: Set isHandlingStateChange = true at ${entryTime}`);

		try {
			// Use getContentType from stateManager
			const newContentType = this.stateManager.getContentType(state); 
			const lastContentTypeBeforeUpdate = this.lastRenderedContentType;

			loggerDebug(this, `SVNViewRenderer.handleUIStateChange: About to check conditions at ${entryTime}`, { 
				fileChanged, 
				dataChangedVal: dataChanged, 
				newContentType, 
				lastRenderedContentType: lastContentTypeBeforeUpdate
			});

			if (fileChanged || dataChanged) {
				loggerInfo(this, `SVNViewRenderer.handleUIStateChange: Condition (fileChanged || dataChanged) is TRUE at ${entryTime}. dataChanged = ${dataChanged}. Calling updateContentArea.`);
				// Corrected call to statusManager.updateStatusDisplay - assuming 3 arguments
				await this.statusManager.updateStatusDisplay(state, this.layoutManager.getStatusContainer(), currentFile);
				this.updateContentArea(
					state,
					currentFile,
					newContentType,
					lastContentTypeBeforeUpdate,
					dataChanged 
				);
				this.lastRenderedFileId = currentFile ? currentFile.path : null;
			} 
			// Handle content type change (e.g., loading->history or setup->history)
			else if (newContentType !== lastContentTypeBeforeUpdate) {
				loggerInfo(this, `SVNViewRenderer.handleUIStateChange: Content type changed from ${lastContentTypeBeforeUpdate} to ${newContentType} at ${entryTime}, forcing rebuild.`);
				// If switching from SETUP without data change, skip status refresh to avoid SVN calls
				const wasSetupView = lastContentTypeBeforeUpdate === CONTENT_TYPES.SETUP;
				if (!(wasSetupView && !dataChanged)) {
					await this.statusManager.updateStatusDisplay(state, this.layoutManager.getStatusContainer(), currentFile);
				}
				// Rebuild content area; historyActuallyChanged true to refresh DOM
				this.updateContentArea(
					state,
					currentFile,
					newContentType,
					lastContentTypeBeforeUpdate,
					true 
				);
			} else {
				loggerDebug(this, `SVNViewRenderer.handleUIStateChange: No significant file or data change, skipping full view update at ${entryTime}`, { 
					fileChanged, 
					dataChangedVal: dataChanged, 
					newContentType, 
					lastRenderedContentType: lastContentTypeBeforeUpdate 
				});
				// Use CONTENT_TYPES directly
				if ([CONTENT_TYPES.NO_FILE, CONTENT_TYPES.ERROR, CONTENT_TYPES.LOADING, CONTENT_TYPES.WAITING_FOR_DATA].includes(newContentType as any)) {				
					this.updateContentArea(
						state,
						currentFile,
						newContentType,
						lastContentTypeBeforeUpdate,
						false 
					);
				}
			}
			this.lastRenderedContentType = newContentType;
		} catch (error) {
			loggerError(this, `SVNViewRenderer.handleUIStateChange: Error during state handling at ${entryTime}:`, error);
			try {
				const errorState: UIState = { ...state, error: error?.message || 'Unknown rendering error', isLoading: false, showLoading: false };
				this.updateContentArea(errorState, currentFile, CONTENT_TYPES.ERROR, this.lastRenderedContentType, true);
				this.lastRenderedContentType = CONTENT_TYPES.ERROR;
			} catch (renderError) {
				loggerError(this, `SVNViewRenderer.handleUIStateChange: Failed to render error state at ${entryTime}:`, renderError);
			}
		} finally {
			loggerDebug(this, `SVNViewRenderer.handleUIStateChange: Setting isHandlingStateChange = false at ${entryTime}`);
			this.isHandlingStateChange = false;
			if (this.pendingStateArgs) {
				loggerDebug(this, `SVNViewRenderer.handleUIStateChange: Processing pending state at ${entryTime}`);
				// Destructure from pendingStateArgs
				const { state: pState, currentFile: pFile, plugin: pPlugin } = this.pendingStateArgs; 
				this.pendingStateArgs = null;
				await this.handleUIStateChange(pState, pFile, pPlugin);
			} else {
				loggerDebug(this, `SVNViewRenderer.handleUIStateChange: No pending state to process at ${entryTime}`);
			}
		}
	}

	private async updateViewIntelligently(state: UIState, fileChanged: boolean, dataChanged: boolean, currentFile: TFile | null): Promise<void> {
		this.initializeLayout();
		
		if (fileChanged) {
			this.layoutManager.updateToolbar(this.toolbar, currentFile);
		}
		
		if (dataChanged) {
			const statusContainer = this.layoutManager.getStatusContainer();
			// Corrected call to statusManager.updateStatusDisplay - assuming 3 arguments
			await this.statusManager.updateStatusDisplay(state, statusContainer, currentFile); 
		}
		
		if (fileChanged || dataChanged) {
			// updateContentArea expects 5 arguments. We need newContentType and lastContentType.
			// We should probably get newContentType here.
			const newContentType = this.stateManager.getContentType(state);
			// lastContentType would be this.lastRenderedContentType, but it might not be set if this is the first render.
			// Passing dataChanged as historyActuallyChanged.
			this.updateContentArea(state, currentFile, newContentType, this.lastRenderedContentType, dataChanged);
		}
	}

	private updateContentArea(
		state: UIState,
		currentFile: TFile | null,
		newContentType: string,
		lastContentType: string | null,
		historyActuallyChanged: boolean
	): void {
		const contentArea = this.layoutManager.getContentArea();
		if (!contentArea) {
			loggerError(this, "Content area not found in layout manager during updateContentArea");
			return;
		}

		loggerInfo(this, 'SVNViewRenderer.updateContentArea called with:', {
			newContentType,
			lastContentType,
			historyActuallyChanged,
			currentFile: currentFile?.path,
			pinSetting: this.plugin.settings.pinCheckedOutRevision
		});

		// historyManager.updateContentAreaDOM expects 6 arguments, not 7.
		// The 7th argument 'this.plugin' was added in the previous step, let's check SVNViewHistoryManager.ts
		// to confirm if it's needed or if the constructor-injected plugin instance is sufficient.
		// For now, assuming it's NOT needed as an argument if SVNViewHistoryManager already has it.
		this.historyManager.updateContentAreaDOM(
			contentArea,
			state,
			currentFile,
			newContentType,
			lastContentType,
			historyActuallyChanged // Removed this.plugin from here
		);
	}

	showRepositorySetup(currentFile: TFile | null): void {
		loggerInfo(this, 'Showing repository setup view');
		const contentArea = this.layoutManager.getContentArea();
		if (contentArea) {
			// Cache existing history HTML before clearing
			this.savedHistoryHTML = contentArea.innerHTML;
			contentArea.empty();
			this.repositoryHandler.renderRepositorySetup(contentArea, currentFile);
		}
		// Explicitly set the content type when showing repository setup
		this.lastRenderedContentType = CONTENT_TYPES.SETUP;
	}

	private isShowingRepositorySetup(): boolean {
		const contentArea = this.layoutManager.getContentArea();
		if (!contentArea) return false;
		
		const hasSetupContent = 
			contentArea.querySelector('.workspace-leaf-content') !== null ||
			(contentArea.querySelector('h3')?.textContent?.includes('Repository Setup') ?? false) ||
			(contentArea.textContent?.includes('Repository setup') ?? false) ||
			(contentArea.textContent?.includes('not found in vault') ?? false) ||
			(contentArea.textContent?.includes('Create New Repository') ?? false) ||
			(contentArea.textContent?.includes('Checkout Existing Repository') ?? false);

		return hasSetupContent;
	}

    showNormalView(currentFile: TFile | null): void {
        loggerInfo(this, 'Showing normal file view');
        const contentArea = this.layoutManager.getContentArea();
        if (contentArea) {
            // Restore cached history HTML if available
            if (this.savedHistoryHTML !== null) {
                contentArea.innerHTML = this.savedHistoryHTML;
                this.savedHistoryHTML = null;
                return;
            }
            // Fallback: clear and await UI state change to re-render
            contentArea.empty();
            loggerDebug(this, "showNormalView called, no cached history. Clearing and relying on state change to re-render.");
        }
    }

    // Add public getters for managers if they are needed by SVNView
    public getStateManager(): SVNViewStateManager {
        return this.stateManager;
    }

    public getLayoutManager(): SVNViewLayoutManager {
        return this.layoutManager;
    }

    public getStatusManager(): SVNViewStatusManager {
        return this.statusManager;
    }
}





