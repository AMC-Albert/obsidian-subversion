import { App, FileSystemAdapter } from 'obsidian';
import * as path from 'path';
import * as fs from 'fs';

export interface LogEntry {
	timestamp: Date;
	level: LogLevel;
	component: string;
	message: string;
	data?: any;
}

export enum LogLevel {
	DEBUG = 0,
	INFO = 1,
	WARN = 2,
	ERROR = 3
}

export class SVNLogger {
	private static instance: SVNLogger;
	private logBuffer: LogEntry[] = [];
	private maxBufferSize = 100;
	private app: App | null = null;
	private currentLogLevel = LogLevel.DEBUG;	private logFilePath: string | null = null;
	private maxLogFileSize = 1024 * 1024; // 1MB
	private maxLogFiles = 5; // Keep 5 old log files
	private maxLogFileLines = 1000; // Maximum lines in log file
	private autoDumpOnError = true; // Auto-dump logs when error occurs
	private autoDumpInterval: number | null = null; // Auto-dump timer
	private errorsSinceLastDump = 0;
	private maxErrorsBeforeDump = 5; // Dump after 5 errors

	private constructor() {}
	public static getInstance(): SVNLogger {
		if (!SVNLogger.instance) {
			SVNLogger.instance = new SVNLogger();
		}
		return SVNLogger.instance;
	}
	public initialize(app: App, logLevel: LogLevel = LogLevel.DEBUG): void {
		this.app = app;
		this.currentLogLevel = logLevel;
		// Log file path will be set later via setVaultPath method
		console.log('SVN Logger: Initialized');
	}

	public setLogLevel(level: LogLevel): void {
		this.currentLogLevel = level;
	}

	/**
	 * Set the vault path for log file location (similar to SVNClient.setVaultPath)
	 */
	public setVaultPath(vaultPath: string): void {
		try {
			this.logFilePath = path.join(vaultPath, '.obsidian', 'plugins', 'obsidian-subversion', 'svn-debug.log');
			console.log('SVN Logger: Updated log path:', this.logFilePath);
		} catch (error) {
			console.error('SVN Logger: Failed to set vault path:', error);
			this.logFilePath = 'svn-debug.log'; // Fallback
		}
	}

	public debug(component: string, message: string, data?: any): void {
		this.log(LogLevel.DEBUG, component, message, data);
	}

	public info(component: string, message: string, data?: any): void {
		this.log(LogLevel.INFO, component, message, data);
	}

	public warn(component: string, message: string, data?: any): void {
		this.log(LogLevel.WARN, component, message, data);
	}

	public error(component: string, message: string, data?: any): void {
		this.log(LogLevel.ERROR, component, message, data);
		this.errorsSinceLastDump++;
		
		// Auto-dump logs on error if enabled
		if (this.autoDumpOnError && this.errorsSinceLastDump >= this.maxErrorsBeforeDump) {
			this.dumpLogsToFile().catch(err => {
				console.error('Failed to auto-dump logs on error:', err);
			});
			this.errorsSinceLastDump = 0;
		}
	}

	private log(level: LogLevel, component: string, message: string, data?: any): void {
		if (level < this.currentLogLevel) {
			return;
		}

		const entry: LogEntry = {
			timestamp: new Date(),
			level,
			component,
			message,
			data
		};

		// Add to buffer
		this.logBuffer.push(entry);

		// Maintain buffer size
		if (this.logBuffer.length > this.maxBufferSize) {
			this.logBuffer.shift();
		}

		// Also log to console for development (can be disabled in production)
		if (console && console.log) {
			const levelName = LogLevel[level];
			const timestamp = entry.timestamp.toISOString().substr(11, 12); // Time only
			const dataStr = data ? JSON.stringify(data) : '';
			console.log(`${timestamp} [${levelName}] [${component}] ${message}${dataStr ? ' ' + dataStr : ''}`);
		}
	}

