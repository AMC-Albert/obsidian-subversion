import { App, Modal } from "obsidian";
import { SvnStatus } from "../SVNClient";

export class StatusModal extends Modal {
    private fileName: string;
    private status: SvnStatus[];

    constructor(app: App, fileName: string, status: SvnStatus[]) {
        super(app);
        this.fileName = fileName;
        this.status = status;
    }

    onOpen() {
        const { contentEl, modalEl } = this;
        contentEl.empty();
        modalEl.addClass('mod-svn-status');
        
        const modalHeader = modalEl.querySelector('.modal-header');
        if (modalHeader) {
            modalHeader.createDiv('modal-title', el => {
                el.textContent = `Status for ${this.fileName}`;
            });
        }

        if (this.status.length === 0) {
            contentEl.createEl('p', { 
                text: 'File is up to date with no local modifications',
                cls: 'svn-info-text'
            });
        } else {
            const statusContainer = contentEl.createDiv('svn-status-container');
            
            this.status.forEach(item => {
                const statusEl = statusContainer.createDiv('svn-status-item');
                
                const statusCode = statusEl.createEl('span', { 
                    text: item.status,
                    cls: `svn-status-code svn-status-${item.status === '?' ? 'unknown' : item.status.toLowerCase()}`
                });
                
                statusEl.createEl('span', { 
                    text: item.filePath,
                    cls: 'svn-status-path'
                });
            });
        }
    }
}
