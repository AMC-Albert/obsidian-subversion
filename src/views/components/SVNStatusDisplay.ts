import { TFile } from 'obsidian';
import { SVNClient } from '../../services/SVNClient';
import { SVNStatusUtils } from '../../utils/SVNStatusUtils';
import { SVNConstants } from '../../utils/SVNConstants';
import { SvnStatusCode } from '@/types';
import { debug, info, error, registerLoggerClass } from '@/utils/obsidian-logger';

export class SVNStatusDisplay {
	private svnClient: SVNClient;
	private isRendering: boolean = false;
	private lastRenderPromise: Promise<void> | null = null;

	constructor(svnClient: SVNClient) {
		this.svnClient = svnClient;
		registerLoggerClass(this, 'SVNStatusDisplay');
	}
	async render(container: HTMLElement, currentFile: TFile | null): Promise<void> {
		// Prevent multiple simultaneous renders for the same container
		if (this.isRendering) {
			debug(this, 'Already rendering, reusing existing promise');
			if (this.lastRenderPromise) {
				return this.lastRenderPromise;
			}
		}
		
		this.isRendering = true;
		this.lastRenderPromise = this.doRender(container, currentFile);
		
		try {
			await this.lastRenderPromise;
		} finally {
			this.isRendering = false;
			this.lastRenderPromise = null;
		}
	}
	
	private async doRender(container: HTMLElement, currentFile: TFile | null): Promise<void> {
		container.empty();

		// Prevent nested .svn-status-display divs
		let statusEl: HTMLElement;
		if (container.hasClass('svn-status-display')) {
			statusEl = container;
		} else {
			statusEl = container.createEl('div', { cls: 'svn-status-display' });
		}

		if (!currentFile || !this.isSvnClientReady()) {
			return;
		}

		await this.renderStatusContent(statusEl, currentFile);
	}

	private async renderStatusContent(statusEl: HTMLElement, currentFile: TFile): Promise<void> {
		try {
			// Check if file is in working copy
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
			
			// Get file info to show current revision
			const svnInfo = await this.svnClient.getInfo(currentFile.path);
			
			// Create status container with revision info
			const statusContainer = statusEl.createEl('div', { cls: 'svn-status-container' });
			
			// Show current revision if available
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
				debug(this, "svnInfo type:", typeof svnInfo);
				debug(this, "lastChangedRev:", svnInfo?.lastChangedRev);
			}
			
			// Get file status
			const statusArray = await this.svnClient.getStatus(currentFile.path);
			const fileStatus = statusArray.find(item => 
				item.filePath.includes(currentFile.name) || 
				item.filePath.endsWith(currentFile.path)
			);			if (fileStatus && fileStatus.status === SvnStatusCode.UNVERSIONED) {
				// If file is unversioned, do not show generic status (let file state renderer handle it)
				return;
			}
			
			const statusTextEl = statusContainer.createEl('span', { cls: 'svn-status-text' });
			if (!statusArray || statusArray.length === 0) {
				this.createStatusWithIcon(statusTextEl, SVNConstants.ICONS.UP_TO_DATE, SVNConstants.MESSAGES.UP_TO_DATE, SVNConstants.CSS_CLASSES.UP_TO_DATE);
			} else {
				// Find status for current file
				if (!fileStatus) {
					this.createStatusWithIcon(statusTextEl, SVNConstants.ICONS.UP_TO_DATE, SVNConstants.MESSAGES.UP_TO_DATE, SVNConstants.CSS_CLASSES.UP_TO_DATE);				} else {
					// Special handling for MODIFIED status - check if there are actual content differences
					if (fileStatus.status === SvnStatusCode.MODIFIED) {
						const hasActualChanges = await this.hasActualContentChanges(currentFile.path);						if (hasActualChanges) {
							this.createStatusWithIcon(statusTextEl, SVNConstants.ICONS.MODIFIED, SVNConstants.MESSAGES.MODIFIED, SVNConstants.CSS_CLASSES.MODIFIED);
						} else {
							this.createStatusWithIcon(statusTextEl, SVNConstants.ICONS.UP_TO_DATE, SVNConstants.MESSAGES.UP_TO_DATE, SVNConstants.CSS_CLASSES.UP_TO_DATE);
						}
					} else {
						const statusText = SVNStatusUtils.getStatusText(fileStatus.status);
						const icon = SVNStatusUtils.getStatusIcon(fileStatus.status);
						const cssClass = SVNStatusUtils.getStatusClass(fileStatus.status);
						this.createStatusWithIcon(statusTextEl, icon, statusText, cssClass);
					}}
			}		} catch (err) {
			error(this, 'Error in renderStatusContent:', err);
			const errorEl = statusEl.createEl('span', { cls: 'svn-status-text' });
			this.createStatusWithIcon(errorEl, SVNConstants.ICONS.ERROR, SVNConstants.MESSAGES.ERROR_GETTING_STATUS, SVNConstants.CSS_CLASSES.ERROR);
		}
	}	/**
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
			return hasChanges;		} catch (err) {
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









