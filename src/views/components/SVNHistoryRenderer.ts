import { Notice, WorkspaceLeaf } from 'obsidian';
import { ButtonComponent } from 'obsidian';
import { SVNClient } from '../../services/SVNClient';
import { DiffModal } from '../../modals/DiffModal';
import { SvnLogEntry } from '../../types';
import { svnDebug, svnInfo, svnError } from '../../debug';

export class SVNHistoryRenderer {
	private svnClient: SVNClient;
	private plugin: any;
	private refreshCallback: () => void;

	constructor(svnClient: SVNClient, plugin: any, refreshCallback: () => void) {
		this.svnClient = svnClient;
		this.plugin = plugin;
		this.refreshCallback = refreshCallback;
	}
	/**
	 * Add action buttons for a history item (used by data bus system)
	 */
	addHistoryItemActions(actionsEl: HTMLElement, filePath: string, entry: SvnLogEntry, index: number, history: SvnLogEntry[]): void {
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
		}
	}

	private showDiff(filePath: string, fromRevision: number, toRevision: number): void {
		// Use getDiff method from SVNClient - it accepts an optional revision parameter
		this.svnClient.getDiff(filePath, toRevision.toString()).then((diffContent: string) => {
			new DiffModal(this.plugin.app, diffContent, `r${fromRevision} → r${toRevision}`).open();
		}).catch((error: any) => {
			svnError(error);
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
								   statusArray.some(item => item.status.charAt(0) === 'M');
				
				// Fallback: If status check returned empty, assume no modifications
				if (!statusArray || statusArray.length === 0) {
					hadModifications = false;
				}
				
			} catch (statusError) {
				// Continue with checkout even if status check fails
				svnError('Could not check file status before checkout:', statusError);
			}
			
			// Perform the checkout
			await this.svnClient.checkoutRevision(filePath, revision);
			
			// Verify the checkout worked by checking the current revision
			try {
				const info = await this.svnClient.getInfo(filePath);
				if (info && info.revision !== revision) {
					svnError(`Checkout may have failed: expected r${revision}, got r${info.revision}`);
				}
			} catch (verifyError) {
				svnError('Could not verify checkout success:', verifyError);
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
			
			svnInfo(`Checked out revision ${revision} for ${filePath}`);
			
			// Force file reload first to ensure Obsidian sees the changes
			await this.forceFileReload(filePath);
			
			// Give a small delay for file system events to propagate, then refresh data
			setTimeout(() => {
				svnInfo('[SVN HistoryRenderer] Triggering refresh after checkout');
				this.refreshCallback();
			}, 100);
		} catch (error: any) {
			svnError('Error checking out revision:', error);
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
			svnError('Could not force file reload:', error);
			// Continue anyway - the SVN view will still be updated
		}
	}
}





