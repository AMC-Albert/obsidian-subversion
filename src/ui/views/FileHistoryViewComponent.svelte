<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { TFile, Notice, Modal, ButtonComponent, setIcon } from 'obsidian';
    import type ObsidianSvnPlugin from '../../main';
    import type { SvnLogEntry } from '../../types';
    import { CommitModal, ConfirmRevertModal, ConfirmRemoveModal, DiffModal, BlameModal } from '../modals';
    import type { FileHistoryView } from './FileHistoryView';

    interface Props {
        plugin: ObsidianSvnPlugin;
        view: FileHistoryView;
    }

    let { plugin, view }: Props = $props();
    let loading: boolean = $state(false);
    let currentFile: TFile | null = $state(null);
    let logEntries: SvnLogEntry[] = $state([]);
    let fileStatus: string = $state('');
    let statusClass: string = $state('');
    let buttons: HTMLElement[] = $state([]);
    let infoVisible: boolean = $state(false);
    let fileInfo: any = $state(null);

    // Watch for active file changes
    let fileChangeRef: any;

    onMount(() => {
        // Listen for active file changes
        fileChangeRef = view.app.workspace.on('active-leaf-change', () => {
            updateCurrentFile();
        });
        
        // Initial update
        updateCurrentFile();
    });

    onDestroy(() => {
        if (fileChangeRef) {
            view.app.workspace.offref(fileChangeRef);
        }
    });

    // Set icons after buttons are rendered
    $effect(() => {
        buttons.forEach((btn) => {
            if (btn && btn.dataset.icon) {
                setIcon(btn, btn.dataset.icon);
            }
        });
    });

    async function updateCurrentFile() {
        const activeFile = view.app.workspace.getActiveFile();
        if (activeFile !== currentFile) {
            currentFile = activeFile;
            await refreshContent();
        }
    }

    async function refreshContent() {
        if (!currentFile || !isSvnClientReady()) {
            logEntries = [];
            fileStatus = '';
            statusClass = '';
            fileInfo = null;
            return;
        }

        loading = true;
        try {
            await Promise.all([
                updateFileStatus(),
                updateLogEntries(),
                updateFileInfo()
            ]);
        } catch (error) {
            console.error('Error refreshing SVN content:', error);
            new Notice('Error refreshing SVN data: ' + error.message);
        } finally {
            loading = false;
        }
    }

    async function updateFileStatus() {
        if (!currentFile || !isSvnClientReady()) return;

        try {
            const isWorkingCopy = await plugin.svnClient.isWorkingCopy(currentFile.path);
            if (!isWorkingCopy) {
                fileStatus = 'Not in SVN working copy';
                statusClass = 'svn-status-warning';
                return;
            }

            const statusArray = await plugin.svnClient.getStatus(currentFile.path);
            if (!statusArray || statusArray.length === 0) {
                fileStatus = 'Up to date';
                statusClass = 'svn-status-clean';
            } else {
                const fileStatusItem = statusArray.find(item => 
                    item.filePath.includes(currentFile!.name) || 
                    item.filePath.endsWith(currentFile!.path)
                );
                
                if (!fileStatusItem) {
                    fileStatus = 'Up to date';
                    statusClass = 'svn-status-clean';
                } else {
                    fileStatus = fileStatusItem.status || 'Unknown';
                    statusClass = getStatusClass(fileStatusItem.status);
                }
            }
        } catch (error) {
            fileStatus = 'Error getting status';
            statusClass = 'svn-status-error';
        }
    }

    async function updateLogEntries() {
        if (!currentFile || !isSvnClientReady()) return;

        try {
            const isWorkingCopy = await plugin.svnClient.isWorkingCopy(currentFile.path);
            if (!isWorkingCopy) {
                logEntries = [];
                return;
            }

            logEntries = await plugin.svnClient.getLog(currentFile.path, 50);
        } catch (error) {
            console.error('Error getting log entries:', error);
            logEntries = [];
        }
    }

    async function updateFileInfo() {
        if (!currentFile || !isSvnClientReady()) return;

        try {
            const isWorkingCopy = await plugin.svnClient.isWorkingCopy(currentFile.path);
            if (!isWorkingCopy) {
                fileInfo = null;
                return;
            }

            fileInfo = await plugin.svnClient.getInfo(currentFile.path);
        } catch (error) {
            console.error('Error getting file info:', error);
            fileInfo = null;
        }
    }

    function isSvnClientReady(): boolean {
        return plugin.svnClient && plugin.svnClient.isConfigured();
    }

    function getStatusClass(status: string): string {
        const statusLower = status?.toLowerCase() || '';
        if (statusLower.includes('modified') || statusLower.includes('m')) return 'svn-status-modified';
        if (statusLower.includes('added') || statusLower.includes('a')) return 'svn-status-added';
        if (statusLower.includes('deleted') || statusLower.includes('d')) return 'svn-status-deleted';
        if (statusLower.includes('conflict') || statusLower.includes('c')) return 'svn-status-conflict';
        if (statusLower.includes('untracked') || statusLower.includes('?')) return 'svn-status-untracked';
        return 'svn-status-clean';
    }

    function formatDate(dateStr: string): string {
        try {
            const date = new Date(dateStr);
            return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
        } catch {
            return dateStr;
        }
    }

    async function showCommitModal() {
        if (!currentFile) return;
        const modal = new CommitModal(view.app, plugin.svnClient, [currentFile.path]);
        modal.onSubmit = () => refreshContent();
        modal.open();
    }

    async function showDiffModal(entry?: SvnLogEntry) {
        if (!currentFile) return;
        const modal = new DiffModal(view.app, plugin.svnClient, currentFile.path, entry?.revision);
        modal.open();
    }

    async function showBlameModal() {
        if (!currentFile) return;
        const modal = new BlameModal(view.app, plugin.svnClient, currentFile.path);
        modal.open();
    }

    async function showInfoModal() {
        infoVisible = !infoVisible;
    }

    async function revertToRevision(revision: string) {
        if (!currentFile) return;
        const modal = new ConfirmRevertModal(view.app, currentFile.path, revision);
        modal.onConfirm = async () => {
            try {
                await plugin.svnClient.revert(currentFile!.path, revision);
                new Notice(`Reverted ${currentFile!.name} to revision ${revision}`);
                await refreshContent();
            } catch (error) {
                new Notice('Error reverting file: ' + error.message);
            }
        };
        modal.open();
    }

    async function updateToRevision(revision: string) {
        if (!currentFile) return;
        try {
            await plugin.svnClient.update(currentFile.path, revision);
            new Notice(`Updated ${currentFile.name} to revision ${revision}`);
            await refreshContent();
        } catch (error) {
            new Notice('Error updating file: ' + error.message);
        }
    }

    async function refreshAll() {
        await refreshContent();
    }
