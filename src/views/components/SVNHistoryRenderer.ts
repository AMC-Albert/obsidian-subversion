import { Notice, WorkspaceLeaf, setTooltip } from 'obsidian';
import { ButtonComponent } from 'obsidian';
import { SVNClient } from '../../services/SVNClient';
import { DiffModal, ConfirmCheckoutModal, ConflictResolutionModal } from '../../modals';
import { SvnLogEntry, SvnStatusCode } from '@/types';
import { loggerDebug, loggerInfo, loggerError, loggerWarn, registerLoggerClass } from '@/utils/obsidian-logger';

export class SVNHistoryRenderer {
	private svnClient: SVNClient;
	private plugin: any;
	public refreshCallback: () => void;
	private currentFilePathForPreviews: string | null = null;

	constructor(svnClient: SVNClient, plugin: any, refreshCallback: () => void) {
		this.svnClient = svnClient;
		this.plugin = plugin;
		this.refreshCallback = refreshCallback;
		registerLoggerClass(this, 'SVNHistoryRenderer');
	}

	public setCurrentFileForPreviews(filePath: string | null): void {
		this.currentFilePathForPreviews = filePath;
	}

	/**
	 * Add action buttons for a history item (used by data bus system)
	 * @returns true if any buttons were added, false otherwise
	 */
	addHistoryItemActions(actionsEl: HTMLElement, filePath: string, entry: SvnLogEntry, index: number, history: SvnLogEntry[], previewContainer?: HTMLElement | null, currentRevision?: number): boolean {
		let buttonsAdded = false;
		
		// Diff button (not available for first revision)
		if (index > 0) {
			const diffBtn = new ButtonComponent(actionsEl)
				.setIcon('file-diff')
				.setTooltip(`Show diff from r${history[index - 1].revision} to r${entry.revision}`)
				.setClass('clickable-icon');
			diffBtn.buttonEl.addEventListener('click', (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				this.showDiff(filePath, history[index - 1].revision.toString(), entry.revision.toString());
			});
			buttonsAdded = true;
		}
		// Checkout button - only show if this is not the currently checked out revision
		if (currentRevision === undefined || entry.revision !== currentRevision) {
			const isFutureRevision = currentRevision && entry.revision > currentRevision;
			const checkoutBtn = new ButtonComponent(actionsEl)
				.setIcon(isFutureRevision ? 'fast-forward' : 'download')
				.setTooltip(isFutureRevision ? 
					`Update to future revision ${entry.revision}` : 
					`Checkout revision ${entry.revision}`)
				.setClass('clickable-icon')
			
			if (isFutureRevision) {
				checkoutBtn.buttonEl.addClass('svn-future-action');
			}
			
			checkoutBtn.buttonEl.addEventListener('click', (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				this.checkoutRevision(filePath, entry.revision.toString());
			});
			buttonsAdded = true;
		}
		
		// Add preview image if available
		// Check if a preview should be attempted based on current file context
		if (this.currentFilePathForPreviews && previewContainer) {
			const imgEl = previewContainer.createEl('img', { cls: 'svn-history-preview-thumbnail' });
			setTooltip(imgEl, `Click to enlarge preview for revision ${entry.revision}`);
			
			// Asynchronously load and set the image source
			// Use the main file path (this.currentFilePathForPreviews) and the revision from the log entry.
			// The SVNSidecarManager will determine the expected preview file name.
			this.svnClient.getLocalPreviewImage(
				this.currentFilePathForPreviews, 
				entry.revision // Pass revision number directly
			).then(localPath => {
				if (localPath) {
					// Convert absolute path to vault-relative path for Obsidian
					let vaultRelativePath = localPath;
					const adapter = this.plugin.app.vault.adapter as any; // Cast to any for basePath
					if (adapter.basePath && localPath.startsWith(adapter.basePath)) {
						vaultRelativePath = localPath.substring(adapter.basePath.length + 1).replace(/\\/g, '/');
					}
					
					const imgSrc = adapter.getResourcePath(vaultRelativePath);
					loggerDebug(this, 'Preview image paths for history:', {
						mainFile: this.currentFilePathForPreviews,
						revision: entry.revision,
						localPath,
						basePath: adapter.basePath,
						vaultRelativePath,
						imgSrc
					});
					
					imgEl.src = imgSrc;
					
					imgEl.addEventListener('click', (evt) => {
						evt.preventDefault();
						evt.stopPropagation();
						this.showPreviewModal(imgSrc, entry.revision);
					});
				} else {
					imgEl.style.display = 'none'; 
					loggerWarn(this, `Could not get local preview for ${this.currentFilePathForPreviews} at r${entry.revision}.`);
				}
			}).catch((err: any) => {
				imgEl.style.display = 'none';
				loggerError(this, `Error loading preview image for ${this.currentFilePathForPreviews} at r${entry.revision}:`, err);
			});
		}
		return buttonsAdded;
	}

