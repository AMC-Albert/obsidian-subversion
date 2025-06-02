import { App, Modal, Setting } from "obsidian";

export class CheckoutModal extends Modal {
    private onCheckout: (url: string) => void;
    private title: string;

    constructor(app: App, title: string, onCheckout: (url: string) => void) {
        super(app);
        this.title = title;
        this.onCheckout = onCheckout;
    }

    onOpen() {
        const { contentEl, modalEl } = this;
        contentEl.empty();
        modalEl.addClass('mod-svn-checkout');
        
        const modalHeader = modalEl.querySelector('.modal-header');
        if (modalHeader) {
            modalHeader.createDiv('modal-title', el => {
                el.textContent = this.title;
            });
        }

        let repositoryUrl = '';

        contentEl.createEl("p", { text: "Enter the SVN repository URL to checkout:" });
        
        const inputContainer = contentEl.createDiv('svn-modal-input');
        const input = inputContainer.createEl('input', {
            type: 'text',
            placeholder: 'https://example.com/svn/repo or file:///path/to/repo',
            cls: 'svn-modal-input'
        });
        
        const buttonRow = contentEl.createDiv('modal-button-container');
        new Setting(buttonRow)
            .addButton(btn => btn
                .setButtonText('Checkout')
                .setClass('mod-cta')
                .onClick(() => {
                    const url = input.value.trim();
                    if (url) {
                        this.onCheckout(url);
                        this.close();
                    }
                })
            )
            .addButton(btn => btn
                .setButtonText('Cancel')
                .setClass('mod-cancel')
                .onClick(() => this.close())
            );

        input.addEventListener('input', (e) => {
            repositoryUrl = (e.target as HTMLInputElement).value;
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const url = input.value.trim();
                if (url) {
                    this.onCheckout(url);
                    this.close();
                }
            }
        });

        input.focus();
    }
}