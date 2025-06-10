import { Notice, WorkspaceLeaf, setTooltip } from 'obsidian';
import { ButtonComponent } from 'obsidian';
import { SVNClient } from '../../services/SVNClient';
import { DiffModal } from '../../modals/DiffModal';
import { SvnLogEntry, SvnStatusCode } from '@/types';
import { loggerDebug, loggerInfo, loggerError, loggerWarn, registerLoggerClass } from '@/utils/obsidian-logger';

export class SVNHistoryRenderer {
	private svnClient: SVNClient;
	private plugin: any;
	private refreshCallback: () => void;
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
				this.showDiff(filePath, history[index - 1].revision, entry.revision);
			});
			buttonsAdded = true;
		}

		// Checkout button - only show if this is not the currently checked out revision
		if (currentRevision === undefined || entry.revision !== currentRevision) {
			const checkoutBtn = new ButtonComponent(actionsEl)
				.setIcon('download')
				.setTooltip(`Checkout revision ${entry.revision}`)
				.setClass('clickable-icon')
			checkoutBtn.buttonEl.addEventListener('click', (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				this.checkoutRevision(filePath, entry.revision.toString());
			});
			buttonsAdded = true;
		}
		
		// Add preview image if available
		if (entry.previewImagePath && this.currentFilePathForPreviews && previewContainer) {
			const imgEl = previewContainer.createEl('img', { cls: 'svn-history-preview-thumbnail' });
			setTooltip(imgEl, `Click to enlarge preview for revision ${entry.revision}`);
			
			// Asynchronously load and set the image source
			this.svnClient.getLocalPreviewImage(
				this.currentFilePathForPreviews, // The working path of the main file (e.g., .blend file)
				entry.previewImagePath,       // Repo-relative path of the preview image
				entry.revision.toString()     // Revision number
			).then(localPath => {
				if (localPath) {
					// Convert absolute path to vault-relative path for Obsidian
					let vaultRelativePath = localPath;
					if (this.plugin.app.vault.adapter.basePath) {
						const basePath = this.plugin.app.vault.adapter.basePath;
						if (localPath.startsWith(basePath)) {
							vaultRelativePath = localPath.substring(basePath.length + 1).replace(/\\/g, '/');
						}
					}
					
					// Obsidian specific way to get a usable URL for local plugin files
					const imgSrc = this.plugin.app.vault.adapter.getResourcePath(vaultRelativePath);
					loggerDebug(this, 'Preview image paths:', {
						localPath,
						basePath: this.plugin.app.vault.adapter.basePath,
						vaultRelativePath,
						imgSrc
					});
					
					imgEl.src = imgSrc;
					
					// Add click handler for larger view
					imgEl.addEventListener('click', (evt) => {
						evt.preventDefault();
						evt.stopPropagation();
						this.showPreviewModal(imgSrc, entry.revision);
					});
				} else {
					imgEl.style.display = 'none'; // Hide if not found or error
					loggerWarn(this, `Could not load local preview for r${entry.revision}, path: ${entry.previewImagePath}`);
				}
			}).catch(err => {
				imgEl.style.display = 'none';
				loggerError(this, `Error loading preview image for r${entry.revision}:`, err);
			});
		}
		return buttonsAdded;
	}

	private showDiff(filePath: string, fromRevision: number, toRevision: number): void {
		// Use getDiff method from SVNClient - it accepts an optional revision parameter
		this.svnClient.getDiff(filePath, toRevision.toString()).then((diffContent: string) => {
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
								   statusArray.some(item => item.status === SvnStatusCode.MODIFIED);
				
				// Fallback: If status check returned empty, assume no modifications
				if (!statusArray || statusArray.length === 0) {
					hadModifications = false;
				}
				
			} catch (statusError) {
				// Continue with checkout even if status check fails
				loggerError(this, 'Could not check file status before checkout:', statusError);
			}
			
			// Perform the checkout
			await this.svnClient.checkoutRevision(filePath, revision);
			
			// Verify the checkout worked by checking the current revision
			try {
				const info = await this.svnClient.getInfo(filePath);
				if (info && info.revision.toString() !== revision) {
					loggerError(this, `Checkout may have failed: expected r${revision}, got r${info.revision}`);
				}
			} catch (verifyError) {
				loggerError(this, 'Could not verify checkout success:', verifyError);
			}
			  // Force Obsidian to reload the file from disk
			await this.forceFileReload(filePath);
			
			// Show appropriate success message
			if (hadModifications) {
				new Notice(
					`Checked out revision ${revision}. Your local modifications were discarded.\n` +
					`To recover: Press Ctrl+Z to undo, then commit your changes first.`,
					8000  // Show for 8 seconds
				);
			} else {
				new Notice(`Checked out revision ${revision}.`);
			}
			
			loggerInfo(this, `Checked out revision ${revision} for ${filePath}`);
			
			// Force file reload first to ensure Obsidian sees the changes
			await this.forceFileReload(filePath);
			
			// Give a small delay for file system events to propagate, then refresh data
			setTimeout(() => {
				loggerInfo(this, '[SVN HistoryRenderer] Triggering refresh after checkout');
				this.refreshCallback();
			}, 100);
		} catch (error: any) {
			loggerError(this, 'Error checking out revision:', error);
			new Notice(`Failed to checkout revision ${revision}: ${error.message}`, 5000);
		}
	}
	
	private async forceFileReload(filePath: string): Promise<void> {
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
}





