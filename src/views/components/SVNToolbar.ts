import { ButtonComponent, TFile, Notice } from 'obsidian';
import { SVNClient } from '../../services/SVNClient';
import type ObsidianSvnPlugin from '../../main';
import { SVNFileActions } from './SVNFileActions';
import { svnDebug, svnInfo, svnError } from '../../debug';

export class SVNToolbar {
	private plugin: ObsidianSvnPlugin;
	private svnClient: SVNClient;
	private fileActions: SVNFileActions;
	private onRefresh: () => void;
	private onShowRepoSetup: () => void;
	private containerEl: HTMLElement | null = null;
	private buttons: Map<string, ButtonComponent> = new Map();

	constructor(
		plugin: ObsidianSvnPlugin, 
		svnClient: SVNClient, 
		fileActions: SVNFileActions,
		onRefresh: () => void,
		onShowRepoSetup: () => void
	) {
		this.plugin = plugin;
		this.svnClient = svnClient;
		this.fileActions = fileActions;
		this.onRefresh = onRefresh;
		this.onShowRepoSetup = onShowRepoSetup;
	}
	render(container: HTMLElement, currentFile: TFile | null): void {
		container.empty();
		this.containerEl = container;
		this.buttons.clear(); // Clear previous button references
		const toolbarEl = container.createEl('div', { cls: 'nav-buttons-container' });

		this.buttons.set('add', new ButtonComponent(toolbarEl)
			.setIcon('plus')
			.setTooltip('Add file to version control')
			.setClass('clickable-icon')
			.onClick(() => this.fileActions.addFile(currentFile)));

		this.buttons.set('commit', new ButtonComponent(toolbarEl)
			.setIcon('check')
			.setTooltip('Commit file')
			.setClass('clickable-icon')
			.onClick(() => this.fileActions.quickCommit(currentFile)));

		this.buttons.set('revert', new ButtonComponent(toolbarEl)
			.setIcon('undo')
			.setTooltip('Revert file')
			.setClass('clickable-icon')
			.onClick(() => this.fileActions.revertFile(currentFile)));

		this.buttons.set('diff', new ButtonComponent(toolbarEl)
			.setIcon('file-diff')
			.setTooltip('Show diff')
			.setClass('clickable-icon')
			.onClick(() => this.fileActions.showCurrentDiff(currentFile)));

		this.buttons.set('info', new ButtonComponent(toolbarEl)
			.setIcon('info')
			.setTooltip('Show file info')
			.setClass('clickable-icon')
			.onClick(() => this.fileActions.toggleInfoDisplay()));

		this.buttons.set('remove', new ButtonComponent(toolbarEl)
			.setIcon('trash')
			.setTooltip('Remove file from version control')
			.setClass('clickable-icon')
			.onClick(() => this.fileActions.removeFromSvn(currentFile)));

		this.buttons.set('refresh', new ButtonComponent(toolbarEl)
			.setIcon('refresh-cw')
			.setTooltip('Refresh history')
			.setClass('clickable-icon')
			.onClick(() => this.onRefresh()));
		this.buttons.set('settings', new ButtonComponent(toolbarEl)
			.setIcon('wrench')
			.setTooltip('Repository setup')
			.setClass('clickable-icon')
			.onClick(() => this.onShowRepoSetup()));

		// Update button states based on current file
		this.updateButtonStates(currentFile);
	}

	/**
	 * Enable or disable the toolbar
	 */
	setEnabled(enabled: boolean): void {
		svnInfo(`Setting toolbar enabled: ${enabled}`);
		const container = this.containerEl;
		if (!container) return;
		
		// Toggle the disabled class on the entire toolbar
		if (enabled) {
			container.removeClass('svn-toolbar-disabled');
		} else {
			container.addClass('svn-toolbar-disabled');
		}
		
		// Disable/enable all buttons
		const buttons = container.querySelectorAll('button');
		buttons.forEach(button => {
			button.disabled = !enabled;
			if (enabled) {
				button.removeClass('disabled');
			} else {
				button.addClass('disabled');
			}
		});
		
		// Disable/enable all clickable icons
		const clickableIcons = container.querySelectorAll('.clickable-icon');
		clickableIcons.forEach(icon => {
			if (enabled) {
				icon.removeClass('disabled');
				(icon as HTMLElement).style.pointerEvents = '';
				(icon as HTMLElement).style.opacity = '';
			} else {
				icon.addClass('disabled');
				(icon as HTMLElement).style.pointerEvents = 'none';
				(icon as HTMLElement).style.opacity = '0.5';
			}
		});
	}
	/**
	 * Set a button's active state by its key
	 */
	setButtonActive(buttonKey: string, isActive: boolean): void {
		const button = this.buttons.get(buttonKey);
		if (!button) return;
		
		const buttonEl = button.buttonEl;
		if (isActive) {
			buttonEl.addClass('is-active');
		} else {
			buttonEl.removeClass('is-active');
		}
	}

