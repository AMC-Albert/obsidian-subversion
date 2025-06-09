import { TFile } from 'obsidian';
import { SVNClient } from '../../services/SVNClient';
import { SVNStatusUtils } from '../../utils/SVNStatusUtils';
import { SVNConstants } from '../../utils/SVNConstants';
import { SvnStatusCode } from '@/types';
import { debug, info, error, registerLoggerClass } from '@/utils/obsidian-logger';

export class SVNStatusDisplay {
	private svnClient: SVNClient;
	private isRendering: boolean = false;
	private lastRenderPromise: Promise<DocumentFragment | null> | null = null;

	constructor(svnClient: SVNClient) {
		this.svnClient = svnClient;
		registerLoggerClass(this, 'SVNStatusDisplay');
	}
	async render(currentFile: TFile | null): Promise<DocumentFragment | null> {
		if (this.isRendering && this.lastRenderPromise) {
			debug(this, 'Already rendering, awaiting existing promise for DocumentFragment');
			// The existing promise should resolve to DocumentFragment | null
			return this.lastRenderPromise;
		}
		
		this.isRendering = true;
		// Ensure the promise type matches the new return type
		this.lastRenderPromise = this.doRender(currentFile); 
		
		try {
			return await this.lastRenderPromise;
		} finally {
			this.isRendering = false;
			this.lastRenderPromise = null;
		}
	}
	
	private async doRender(currentFile: TFile | null): Promise<DocumentFragment | null> {
		const fragment = document.createDocumentFragment();

		// Create the main .svn-status-display div within the fragment
		const statusEl = document.createElement('div');
		statusEl.addClass('svn-status-display');
		fragment.appendChild(statusEl);

		if (!currentFile || !this.isSvnClientReady()) {
			// If no file or client not ready, return the fragment with just the base div (or null if preferred)
			return fragment; 
		}

		await this.renderStatusContent(statusEl, currentFile);
		return fragment;
	}

