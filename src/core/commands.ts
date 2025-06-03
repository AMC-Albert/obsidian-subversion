import { Notice } from 'obsidian';
import { CreateRepoModal } from '../modals';
import type ObsidianSvnPlugin from '../main';
import { logError } from 'src/utils/logger';

export function registerCommands(plugin: ObsidianSvnPlugin) {
	// Use the plugin's SVN client instance instead of creating a new one
	const svnClient = plugin.svnClient;

	// Register SVN commands with Obsidian's command palette
	plugin.addCommand({
		id: 'svn-show-file-history',
		name: 'Show file history',
		editorCallback: async (editor, view) => {
			try {
				const filePath = view.file?.path;
				if (!filePath) {
					new Notice('No file is currently open.');
					return;
				}
				
				// Check if this is an SVN working copy
				const isWorkingCopy = await svnClient.isWorkingCopy(filePath);
				if (!isWorkingCopy) {
					new Notice('This file is not in an SVN working copy.');
					return;
				}
				
				// Open the FileHistoryView
				await plugin.activateView();
			} catch (error) {
				logError('SVNCommands', 'SVN show history error:', error);
				new Notice(`Error: ${error.message}`);
			}
		}
	});

	plugin.addCommand({
		id: 'svn-revert-file',
		name: 'Revert file',
		editorCallback: async (editor, view) => {
			try {
				const filePath = view.file?.path;
				if (!filePath) {
					new Notice('No file is currently open.');
					return;
				}
				
				await svnClient.revertFile(filePath);
				new Notice('File reverted successfully.');
				
				// Reload the file in Obsidian
				if (view.file) {
					await plugin.app.vault.adapter.read(view.file.path)
						.then(content => {
							editor.setValue(content);
						});
				}
			} catch (error) {
				logError('SVNCommands', 'SVN revert error:', error);
				new Notice(`Error: ${error.message}`);
			}
		}
	});

	plugin.addCommand({
		id: 'svn-commit-file',
		name: 'Commit file',
		editorCallback: async (editor, view) => {
			try {
				const filePath = view.file?.path;
				if (!filePath) {
					new Notice('No file is currently open.');
					return;
				}
				
				const message = plugin.settings.commitMessage || 'Update from Obsidian';
				await svnClient.commitFile(filePath, message);
				new Notice('File committed successfully.');
				
				// Refresh file history views to show the new commit (with small delay)
				setTimeout(() => {
					plugin.refreshFileHistoryViews();
				}, 500);
			} catch (error) {
				logError('SVNCommands', 'SVN commit error:', error);
				new Notice(`Error: ${error.message}`);
			}
		}
	});

	plugin.addCommand({
		id: 'svn-commit-file-with-message',
		name: 'Commit file with custom message',
		editorCallback: async (editor, view) => {
			try {
				const filePath = view.file?.path;
				if (!filePath) {
					new Notice('No file is currently open.');
					return;
				}
				
				// Create a simple prompt for commit message
				const message = await promptForCommitMessage(plugin);
				if (!message) {
					new Notice('Commit cancelled.');
					return;
				}
				
				await svnClient.commitFile(filePath, message);
				new Notice('File committed successfully.');
				
				// Refresh file history views to show the new commit (with small delay)
				setTimeout(() => {
					plugin.refreshFileHistoryViews();
				}, 500);
			} catch (error) {
				logError('SVNCommands', 'SVN commit with message error:', error);
				new Notice(`Error: ${error.message}`);
			}
		}
	});

	plugin.addCommand({
		id: 'svn-show-status',
		name: 'Show SVN status',
		editorCallback: async (editor, view) => {
			try {
				const filePath = view.file?.path;
				if (!filePath) {
					new Notice('No file is currently open.');
					return;
				}
				
				const status = await svnClient.getStatus(filePath);
				if (status.length === 0) {
					new Notice('No changes detected.');
				} else {
					const statusText = status.map(s => `${s.status} ${s.filePath}`).join('\n');
					new Notice(`SVN Status:\n${statusText}`);
				}
			} catch (error) {
				logError('SVNCommands', 'SVN status error:', error);
				new Notice(`Error: ${error.message}`);
			}
		}
	});

	plugin.addCommand({
		id: 'svn-show-diff',
		name: 'Show file diff',
		editorCallback: async (editor, view) => {
			try {
				const filePath = view.file?.path;
				if (!filePath) {
					new Notice('No file is currently open.');
					return;
				}
				
				const diff = await svnClient.getDiff(filePath);
				if (!diff.trim()) {
					new Notice('No changes detected.');
					return;
				}
				
				// Create a modal to show the diff
				const diffModal = new (require('obsidian').Modal)(plugin.app);
				diffModal.onOpen = () => {
					const { contentEl } = diffModal;
					contentEl.createEl('h3', { text: `Diff for ${filePath}` });
					
					const pre = contentEl.createEl('pre', { cls: 'svn-diff-content' });
					pre.createEl('code', { text: diff });
				};
				diffModal.open();
			} catch (error) {
				logError('SVNCommands', 'SVN diff error:', error);
				new Notice(`Error: ${error.message}`);
			}
		}
	});

	plugin.addCommand({
		id: 'svn-add-file',
		name: 'Add file to SVN',
		editorCallback: async (editor, view) => {
			try {
				const filePath = view.file?.path;
				if (!filePath) {
					new Notice('No file is currently open.');
					return;
				}
				
				// Add file to SVN (this is handled internally by commitFile, but we can make it explicit)
				const { exec } = require('child_process');
				const { promisify } = require('util');
				const execPromise = promisify(exec);
				
				await execPromise(`${plugin.settings.svnBinaryPath} add "${filePath}"`);
				new Notice('File added to SVN');
			} catch (error) {
				logError('SVNCommands', 'SVN add file error:', error);
				new Notice(`Error: ${error.message}`);
			}
		}
	});

	plugin.addCommand({
		id: 'svn-create-repository',
		name: 'Create SVN repository',
		callback: async () => {
			try {
				// Get the default repository name from settings (strip any dots)
				const defaultRepoName = plugin.settings.repositoryName?.replace(/^\.+/, '') || '';
				
				const modal = new CreateRepoModal(
					plugin.app,
					plugin,
					defaultRepoName,
					async (cleanRepoName: string) => {
						try {
							await svnClient.createRepository(cleanRepoName);
							const hiddenRepoName = `.${cleanRepoName}`;
							new Notice(`SVN repository '${hiddenRepoName}' created successfully!`);
						} catch (error) {
							logError('SVNCommands', 'SVN create repository error:', error);
							new Notice(`Error creating repository: ${error.message}`);
						}
					},
					() => {
						new Notice('Repository creation cancelled.');
					}
				);
				modal.open();
			} catch (error) {
				logError('SVNCommands', 'SVN create repository modal error:', error);
				new Notice(`Error: ${error.message}`);
			}
		}
	});

	// Debug and logging commands
	plugin.addCommand({
		id: 'svn-dump-debug-logs',
		name: 'Dump debug logs to file',
		callback: async () => {
			try {
				const { logger } = require('../utils/logger');
				await logger.dumpLogsToFile();
				new Notice('Debug logs dumped to file successfully. Check .obsidian/plugins/obsidian-subversion/svn-debug.log');
			} catch (error) {
				logError('SVNCommands', 'Failed to dump debug logs:', error);
				new Notice(`Error dumping logs: ${error.message}`);
			}
		}
	});

	plugin.addCommand({
		id: 'svn-clear-debug-logs',
		name: 'Clear debug logs buffer',
		callback: async () => {
			try {
				const { logger } = require('../utils/logger');
				const stats = logger.getLogStats();
				logger.clearLogs();
				new Notice(`Cleared ${stats.total} log entries from memory buffer.`);
			} catch (error) {
				logError('SVNCommands', 'Failed to clear debug logs:', error);
				new Notice(`Error clearing logs: ${error.message}`);
			}
		}
	});

	plugin.addCommand({
		id: 'svn-show-log-stats',
		name: 'Show logging statistics',
		callback: async () => {
			try {
				const { logger } = require('../utils/logger');
				const stats = logger.getLogStats();
				const loggerInfo = logger.getLoggerInfo();
				const fileSize = await logger.getLogFileSize();
				
				const byLevelText = Object.entries(stats.byLevel)
					.map(([level, count]) => `${level}: ${count}`)
					.join(', ');
				
				const message = `Log Statistics:
• Total entries: ${stats.total}
• By level: ${byLevelText}
• Buffer size: ${loggerInfo.bufferSize}/${logger.maxBufferSize || 100}
• Log file: ${loggerInfo.logFilePath || 'Not set'}
• Log file size: ${(fileSize / 1024).toFixed(1)} KB`;
				
				new Notice(message, 8000);
			} catch (error) {
				logError('SVNCommands', 'Failed to get log stats:', error);
				new Notice(`Error getting log stats: ${error.message}`);
			}
		}
	});

	plugin.addCommand({
		id: 'svn-show-recent-logs',
		name: 'Show recent debug logs',
		callback: async () => {
			try {
				const { logger } = require('../utils/logger');
				const recentContent = await logger.getLogFileContent(30);
				
				// Create a modal to show recent logs
				const modal = new (require('obsidian').Modal)(plugin.app);
				modal.onOpen = () => {
					const { contentEl } = modal;
					contentEl.createEl('h3', { text: 'Recent Debug Logs (Last 30 lines)' });
					
					const pre = contentEl.createEl('pre', { 
						cls: 'svn-logs-content',
						attr: { style: 'max-height: 400px; overflow-y: auto; font-family: monospace; background: var(--background-secondary); padding: 10px; border-radius: 5px;' }
					});
					pre.createEl('code', { text: recentContent });
					
					const buttonContainer = contentEl.createEl('div', { 
						attr: { style: 'margin-top: 10px; text-align: right;' }
					});
					
					const refreshButton = buttonContainer.createEl('button', { text: 'Refresh' });
					refreshButton.addEventListener('click', async () => {
						const newContent = await logger.getLogFileContent(30);
						pre.empty();
						pre.createEl('code', { text: newContent });
					});
					
					const dumpButton = buttonContainer.createEl('button', { 
						text: 'Dump Current Logs',
						attr: { style: 'margin-left: 10px;' }
					});
					dumpButton.addEventListener('click', async () => {
						try {
							await logger.dumpLogsToFile();
							new Notice('Logs dumped successfully');
						} catch (error) {
							new Notice(`Error dumping logs: ${error.message}`);
						}
					});
				};
				modal.open();
			} catch (error) {
				logError('SVNCommands', 'Failed to show recent logs:', error);
				new Notice(`Error showing logs: ${error.message}`);
			}
		}
	});
}

