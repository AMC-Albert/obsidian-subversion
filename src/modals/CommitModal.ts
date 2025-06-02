import { App, Modal, Setting } from "obsidian";

export class CommitModal extends Modal {
    private onCommit: (message: string) => void;
    private defaultMessage: string;
    private title: string;

    constructor(app: App, title: string, defaultMessage: string, onCommit: (message: string) => void) {
        super(app);
        this.title = title;
        this.defaultMessage = defaultMessage;
        this.onCommit = onCommit;
    }

    onOpen() {
        const { contentEl, modalEl } = this;
        contentEl.empty();
        modalEl.addClass('mod-svn-commit');
        
        const modalHeader = modalEl.querySelector('.modal-header');
        if (modalHeader) {
            modalHeader.createDiv('modal-title', el => {
                el.textContent = this.title;
            });
        }

        let commitMessage = this.defaultMessage;

        contentEl.createEl("p", { text: "Enter a commit message:" });
        
        const inputContainer = contentEl.createDiv('svn-modal-input');
        const input = inputContainer.createEl('input', {
            type: 'text',
            placeholder: this.defaultMessage,
            cls: 'svn-modal-input'
        });
        input.value = this.defaultMessage;
        
        const buttonRow = contentEl.createDiv('modal-button-container');
        new Setting(buttonRow)
            .addButton(btn => btn
                .setButtonText('Commit')
                .setClass('mod-cta')
                .onClick(() => {
                    this.onCommit(input.value || this.defaultMessage);
                    this.close();
                })
            )
            .addButton(btn => btn
                .setButtonText('Cancel')
                .setClass('mod-cancel')
                .onClick(() => this.close())
            );

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                this.onCommit(input.value || this.defaultMessage);
                this.close();
            }
        });

        input.focus();
        input.select();
    }
}
