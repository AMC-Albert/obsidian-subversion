import { ButtonComponent, TFile, Notice } from 'obsidian';
import { SVNClient } from '../../services/SVNClient';
import type ObsidianSvnPlugin from '../../main';
import { SVNFileActions } from './SVNFileActions';
import { logger, logInfo } from '../../utils/logger';

export class SVNToolbar {
	private plugin: ObsidianSvnPlugin;
	private svnClient: SVNClient;
	private fileActions: SVNFileActions;
	private onRefresh: () => void;
	private onShowRepoSetup: () => void;
	private containerEl: HTMLElement | null = null;

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
		const toolbarEl = container.createEl('div', { cls: 'nav-buttons-container' });

		new ButtonComponent(toolbarEl)
			.setIcon('plus')
			.setTooltip('Add file to version control')
			.setClass('clickable-icon')
			.onClick(() => this.fileActions.addFile(currentFile));

		new ButtonComponent(toolbarEl)
			.setIcon('check')
			.setTooltip('Commit file')
			.setClass('clickable-icon')
			.onClick(() => this.fileActions.quickCommit(currentFile));

		new ButtonComponent(toolbarEl)
			.setIcon('undo')
			.setTooltip('Revert file')
			.setClass('clickable-icon')
			.onClick(() => this.fileActions.revertFile(currentFile));

		new ButtonComponent(toolbarEl)
			.setIcon('file-diff')
			.setTooltip('Show diff')
			.setClass('clickable-icon')
			.onClick(() => this.fileActions.showCurrentDiff(currentFile));

		new ButtonComponent(toolbarEl)
			.setIcon('info')
			.setTooltip('Show file info')
			.setClass('clickable-icon')
			.onClick(() => this.fileActions.toggleInfoDisplay());

		new ButtonComponent(toolbarEl)
			.setIcon('trash')
			.setTooltip('Remove file from version control')
			.setClass('clickable-icon')
			.onClick(() => this.fileActions.removeFromSvn(currentFile));

		new ButtonComponent(toolbarEl)
			.setIcon('refresh-cw')
			.setTooltip('Refresh history')
			.setClass('clickable-icon')
			.onClick(() => this.onRefresh());

		new ButtonComponent(toolbarEl)
			.setIcon('settings')
			.setTooltip('Repository setup')
			.setClass('clickable-icon')
			.onClick(() => this.onShowRepoSetup());
	}

	/**
	 * Enable or disable the toolbar
	 */
	setEnabled(enabled: boolean): void {
		logInfo('SVNToolbar', `Setting toolbar enabled: ${enabled}`);
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
}