	public getRecentLogs(count: number = this.maxBufferSize): LogEntry[] {
		return this.logBuffer.slice(-count);
	}

	public clearLogs(): void {
		this.logBuffer = [];
	}	public async dumpLogsToFile(): Promise<void> {
		if (!this.logFilePath) {
			this.error('Logger', 'Cannot dump logs: logFilePath not initialized');
			return;
		}

		try {
			// Check if log rotation is needed
			await this.rotateLogsIfNeeded();

			const logs = this.getRecentLogs();
			const logContent = this.formatLogsForFile(logs);
			
			// Create directory if it doesn't exist
			const logDir = path.dirname(this.logFilePath);
			if (!fs.existsSync(logDir)) {
				fs.mkdirSync(logDir, { recursive: true });
			}
            // Append to existing log file or create new one
			let existingContent = '';
			try {
				existingContent = fs.readFileSync(this.logFilePath, 'utf8');
			} catch (error) {
				// File doesn't exist yet, that's fine
			}
			
			const finalContent = existingContent + logContent;
			
			// Limit the number of lines in the log file
			const limitedContent = this.limitLogFileLines(finalContent);
			
			fs.writeFileSync(this.logFilePath, limitedContent, 'utf8');
			
			// Reset error counter after successful dump
			this.errorsSinceLastDump = 0;
			
			this.info('Logger', `Successfully dumped ${logs.length} log entries to ${this.logFilePath}`);
		} catch (error) {
			this.log(LogLevel.ERROR, 'Logger', 'Failed to dump logs to file', { error: error.message });
		}
	}

	/**
	 * Limit the log file to the maximum number of lines
	 */
	private limitLogFileLines(content: string): string {
		const lines = content.split('\n');
		if (lines.length <= this.maxLogFileLines) {
			return content;
		}
		
		// Keep only the most recent lines
		const keptLines = lines.slice(-this.maxLogFileLines);
		return keptLines.join('\n');
	}

	private formatLogsForFile(logs: LogEntry[]): string {
		const header = `SVN Plugin Debug Log\nGenerated: ${new Date().toISOString()}\n${'='.repeat(80)}\n\n`;
		const logLines = logs.map(entry => {
			const timestamp = entry.timestamp.toISOString();
			const level = LogLevel[entry.level].padEnd(5);
			const component = entry.component.padEnd(20);
			const dataStr = entry.data ? '\n    Data: ' + JSON.stringify(entry.data, null, 2)?.replace(/\n/g, '\n    ') : '';
			
			return `${timestamp} [${level}] [${component}] ${entry.message}${dataStr}`;
		});

		return header + logLines.join('\n') + '\n';
	}
	public async rotateLogsIfNeeded(): Promise<void> {
		if (!this.logFilePath) {
			return;
		}

		try {
			// Check if log file exists and its size
			if (!fs.existsSync(this.logFilePath)) {
				return; // File doesn't exist, no rotation needed
			}

			const stats = fs.statSync(this.logFilePath);
			const fileSize = stats.size;

			// If file is too large, rotate it
			if (fileSize > this.maxLogFileSize) {
				await this.rotateLogFiles();
			}
		} catch (error) {
			this.error('Logger', 'Failed to check/rotate log files', { error: error.message });
		}
	}
	private async rotateLogFiles(): Promise<void> {
		if (!this.logFilePath) {
			return;
		}

		try {
			const baseLogPath = this.logFilePath.replace('.log', '');

			// Rotate existing log files (move .1 to .2, .2 to .3, etc.)
			for (let i = this.maxLogFiles - 1; i >= 1; i--) {
				const oldPath = `${baseLogPath}.${i}.log`;
				const newPath = `${baseLogPath}.${i + 1}.log`;
				
				if (fs.existsSync(oldPath)) {
					fs.renameSync(oldPath, newPath);
				}
			}

			// Move current log to .1
			if (fs.existsSync(this.logFilePath)) {
				const rotatedPath = `${baseLogPath}.1.log`;
				fs.renameSync(this.logFilePath, rotatedPath);
			}

			// Clean up old log files beyond maxLogFiles
			for (let i = this.maxLogFiles + 1; i <= this.maxLogFiles + 2; i++) {
				const oldPath = `${baseLogPath}.${i}.log`;
				if (fs.existsSync(oldPath)) {
					fs.unlinkSync(oldPath);
				}
			}

			this.info('Logger', 'Log files rotated successfully');
		} catch (error) {
			this.error('Logger', 'Failed to rotate log files', { error: error.message });
		}
	}

