import { ButtonComponent, TFile, Notice } from 'obsidian';
import { SVNClient } from '../../../services/SVNClient';
import type ObsidianSvnPlugin from '../../../main';
import { SVNFileActions } from './SVNFileActions';

export class SVNToolbar {
    private plugin: ObsidianSvnPlugin;
    private svnClient: SVNClient;
    private fileActions: SVNFileActions;
    private onRefresh: () => void;
    private onShowRepoSetup: () => void;

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
        const toolbarEl = container.createEl('div', { cls: 'nav-buttons-container' });

        new ButtonComponent(toolbarEl)
            .setIcon('check')
            .setTooltip('Commit file')
            .setClass('clickable-icon')
            .onClick(() => this.fileActions.quickCommit(currentFile));

        new ButtonComponent(toolbarEl)
            .setIcon('file-diff')
            .setTooltip('Show diff')
            .setClass('clickable-icon')
            .onClick(() => this.fileActions.showCurrentDiff(currentFile));

        new ButtonComponent(toolbarEl)
            .setIcon('eye')
            .setTooltip('Show blame/annotate')
            .setClass('clickable-icon')
            .onClick(() => this.fileActions.showBlame(currentFile));

        new ButtonComponent(toolbarEl)
            .setIcon('info')
            .setTooltip('Show file info')
            .setClass('clickable-icon')
            .onClick(() => this.fileActions.toggleInfoDisplay());

        new ButtonComponent(toolbarEl)
            .setIcon('undo')
            .setTooltip('Revert file')
            .setClass('clickable-icon')
            .onClick(() => this.fileActions.revertFile(currentFile));

        new ButtonComponent(toolbarEl)
            .setIcon('trash')
            .setTooltip('Remove file from version control')
            .setClass('clickable-icon')
            .onClick(() => this.fileActions.removeFromSvn(currentFile));        new ButtonComponent(toolbarEl)
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
}
