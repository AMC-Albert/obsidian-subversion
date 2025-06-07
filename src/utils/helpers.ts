/**
 * Utility functions for the SVN plugin
 */

/**
 * Check if a file is a markdown file
 */
export function isMarkdownFile(filePath: string): boolean {
    return filePath.endsWith('.md');
}

/**
 * Format a timestamp for display
 */
export function formatTimestamp(timestamp: string): string {
    try {
        const date = new Date(timestamp);
        return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
    } catch {
        return timestamp;
    }
}

/**
 * Sanitize file path for display
 */
export function sanitizeFilePath(filePath: string): string {
    return filePath.replace(/[<>:"|?*]/g, '_');
}

/**
 * Create a debounced function
 */
export function debounce<T extends (...args: any[]) => any>(
    func: T,
    wait: number
): (...args: Parameters<T>) => void {
    let timeout: NodeJS.Timeout;
    return (...args: Parameters<T>) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
}

/**
 * Parse SVN status code to human readable format
 */
export function parseStatusCode(code: string): string {
    const statusMap: Record<string, string> = {
        'A': 'Added',
        'D': 'Deleted',
        'M': 'Modified',
        'R': 'Replaced',
        'C': 'Conflicted',
        'I': 'Ignored',
        '?': 'Untracked',
        '!': 'Missing',
        'X': 'External'
    };
    
    return statusMap[code] || code;
}