	private showDiff(filePath: string, fromRevision: string, toRevision: string): void {
		// Use getDiff method from SVNClient - it accepts an optional revision parameter
		this.svnClient.getDiff(filePath, fromRevision, toRevision).then((diffContent: string) => {
			new DiffModal(this.plugin.app, diffContent, `r${fromRevision} → r${toRevision}`).open();
		}).catch((err: any) => {
			loggerError(this, 'Error showing diff:', err);
			// Could show a notice here
		});
	}
		async checkoutRevision(filePath: string, revision: string): Promise<void> {
		try {
			// Check if file has modifications before checkout
			let hadModifications = false;
			try {
				const statusArray = await this.svnClient.getStatus(filePath);
				// Check if we have any results and if any file shows modifications
				hadModifications = statusArray && statusArray.length > 0 && 
								   statusArray.some(item => this.svnClient.comparePaths(item.filePath, filePath) && 
								   	(item.status === SvnStatusCode.MODIFIED || item.status === SvnStatusCode.CONFLICTED));
				
				// Fallback: If status check returned empty, assume no modifications
				if (!statusArray || statusArray.length === 0) {
					hadModifications = false;
				}
				
			} catch (statusError) {
				// Continue with checkout even if status check fails
				loggerError(this, 'Could not check file status before checkout:', statusError);
			}			// If file has modifications, ask user for confirmation
			if (hadModifications) {
				return new Promise<void>((resolve) => {
					new ConfirmCheckoutModal(
						this.plugin.app,
						filePath,
						revision,
						() => {
							// User confirmed - continue with checkout
							this.performCheckout(filePath, revision, hadModifications).then(resolve);
						},
						() => {
							// User cancelled
							new Notice('Checkout cancelled by user.');
							resolve();
						}
					).open();
				});
			}

			// No modifications - proceed directly
			await this.performCheckout(filePath, revision, hadModifications);
		} catch (error: any) {
			loggerError(this, 'Error checking out revision:', error);
			new Notice(`Failed to checkout revision ${revision}: ${error.message}`, 5000);
		}
	}

	private async performCheckout(filePath: string, revision: string, hadModifications: boolean): Promise<void> {
		try {
			// Perform the checkout
			const result = await this.svnClient.updateToRevision(filePath, revision);
			
			// Check if the result indicates conflicts
			const hasConflicts = result && (result.includes('conflicts') || result.includes('conflict'));
			
			// Verify the checkout worked by checking the current revision
			let actualRevision: number | undefined;
			try {
				const info = await this.svnClient.getInfo(filePath);
				actualRevision = info?.revision;
				if (actualRevision && actualRevision.toString() !== revision) {
					loggerWarn(this, `Checkout may not have completed fully: expected r${revision}, got r${actualRevision}`);
				}
			} catch (verifyError) {
				loggerError(this, 'Could not verify checkout success:', verifyError);
			}
			
			// Force Obsidian to reload the file from disk
			await this.forceFileReload(filePath);
					// Show appropriate success/warning message
			if (hasConflicts) {
				new Notice(
					`Checked out revision ${revision} but conflicts occurred.\n` +
					`Opening conflict resolution dialog...`,
					4000
				);
				// Handle conflicts automatically
				setTimeout(() => {
					this.handleConflicts(filePath);
				}, 500);
			} else if (hadModifications) {
				new Notice(
					`Checked out revision ${revision}. Your local modifications were discarded.\n`,
					5000
				);
			} else {
				new Notice(`Successfully checked out revision ${revision}.`);
			}
			
			loggerInfo(this, `Checked out revision ${revision} for ${filePath}`);
			
			// Force file reload first to ensure Obsidian sees the changes
			await this.forceFileReload(filePath);
			
			// Give a small delay for file system events to propagate, then refresh data
			setTimeout(() => {
				loggerInfo(this, '[SVN HistoryRenderer] Triggering refresh after checkout');
				this.refreshCallback();
			}, 200); // Increased delay to allow for conflict resolution
		} catch (error: any) {
			loggerError(this, 'Error checking out revision:', error);
			new Notice(`Failed to checkout revision ${revision}: ${error.message}`, 5000);
		}
	}
	