async function promptForCommitMessage(plugin: ObsidianSvnPlugin): Promise<string | null> {
	return new Promise((resolve) => {
		const modal = new (require('obsidian').Modal)(plugin.app);
		let message = '';
		
		modal.onOpen = () => {
			const { contentEl } = modal;
			contentEl.createEl('h3', { text: 'Commit Message' });
			
			const textArea = contentEl.createEl('textarea', {
				placeholder: 'Enter your commit message...',
				value: plugin.settings.commitMessage
			});
			textArea.style.width = '100%';
			textArea.style.height = '100px';
			textArea.style.marginBottom = '10px';
			
			textArea.addEventListener('input', (e: Event) => {
				message = (e.target as HTMLTextAreaElement).value;
			});
			
			const buttonContainer = contentEl.createEl('div');
			buttonContainer.style.textAlign = 'right';
			
			const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
			cancelBtn.style.marginRight = '10px';
			cancelBtn.onclick = () => {
				modal.close();
				resolve(null);
			};
			
			const commitBtn = buttonContainer.createEl('button', { 
				text: 'Commit',
				cls: 'mod-cta'
			});
			commitBtn.onclick = () => {
				modal.close();
				resolve(message || plugin.settings.commitMessage);
			};
			
			textArea.focus();
		};
		
		modal.open();
	});
}
