import { App, Modal, ButtonComponent } from "obsidian";

export class ConflictResolutionModal extends Modal {
	private fileName: string;
	private onResolve: (resolution: 'working' | 'theirs') => void;
	private onCancel?: () => void;

	constructor(app: App, fileName: string, onResolve: (resolution: 'working' | 'theirs') => void, onCancel?: () => void) {
		super(app);
		this.fileName = fileName;
		this.onResolve = onResolve;
		this.onCancel = onCancel;
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		
		this.titleEl.setText('Resolve SVN Conflicts');
				contentEl.createEl("p", { 
			text: `File "${this.fileName}" has conflicts that need to be resolved.`
		});
		
		contentEl.createEl("p", { 
			text: "Choose how to resolve the conflicts:"
		});
		
		const workingCopyChoice = contentEl.createDiv('conflict-choice');
		const workingCopyContent = workingCopyChoice.createDiv();
		workingCopyContent.createEl("strong", { text: "Keep Working Copy Version:" });
		workingCopyContent.createEl("p", { 
			text: "Preserve your local changes and discard the repository version."
		});
		
		new ButtonComponent(workingCopyChoice)
			.setButtonText('Keep Working Copy')
			.setCta()
			.onClick(() => {
				this.onResolve('working');
				this.close();
			});
		
		const repoChoice = contentEl.createDiv('conflict-choice');
		const repoContent = repoChoice.createDiv();
		repoContent.createEl("strong", { text: "Accept Repository Version:" });
		repoContent.createEl("p", { 
			text: "Use the repository version and discard your local changes."
		});
		
		new ButtonComponent(repoChoice)
			.setButtonText('Accept Repository')
			.setWarning()
			.onClick(() => {
				this.onResolve('theirs');
				this.close();
			});
		
		const buttonContainer = contentEl.createDiv('modal-button-container');
		new ButtonComponent(buttonContainer)
			.setButtonText('Cancel')
			.onClick(() => {
				this.onCancel?.();
				this.close();
			});
	}
}
