/**
 * Core types and interfaces for the SVN plugin
 */

export interface SvnStatus {
    status: string;
    filePath: string;
}

export interface SvnLogEntry {
    revision: string;
    author: string;
    date: string;
    message: string;
}

export interface SvnPluginSettings {
    svnBinaryPath: string;
    commitMessage: string;
    autoCommit: boolean;
    showStatusInStatusBar: boolean;
}

export interface PluginConstants {
    readonly VIEW_TYPE: string;
    readonly ICON_ID: string;
    readonly PLUGIN_NAME: string;
}

export type SvnCommand = 
    | 'status'
    | 'log'
    | 'diff'
    | 'commit'
    | 'revert'
    | 'add'
    | 'remove'
    | 'info';

export interface SvnCommandResult {
    success: boolean;
    output: string;
    error?: string;
}
