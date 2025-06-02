import { Modal, App, TFile } from 'obsidian';
import { SvnBlameEntry } from '../types';
import type ObsidianSvnPlugin from '../main';

export class BlameModal extends Modal {
    private plugin: ObsidianSvnPlugin;
    private file: TFile;
    private blameData: SvnBlameEntry[];
    private fileContent: string[];

    constructor(app: App, plugin: ObsidianSvnPlugin, file: TFile, blameData: SvnBlameEntry[], fileContent: string[]) {
        super(app);
        this.plugin = plugin;
        this.file = file;
        this.blameData = blameData;
        this.fileContent = fileContent;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: `Blame: ${this.file.name}` });

        const container = contentEl.createEl('div', { cls: 'svn-blame-container' });
        
        // Create header
        const headerEl = container.createEl('div', { cls: 'svn-blame-header' });
        headerEl.createEl('span', { text: 'Rev', cls: 'svn-blame-col-rev' });
        headerEl.createEl('span', { text: 'Author', cls: 'svn-blame-col-author' });
        headerEl.createEl('span', { text: 'Line', cls: 'svn-blame-col-line' });
        headerEl.createEl('span', { text: 'Content', cls: 'svn-blame-col-content' });

        // Create blame content
        this.blameData.forEach((blame, index) => {
            const rowEl = container.createEl('div', { cls: 'svn-blame-row' });
            
            // Revision
            const revEl = rowEl.createEl('span', { 
                text: blame.revision, 
                cls: 'svn-blame-col-rev' 
            });
            revEl.title = blame.date;
            
            // Author
            rowEl.createEl('span', { 
                text: blame.author, 
                cls: 'svn-blame-col-author' 
            });
            
            // Line number
            rowEl.createEl('span', { 
                text: blame.lineNumber.toString(), 
                cls: 'svn-blame-col-line' 
            });
            
            // Content (if available)
            const contentText = this.fileContent[blame.lineNumber - 1] || '';
            const contentEl = rowEl.createEl('span', { 
                text: contentText.slice(0, 100) + (contentText.length > 100 ? '...' : ''),
                cls: 'svn-blame-col-content' 
            });
            contentEl.title = contentText;
        });

        // Close button
        const buttonContainer = contentEl.createEl('div', { cls: 'modal-button-container' });
        const closeButton = buttonContainer.createEl('button', { text: 'Close' });
        closeButton.onclick = () => this.close();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
