import { TFile } from 'obsidian';
import { SVNClient } from '../../../services/SVNClient';

export class SVNStatusDisplay {
    private svnClient: SVNClient;

    constructor(svnClient: SVNClient) {
        this.svnClient = svnClient;
    }

    async render(container: HTMLElement, currentFile: TFile | null): Promise<void> {
        container.empty();
        
        if (!currentFile || !this.isSvnClientReady()) {
            return;
        }

        const statusEl = container.createEl('div', { cls: 'svn-status-display' });
        await this.renderStatusContent(statusEl, currentFile);
    }    private async renderStatusContent(statusEl: HTMLElement, currentFile: TFile): Promise<void> {
        try {
            // Check if file is in working copy
            const isWorkingCopy = await this.svnClient.isWorkingCopy(currentFile.path);
            if (!isWorkingCopy) {
                statusEl.createEl('span', { 
                    text: 'Not in SVN working copy',
                    cls: 'svn-status-text svn-status-warning'
                });
                return;
            }            // Get file info to show current revision
            const svnInfo = await this.svnClient.getInfo(currentFile.path);
            
            // Create status container with revision info
            const statusContainer = statusEl.createEl('div', { cls: 'svn-status-container' });            // Show current revision if available
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
                console.log('SVNStatusDisplay: No revision info available. svnInfo:', svnInfo);
                console.log('SVNStatusDisplay: svnInfo type:', typeof svnInfo);
                console.log('SVNStatusDisplay: lastChangedRev:', svnInfo?.lastChangedRev);
            }

            // Get file status
            const statusArray = await this.svnClient.getStatus(currentFile.path);
            const statusTextEl = statusContainer.createEl('span', { cls: 'svn-status-text' });
            
            if (!statusArray || statusArray.length === 0) {
                statusTextEl.setText('Up to date');
                statusTextEl.addClass('svn-status-clean');
            } else {
                // Find status for current file
                const fileStatus = statusArray.find(item => 
                    item.filePath.includes(currentFile.name) || 
                    item.filePath.endsWith(currentFile.path)
                );
                
                if (!fileStatus) {
                    statusTextEl.setText('Up to date');
                    statusTextEl.addClass('svn-status-clean');
                } else {
                    const statusCode = fileStatus.status.charAt(0);
                    
                    switch (statusCode) {
                        case 'M':
                            statusTextEl.setText('Modified');
                            statusTextEl.addClass('svn-status-modified');
                            break;
                        case 'A':
                            statusTextEl.setText('Added');
                            statusTextEl.addClass('svn-status-added');
                            break;
                        case 'D':
                            statusTextEl.setText('Deleted');
                            statusTextEl.addClass('svn-status-deleted');
                            break;                        case '?':
                            statusTextEl.setText('Not tracked');
                            statusTextEl.addClass('svn-status-untracked');
                            break;
                        case 'C':
                            statusTextEl.setText('Conflicted');
                            statusTextEl.addClass('svn-status-error');
                            break;
                        default:
                            statusTextEl.setText('Up to date');
                            statusTextEl.addClass('svn-status-clean');
                    }
                }
            }
            
        } catch (error) {
            console.error('SVNStatusDisplay: Error in renderStatusContent:', error);
            statusEl.createEl('span', { 
                text: 'Error getting status',
                cls: 'svn-status-text svn-status-error'
            });
        }
    }

    private isSvnClientReady(): boolean {
        return this.svnClient && 
               typeof this.svnClient.setVaultPath === 'function';
    }
}