	public setMaxBufferSize(size: number): void {
		this.maxBufferSize = size;
		// Trim buffer if it's now too large
		if (this.logBuffer.length > this.maxBufferSize) {
			this.logBuffer = this.logBuffer.slice(-this.maxBufferSize);
		}
	}

	public setMaxLogFileSize(size: number): void {
		this.maxLogFileSize = size;
	}

	public setMaxLogFiles(count: number): void {
		this.maxLogFiles = count;
	}

	public setMaxLogFileLines(lines: number): void {
		this.maxLogFileLines = lines;
	}

	public getLogStats(): { total: number; byLevel: Record<string, number> } {
		const byLevel: Record<string, number> = {};
		
		for (const entry of this.logBuffer) {
			const levelName = LogLevel[entry.level];
			byLevel[levelName] = (byLevel[levelName] || 0) + 1;
		}

		return {
			total: this.logBuffer.length,
			byLevel
		};
	}

	public setAutoDumpOnError(enabled: boolean): void {
		this.autoDumpOnError = enabled;
	}

	public setMaxErrorsBeforeDump(count: number): void {
		this.maxErrorsBeforeDump = count;
	}

	public startAutoDump(intervalMinutes: number = 30): void {
		this.stopAutoDump(); // Clear any existing timer
		
		const intervalMs = intervalMinutes * 60 * 1000;
		this.autoDumpInterval = window.setInterval(async () => {
			try {
				await this.dumpLogsToFile();
			} catch (error) {
				console.error('Auto-dump failed:', error);
			}
		}, intervalMs);
		
		this.info('Logger', `Started auto-dump every ${intervalMinutes} minutes`);
	}

	public stopAutoDump(): void {
		if (this.autoDumpInterval) {
			clearInterval(this.autoDumpInterval);
			this.autoDumpInterval = null;
			this.info('Logger', 'Stopped auto-dump');
		}
	}

	public getLoggerInfo(): { logFilePath: string | null; bufferSize: number; stats: any } {
		return {
			logFilePath: this.logFilePath,
			bufferSize: this.logBuffer.length,
			stats: this.getLogStats()
		};
	}

	public async getLogFileSize(): Promise<number> {
		if (!this.app || !this.logFilePath) {
			return 0;
		}

		try {
			const adapter = this.app.vault.adapter;
			const content = await adapter.read(this.logFilePath);
			return new Blob([content]).size;
		} catch (error) {
			return 0;
		}
	}

	public async getLogFileContent(lines: number = 50): Promise<string> {
		if (!this.app || !this.logFilePath) {
			return 'Log file not available';
		}

		try {
			const adapter = this.app.vault.adapter;
			const content = await adapter.read(this.logFilePath);
			const logLines = content.split('\n');
			const recentLines = logLines.slice(-lines);
			return recentLines.join('\n');
		} catch (error) {
			return `Error reading log file: ${error.message}`;
		}
	}
}

// Export a singleton instance for easy access
export const logger = SVNLogger.getInstance();

// Convenience functions that match the existing console.log pattern
export function logDebug(component: string, message: string, data?: any): void {
	logger.debug(component, message, data);
}

export function logInfo(component: string, message: string, data?: any): void {
	logger.info(component, message, data);
}

export function logWarn(component: string, message: string, data?: any): void {
	logger.warn(component, message, data);
}

export function logError(component: string, message: string, data?: any): void {
	logger.error(component, message, data);
}