	private async renderStatusContent(statusEl: HTMLElement, currentFile: TFile): Promise<void> {
		// This method now appends its content to statusEl, which is already part of the fragment.
		// It doesn't call container.empty() anymore.
		try {
			const isWorkingCopy = await this.svnClient.isWorkingCopy(currentFile.path);
			debug(this, 'isWorkingCopy check:', {
				filePath: currentFile.path,
				isWorkingCopy: isWorkingCopy
			});
			if (!isWorkingCopy) {
				debug(this, "File not in working copy, showing icon message");
				const notInWcEl = statusEl.createEl('span', { cls: 'svn-status-text' });
				this.createStatusWithIcon(notInWcEl, SVNConstants.ICONS.NOT_IN_WORKING_COPY, SVNConstants.MESSAGES.NOT_IN_WORKING_COPY, SVNConstants.CSS_CLASSES.WARNING);
				return;
			}
			
			const svnInfo = await this.svnClient.getInfo(currentFile.path);
			const statusContainer = statusEl.createEl('div', { cls: 'svn-status-container' });
			
			if (svnInfo && svnInfo.revision) {
				const revisionEl = statusContainer.createEl('span', { 
					cls: 'svn-status-revision'
				});
				revisionEl.createEl('span', { 
					text: 'r' + svnInfo.revision,
					cls: 'svn-revision-badge'
				});
				
				if (svnInfo.lastChangedAuthor) {
					revisionEl.createEl('span', {
						text: ' by ' + svnInfo.lastChangedAuthor,
						cls: 'svn-revision-author'
					});
				}
				if (svnInfo.lastChangedDate) {
					const date = new Date(svnInfo.lastChangedDate).toLocaleDateString();
					revisionEl.createEl('span', {
						text: ' on ' + date,
						cls: 'svn-revision-date'
					});
				}
			} else {
				debug(this, "No revision info available. svnInfo:", svnInfo);
			}
			
			const statusArray = await this.svnClient.getStatus(currentFile.path);
			const fileStatus = statusArray.find(item => 
				item.filePath.includes(currentFile.name) || 
				item.filePath.endsWith(currentFile.path)
			);

			if (fileStatus && fileStatus.status === SvnStatusCode.UNVERSIONED) {
				// For unversioned, SVNStatusDisplay should not render anything here,
				// as SVNViewStatusManager will handle it with a simpler message.
				// Clear statusEl if it was populated by revision info, or ensure it's minimal.
				statusEl.empty(); // Clear revision info if shown for an unversioned file
				const unversionedMsgEl = statusEl.createEl('span', { cls: 'svn-status-text' });
				this.createStatusWithIcon(unversionedMsgEl, SVNConstants.ICONS.UNVERSIONED, SVNConstants.MESSAGES.UNVERSIONED, SVNConstants.CSS_CLASSES.UNVERSIONED);
				return;
			}
			
			const statusTextEl = statusContainer.createEl('span', { cls: 'svn-status-text' });
			if (!statusArray || statusArray.length === 0 || !fileStatus) { // Added !fileStatus here
				this.createStatusWithIcon(statusTextEl, SVNConstants.ICONS.UP_TO_DATE, SVNConstants.MESSAGES.UP_TO_DATE, SVNConstants.CSS_CLASSES.UP_TO_DATE);
			} else {
				// Removed the SvnStatusCode.UNVERSIONED check here as it's handled above
				if (fileStatus.status === SvnStatusCode.MODIFIED) {
					const hasActualChanges = await this.hasActualContentChanges(currentFile.path);
					if (hasActualChanges) {
						this.createStatusWithIcon(statusTextEl, SVNConstants.ICONS.MODIFIED, SVNConstants.MESSAGES.MODIFIED, SVNConstants.CSS_CLASSES.MODIFIED);
					} else {
						this.createStatusWithIcon(statusTextEl, SVNConstants.ICONS.UP_TO_DATE, SVNConstants.MESSAGES.UP_TO_DATE, SVNConstants.CSS_CLASSES.UP_TO_DATE);
					}
				} else {
					const statusText = SVNStatusUtils.getStatusText(fileStatus.status);
					const icon = SVNStatusUtils.getStatusIcon(fileStatus.status);
					const cssClass = SVNStatusUtils.getStatusClass(fileStatus.status);
					this.createStatusWithIcon(statusTextEl, icon, statusText, cssClass);
				}
			}
		} catch (err) {
			error(this, 'Error in renderStatusContent:', err);
			statusEl.empty(); // Clear any partial content on error
			const errorEl = statusEl.createEl('span', { cls: 'svn-status-text' });
			this.createStatusWithIcon(errorEl, SVNConstants.ICONS.ERROR, SVNConstants.MESSAGES.ERROR_GETTING_STATUS, SVNConstants.CSS_CLASSES.ERROR);
		}
	}

	/**
	 * Create a status element with an icon and text
	 */
	createStatusWithIcon(container: HTMLElement, icon: string, text: string, cssClass: string): void {
		// Create icon element with fixed width
		const iconEl = container.createEl('span', { 
			text: icon,
			cls: 'svn-status-icon'
		});
		
		// Create text element
		const textEl = container.createEl('span', {
			text: text,
			cls: 'svn-status-label'
		});
		
		// Add the status-specific CSS class to the container
		container.addClass(cssClass);
	}

	/**
	 * Check if a file that appears as 'modified' in SVN status actually has content changes
	 * by using svn diff to compare against the repository version
	 */
	private async hasActualContentChanges(filePath: string): Promise<boolean> {
		try {
			const diff = await this.svnClient.getDiff(filePath);
			const hasChanges = diff.trim().length > 0;
			// Only log if there's a discrepancy (status shows modified but no diff)
			if (!hasChanges) {
				debug(this, `File ${filePath} shows as modified but has no diff content - likely reverted`);
			}
			return hasChanges;
		} catch (err) {
			error(this, 'Error checking for actual changes:', err);
			// If we can't get diff, assume there are changes to be safe
			return true;
		}
	}

	private isSvnClientReady(): boolean {
		return this.svnClient && 
			   typeof this.svnClient.setVaultPath === 'function';
	}
}