	/**
	 * Toggle a button's active state
	 */
	toggleButtonActive(buttonKey: string): boolean {
		const isCurrentlyActive = this.isButtonActive(buttonKey);
		this.setButtonActive(buttonKey, !isCurrentlyActive);
		return !isCurrentlyActive;
	}

	/**
	 * Set multiple buttons' active states at once
	 */
	setButtonsActive(buttonStates: Record<string, boolean>): void {
		for (const [buttonKey, isActive] of Object.entries(buttonStates)) {
			this.setButtonActive(buttonKey, isActive);
		}
	}

	/**
	 * Get all button keys
	 */
	getButtonKeys(): string[] {
		return Array.from(this.buttons.keys());
	}

	/**
	 * Get a button by its key
	 */
	getButton(buttonKey: string): ButtonComponent | undefined {
		return this.buttons.get(buttonKey);
	}

	/**
	 * Check if a button is currently active
	 */
	isButtonActive(buttonKey: string): boolean {
		const button = this.buttons.get(buttonKey);
		if (!button) return false;
		return button.buttonEl.hasClass('is-active');
	}

	/**
	 * Set a button's disabled state by its key
	 */
	setButtonDisabled(buttonKey: string, isDisabled: boolean): void {
		const button = this.buttons.get(buttonKey);
		if (!button) return;
		
		button.buttonEl.disabled = isDisabled;
		if (isDisabled) {
			button.buttonEl.addClass('disabled');
		} else {
			button.buttonEl.removeClass('disabled');
		}
	}

	/**
	 * Check if a button is currently disabled
	 */
	isButtonDisabled(buttonKey: string): boolean {
		const button = this.buttons.get(buttonKey);
		if (!button) return false;
		return button.buttonEl.disabled;
	}

	/**
	 * Set multiple buttons' disabled states at once
	 */
	setButtonsDisabled(buttonStates: Record<string, boolean>): void {
		for (const [buttonKey, isDisabled] of Object.entries(buttonStates)) {
			this.setButtonDisabled(buttonKey, isDisabled);
		}
	}

	/**
	 * Update button states based on current file and SVN status
	 */
	async updateButtonStates(currentFile: TFile | null): Promise<void> {
		if (!currentFile) {
			// No file selected - disable file-specific buttons, keep refresh/settings enabled
			this.setButtonsDisabled({
				'add': true,
				'commit': true,
				'revert': true,
				'diff': true,
				'info': true,
				'remove': true,
				'refresh': false,  // Always enabled
				'settings': false  // Always enabled
			});
			return;
		}

		try {
			// Check if file is in working copy (repository exists)
			const isWorkingCopy = await this.svnClient.isWorkingCopy(currentFile.path);
			if (!isWorkingCopy) {
				// Not in SVN working copy - disable all SVN operations, keep refresh/settings enabled
				this.setButtonsDisabled({
					'add': true,
					'commit': true,
					'revert': true,
					'diff': true,
					'info': true,
					'remove': true,
					'refresh': false,  // Always enabled
					'settings': false  // Always enabled
				});
				return;
			}

			// Check if file is tracked by SVN
			const isFileInSvn = await this.svnClient.isFileInSvn(currentFile.path);
			
			if (isFileInSvn) {
				// File is already tracked - disable add, enable others
				this.setButtonsDisabled({
					'add': true,      // Can't add already tracked file
					'commit': false,  // Can commit changes
					'revert': false,  // Can revert changes
					'diff': false,    // Can show diff
					'info': false,    // Can show info
					'remove': false,  // Can remove from SVN
					'refresh': false, // Always enabled
					'settings': false // Always enabled
				});
			} else {
				// File is not tracked - enable add, disable others
				this.setButtonsDisabled({
					'add': false,     // Can add untracked file
					'commit': true,   // Can't commit untracked file
					'revert': true,   // Can't revert untracked file
					'diff': true,     // Can't show diff for untracked file
					'info': true,     // Can't show info for untracked file
					'remove': true,   // Can't remove untracked file
					'refresh': false, // Always enabled
					'settings': false // Always enabled
				});
			}
		} catch (error) {
			// Error checking status - disable operations as safety measure, keep refresh/settings enabled
			this.setButtonsDisabled({
				'add': true,
				'commit': true,
				'revert': true,
				'diff': true,
				'info': true,
				'remove': true,
				'refresh': false,  // Always enabled
				'settings': false  // Always enabled
			});
		}
	}

	/**
	 * Refresh button states for the current file
	 */
	async refreshButtonStates(currentFile: TFile | null): Promise<void> {
		await this.updateButtonStates(currentFile);
	}
}