</script>

<main class="svn-view">
    {#if !currentFile}
        <div class="svn-no-file">
            <div class="svn-placeholder">
                <span class="svn-placeholder-icon">📄</span>
                <h3>No file selected</h3>
                <p>Open a file to see its SVN history</p>
            </div>
        </div>
    {:else}
        <!-- Toolbar -->
        <div class="svn-toolbar">
            <div class="svn-toolbar-left">
                <h3 class="svn-file-title">{currentFile.name}</h3>
                <div class="svn-status {statusClass}">
                    {fileStatus}
                </div>
            </div>
            <div class="svn-toolbar-right">
                <button
                    bind:this={buttons[0]}
                    data-icon="git-commit"
                    aria-label="Commit"
                    class="clickable-icon svn-toolbar-button"
                    onclick={showCommitModal}
                    disabled={!isSvnClientReady()}
                ></button>
                <button
                    bind:this={buttons[1]}
                    data-icon="diff"
                    aria-label="Show Diff"
                    class="clickable-icon svn-toolbar-button"
                    onclick={() => showDiffModal()}
                    disabled={!isSvnClientReady()}
                ></button>
                <button
                    bind:this={buttons[2]}
                    data-icon="user"
                    aria-label="Show Blame"
                    class="clickable-icon svn-toolbar-button"
                    onclick={showBlameModal}
                    disabled={!isSvnClientReady()}
                ></button>
                <button
                    bind:this={buttons[3]}
                    data-icon="info"
                    aria-label="File Info"
                    class="clickable-icon svn-toolbar-button"
                    onclick={showInfoModal}
                    disabled={!isSvnClientReady()}
                ></button>
                <button
                    bind:this={buttons[4]}
                    data-icon="refresh-cw"
                    aria-label="Refresh"
                    class="clickable-icon svn-toolbar-button"
                    class:loading
                    onclick={refreshAll}
                ></button>
            </div>
        </div>

        <!-- Info Panel -->
        {#if infoVisible && fileInfo}
            <div class="svn-info-panel">
                <div class="svn-info-header">
                    <span class="svn-info-title">File Information</span>
                    <button 
                        class="clickable-icon svn-close-btn"
                        onclick={() => infoVisible = false}
                        aria-label="Close"
                    >×</button>
                </div>
                <div class="svn-info-content">
                    {#if fileInfo.url}
                        <div class="svn-info-row">
                            <span class="svn-info-label">URL:</span>
                            <span class="svn-info-value">{fileInfo.url}</span>
                        </div>
                    {/if}
                    {#if fileInfo.revision}
                        <div class="svn-info-row">
                            <span class="svn-info-label">Revision:</span>
                            <span class="svn-info-value">{fileInfo.revision}</span>
                        </div>
                    {/if}
                    {#if fileInfo.lastChangedAuthor}
                        <div class="svn-info-row">
                            <span class="svn-info-label">Last Author:</span>
                            <span class="svn-info-value">{fileInfo.lastChangedAuthor}</span>
                        </div>
                    {/if}
                    {#if fileInfo.lastChangedDate}
                        <div class="svn-info-row">
                            <span class="svn-info-label">Last Changed:</span>
                            <span class="svn-info-value">{formatDate(fileInfo.lastChangedDate)}</span>
                        </div>
                    {/if}
                </div>
            </div>
        {/if}

        <!-- Content Area -->
        <div class="svn-content">
            {#if loading}
                <div class="svn-loading">
                    <div class="svn-loading-spinner"></div>
                    <span>Loading SVN history...</span>
                </div>
            {:else if !isSvnClientReady()}
                <div class="svn-error">
                    <span class="svn-error-icon">⚠️</span>
                    <h3>SVN Not Configured</h3>
                    <p>Please configure SVN settings in the plugin options.</p>
                </div>
            {:else if logEntries.length === 0}
                <div class="svn-empty">
                    <span class="svn-empty-icon">📝</span>
                    <h3>No History Available</h3>
                    <p>This file has no SVN history or is not in a working copy.</p>
                </div>
            {:else}
                <div class="svn-history-list">
                    {#each logEntries as entry}
                        <div class="svn-history-entry">
                            <div class="svn-entry-header">
                                <div class="svn-entry-left">
                                    <span class="svn-revision">r{entry.revision}</span>
                                    <span class="svn-author">{entry.author}</span>
                                    <span class="svn-date">{formatDate(entry.date)}</span>
                                </div>
                                <div class="svn-entry-actions">
                                    <button
                                        class="clickable-icon svn-action-btn"
                                        onclick={() => showDiffModal(entry)}
                                        aria-label="Show diff for this revision"
                                        title="Show diff"
                                    >📄</button>
                                    <button
                                        class="clickable-icon svn-action-btn"
                                        onclick={() => revertToRevision(entry.revision)}
                                        aria-label="Revert to this revision"
                                        title="Revert to revision"
                                    >↶</button>
                                    <button
                                        class="clickable-icon svn-action-btn"
                                        onclick={() => updateToRevision(entry.revision)}
                                        aria-label="Update to this revision"
                                        title="Update to revision"
                                    >⬇</button>
                                </div>
                            </div>
                            {#if entry.message}
                                <div class="svn-entry-message">
                                    {entry.message}
                                </div>
                            {/if}
                        </div>
                    {/each}
                </div>
            {/if}
        </div>
    {/if}
</main>

<style>
    .svn-view {
        height: 100%;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .svn-no-file {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 2rem;
    }

    .svn-placeholder {
        text-align: center;
        color: var(--text-muted);
    }

    .svn-placeholder-icon {
        font-size: 3rem;
        display: block;
        margin-bottom: 1rem;
    }

    .svn-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.5rem 1rem;
        border-bottom: 1px solid var(--background-modifier-border);
        background: var(--background-secondary);
        flex-shrink: 0;
    }

    .svn-toolbar-left {
        display: flex;
        align-items: center;
        gap: 1rem;
    }

    .svn-file-title {
        margin: 0;
        font-size: 1rem;
        font-weight: 600;
    }

    .svn-status {
        font-size: 0.85rem;
        padding: 0.25rem 0.5rem;
        border-radius: 4px;
        font-weight: 500;
    }

    .svn-status-clean { 
        background: var(--color-green-rgb);
        color: white;
    }
    .svn-status-modified { 
        background: var(--color-orange-rgb);
        color: white;
    }
    .svn-status-added { 
        background: var(--color-blue-rgb);
        color: white;
    }
    .svn-status-deleted { 
        background: var(--color-red-rgb);
        color: white;
    }
    .svn-status-conflict { 
        background: var(--color-red-rgb);
        color: white;
    }
    .svn-status-untracked { 
        background: var(--text-muted);
        color: white;
    }
    .svn-status-warning { 
        background: var(--color-yellow-rgb);
        color: var(--text-normal);
    }
    .svn-status-error { 
        background: var(--color-red-rgb);
        color: white;
    }

    .svn-toolbar-right {
        display: flex;
        gap: 0.25rem;
    }

    .svn-toolbar-button {
        padding: 0.5rem;
        border: none;
        background: transparent;
        border-radius: 4px;
        cursor: pointer;
        transition: background-color 0.2s;
    }

    .svn-toolbar-button:hover {
        background: var(--background-modifier-hover);
    }

    .svn-toolbar-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .svn-toolbar-button.loading {
        animation: spin 1s linear infinite;
    }

    .svn-info-panel {
        background: var(--background-secondary);
        border-bottom: 1px solid var(--background-modifier-border);
        flex-shrink: 0;
    }

    .svn-info-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0.75rem 1rem;
        border-bottom: 1px solid var(--background-modifier-border);
    }

    .svn-info-title {
        font-weight: 600;
    }

    .svn-close-btn {
        background: none;
        border: none;
        font-size: 1.2rem;
        cursor: pointer;
        padding: 0.25rem;
        border-radius: 4px;
    }

    .svn-close-btn:hover {
        background: var(--background-modifier-hover);
    }

    .svn-info-content {
        padding: 1rem;
    }

    .svn-info-row {
        display: flex;
        margin-bottom: 0.5rem;
    }

    .svn-info-label {
        font-weight: 600;
        min-width: 120px;
        color: var(--text-muted);
    }

    .svn-info-value {
        flex: 1;
        word-break: break-all;
    }

    .svn-content {
        flex: 1;
        overflow: auto;
        padding: 1rem;
    }

    .svn-loading,
    .svn-error,
    .svn-empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        height: 200px;
        color: var(--text-muted);
    }

    .svn-loading-spinner {
        width: 2rem;
        height: 2rem;
        border: 2px solid var(--background-modifier-border);
        border-top: 2px solid var(--text-accent);
        border-radius: 50%;
        animation: spin 1s linear infinite;
        margin-bottom: 1rem;
    }

    .svn-error-icon,
    .svn-empty-icon {
        font-size: 2rem;
        margin-bottom: 1rem;
    }

    .svn-history-list {
        display: flex;
        flex-direction: column;
        gap: 1rem;
    }

    .svn-history-entry {
        border: 1px solid var(--background-modifier-border);
        border-radius: 8px;
        padding: 1rem;
        background: var(--background-primary);
        transition: box-shadow 0.2s;
    }

    .svn-history-entry:hover {
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    }

    .svn-entry-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 0.5rem;
    }

    .svn-entry-left {
        display: flex;
        align-items: center;
        gap: 1rem;
        flex-wrap: wrap;
    }

    .svn-revision {
        font-weight: 600;
        color: var(--text-accent);
        background: var(--background-secondary);
        padding: 0.25rem 0.5rem;
        border-radius: 4px;
        font-size: 0.85rem;
    }

    .svn-author {
        font-weight: 500;
        color: var(--text-normal);
    }

    .svn-date {
        color: var(--text-muted);
        font-size: 0.85rem;
    }

    .svn-entry-actions {
        display: flex;
        gap: 0.25rem;
    }

    .svn-action-btn {
        padding: 0.5rem;
        border: none;
        background: transparent;
        border-radius: 4px;
        cursor: pointer;
        transition: background-color 0.2s;
        font-size: 0.9rem;
    }

    .svn-action-btn:hover {
        background: var(--background-modifier-hover);
    }

    .svn-entry-message {
        background: var(--background-secondary);
        padding: 0.75rem;
        border-radius: 4px;
        border-left: 3px solid var(--text-accent);
        font-size: 0.9rem;
        line-height: 1.4;
        white-space: pre-wrap;
        word-wrap: break-word;
    }

    @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
    }
</style>