	public async forceFileReload(filePath: string): Promise<void> {
		try {
			// Get the TFile object for the changed file
			const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
			if (file) {
				// Force Obsidian to read the file from disk and trigger change events
				const content = await this.plugin.app.vault.adapter.read(filePath);
				
				// Trigger file change event to refresh editors but avoid 'modify' which triggers auto-commit
				this.plugin.app.vault.trigger('changed', file);
				
				// Update open editors more efficiently without triggering modify events
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
			loggerError(this, 'Could not force file reload:', error);
			// Continue anyway - the SVN view will still be updated
		}
	}

	/**
	 * Show a modal with a larger preview image
	 */
	private showPreviewModal(imageSrc: string, revision: number): void {
		const { Modal } = require('obsidian');
		const modal = new Modal(this.plugin.app);
		modal.titleEl.textContent = `Preview for Revision ${revision}`;
		
		modal.onOpen = () => {
			const { contentEl } = modal;
			contentEl.addClass('svn-preview-modal');
			
			const imgContainer = contentEl.createDiv({ cls: 'svn-preview-container' });
			imgContainer.style.textAlign = 'center';
			imgContainer.style.padding = '20px';
			
			const img = imgContainer.createEl('img');
			img.src = imageSrc;
			img.style.maxWidth = '90vw';
			img.style.maxHeight = '90vh';
			img.style.objectFit = 'contain';
			img.alt = `Full preview for revision ${revision}`;
		};
		
		modal.open();
	}

	/**
	 * Handle conflict resolution after a checkout
	 */
	private async handleConflicts(filePath: string): Promise<void> {
		try {
			const statusArray = await this.svnClient.getStatus(filePath);
			const hasConflicts = statusArray && statusArray.some(item => 
				this.svnClient.comparePaths(item.filePath, filePath) && 
				item.status === SvnStatusCode.CONFLICTED
			);			if (hasConflicts) {
				new ConflictResolutionModal(
					this.plugin.app,
					filePath,
					async (resolution: 'working' | 'theirs') => {
						try {
							await this.resolveConflict(filePath, resolution);
						} catch (error: any) {
							loggerError(this, 'Error resolving conflict:', error);
							new Notice(`Failed to resolve conflict: ${error.message}`, 5000);
						}
					}
				).open();
			}
		} catch (error: any) {
			loggerError(this, 'Error handling conflicts:', error);
		}
	}

	/**
	 * Resolve conflicts using SVN resolve command
	 */
	private async resolveConflict(filePath: string, resolution: 'working' | 'theirs' | 'mine'): Promise<void> {
		try {
			// Map resolution type to SVN accept option
			const acceptOption = resolution === 'working' ? 'working' : 
								 resolution === 'theirs' ? 'theirs-full' : 'mine-full';
			
			const absolutePath = this.svnClient.resolveAbsolutePath(filePath);
			const workingCopyRoot = this.svnClient.findSvnWorkingCopy(absolutePath);
			
			if (!workingCopyRoot) {
				throw new Error(`Not in SVN working copy: ${filePath}`);
			}

			const command = `svn resolve --accept ${acceptOption} "${absolutePath}"`;
			
			loggerInfo(this, 'Resolving conflict:', { command, resolution });
			
			const { execPromise } = await import('@/utils/AsyncUtils');
			await execPromise(command, { cwd: workingCopyRoot });
			
			new Notice(`Conflict resolved using ${resolution} version.`);
			
			// Force file reload after conflict resolution
			await this.forceFileReload(filePath);
			
		} catch (error: any) {
			loggerError(this, 'Error resolving conflict:', error);
			new Notice(`Failed to resolve conflict: ${error.message}`, 5000);
		}
	}
}





