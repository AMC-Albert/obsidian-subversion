import { SvnLogEntry, SvnStatus, SvnStatusCode, SvnPropertyStatus, SvnBlameEntry, SvnInfo } from '@/types'; // Added SvnBlameEntry, SvnInfo
import { SVNStatusUtils } from '@/utils';
import { loggerDebug, loggerInfo, loggerError, loggerWarn } from '@/utils/obsidian-logger';

export class SVNOutputParser {

    constructor() {
        // registerLoggerClass(this, 'SVNOutputParser'); // TODO: Add logger registration if needed
    }    public parseStatus(output: string): SvnStatus[] {
        const lines = output.trim().split('\n');
        const statuses: SvnStatus[] = [];

        for (const line of lines) {
            if (line.trim() === '') continue;

            // Skip SVN summary lines (conflicts, etc.)
            if (line.startsWith('Summary of conflicts:') || 
                line.startsWith('  Text conflicts:') ||
                line.includes('conflicts:') ||
                line.startsWith('At revision') ||
                line.startsWith('Updated to revision') ||
                line.startsWith('---') || 
                line.startsWith('Status against revision')) {
                continue;
            }

            // Basic line format validation - must be at least 8 characters for valid status
            if (line.length < 8) {
                continue;
            }

            const statusChar = line[0];
            const propertyStatusChar = line[1];
            let pathStartIndex = 1;
            if (line.length > 1 && line[1] !== ' ') pathStartIndex = 2;
            if (line.length > 2 && line[2] !== ' ') pathStartIndex = 3;
            if (line.length > 3 && line[3] !== ' ') pathStartIndex = 4;
            if (line.length > 4 && line[4] !== ' ') pathStartIndex = 5;
            if (line.length > 5 && line[5] !== ' ') pathStartIndex = 6;
            if (line.length > 6 && line[6] !== ' ') pathStartIndex = 7;
            if (line.length > 7 && line[7] !== ' ') pathStartIndex = 8;

            const filePath = line.substring(pathStartIndex).trim();

            // Skip if no valid file path
            if (!filePath) {
                continue;
            }

            const status = SVNStatusUtils.fromChar(statusChar) as SvnStatusCode;
            const propertyStatus = SVNStatusUtils.propStatusFromChar(propertyStatusChar) as SvnPropertyStatus;

            statuses.push({
                filePath,
                status,
                propertyStatus,
                locked: line[2] === 'L',
            });
        }
        return statuses;
    }

    public parseXmlLog(xmlOutput: string): SvnLogEntry[] {
        const entries: SvnLogEntry[] = [];
        const logEntries = xmlOutput.match(/<logentry[^>]*>([\s\S]*?)<\/logentry>/g);

        if (logEntries) {
            for (const entryXml of logEntries) {
                const revisionMatch = entryXml.match(/revision="(\d+)"/);
                const authorMatch = entryXml.match(/<author>([^<]*)<\/author>/);
                const dateMatch = entryXml.match(/<date>([^<]*)<\/date>/);
                const msgMatch = entryXml.match(/<msg>([\s\S]*?)<\/msg>/);

                const paths: { path: string; action: string; kind: string, "copyfrom-path"?: string, "copyfrom-rev"?: string }[] = [];
                const pathMatches = entryXml.matchAll(/<path[^>]*kind="([^"]*)"[^>]*action="([A-Z])"(?:[^>]*copyfrom-path="([^"]*)"[^>]*copyfrom-rev="([^"]*)")?[^>]*>([^<]*)<\/path>/g);
                for (const pathMatch of pathMatches) {
                    paths.push({
                        kind: pathMatch[1],
                        action: pathMatch[2],
                        "copyfrom-path": pathMatch[3],
                        "copyfrom-rev": pathMatch[4],
                        path: pathMatch[5]
                    });
                }

                if (revisionMatch && authorMatch && dateMatch) {
                    entries.push({
                        revision: parseInt(revisionMatch[1], 10),
                        author: authorMatch[1],
                        date: dateMatch[1], 
                        message: msgMatch ? msgMatch[1].trim() : '',
                    });
                }
            }
        }
        return entries;
    }

    public parseLogXml(xmlOutput: string): SvnLogEntry[] {
        // This is an alias for parseXmlLog, assuming it's the intended XML log parser.
        // If there's a different specific format for "log --xml", this needs to be implemented.
        return this.parseXmlLog(xmlOutput);
    }

    public parseBlameXml(xmlOutput: string): SvnBlameEntry[] {
        const entries: SvnBlameEntry[] = [];
        const lines = xmlOutput.split('\n');
        let currentEntry: Partial<SvnBlameEntry> = {};
        let lineNumber = 1; // Default, will be overridden by line-number attribute

        for (const line of lines) {
            if (line.includes('<entry')) {
                const lineNumMatch = line.match(/line-number="(\d+)"/);
                if (lineNumMatch) {
                    lineNumber = parseInt(lineNumMatch[1]);
                }
            }
            if (line.includes('<commit')) { // commit is a sub-element of entry
                const revMatch = line.match(/revision="(\d+)"/);
                if (revMatch) {
                    currentEntry.revision = parseInt(revMatch[1], 10);
                }
            }
            if (line.includes('<author>')) {
                currentEntry.author = line.replace(/<\/?author>/g, '').trim();
            }
            if (line.includes('<date>')) {
                currentEntry.date = line.replace(/<\/?date>/g, '').trim();
            }
            if (line.includes('</entry>')) {
                if (currentEntry.revision !== undefined && currentEntry.author !== undefined) {
                    entries.push({
                        lineNumber,
                        revision: currentEntry.revision,
                        author: currentEntry.author,
                        date: currentEntry.date || ''
                    });
                }
                currentEntry = {}; // Reset for the next entry
            }
        }
        return entries;
    }

    public parseInfoXml(xmlOutput: string): SvnInfo | null {
        const lines = xmlOutput.split('\n');
        const info: Partial<SvnInfo> = {};
        let inCommitSection = false;

        const urlMatch = xmlOutput.match(/<url>(.*?)<\/url>/);
        if (urlMatch) info.url = urlMatch[1];

        const repositoryRootMatch = xmlOutput.match(/<repository>[\s\S]*?<root>(.*?)<\/root>/);
        if (repositoryRootMatch) info.repositoryRoot = repositoryRootMatch[1];

        const repositoryUuidMatch = xmlOutput.match(/<uuid>(.*?)<\/uuid>/);
        if (repositoryUuidMatch) info.repositoryUuid = repositoryUuidMatch[1];
        
        const entryRevisionMatch = xmlOutput.match(/<entry[^>]*revision="(\d+)"/);
        if (entryRevisionMatch) {
            info.revision = parseInt(entryRevisionMatch[1], 10);
        }

        for (const line of lines) {
            if (line.includes('<commit')) {
                inCommitSection = true;
                const commitRevMatch = line.match(/revision="(\d+)"/);
                if (commitRevMatch) {
                    info.lastChangedRev = parseInt(commitRevMatch[1], 10);
                }
            }
            if (inCommitSection) {
                if (line.includes('<author>')) {
                    const authorMatch = line.match(/<author>(.*?)<\/author>/);
                    if (authorMatch) {
                        info.lastChangedAuthor = authorMatch[1];
                    }
                }
                if (line.includes('<date>')) {
                    const dateMatch = line.match(/<date>(.*?)<\/date>/);
                    if (dateMatch) {
                        info.lastChangedDate = dateMatch[1];
                    }
                }
            }
            if (line.includes('</commit>')) {
                inCommitSection = false;
            }
        }
        return info.url && info.repositoryRoot && info.revision !== undefined ? info as SvnInfo : null;
    }

    public parsePropertiesXml(xmlOutput: string): Record<string, string> {
        const properties: Record<string, string> = {};
        const lines = xmlOutput.split('\n');
        let currentProp = '';
        let inValue = false; // This logic might be too simple for nested XML or CDATA

        for (const line of lines) {
            if (line.includes('<property') && line.includes('name=')) {
                const nameMatch = line.match(/name="([^"]+)"/);
                if (nameMatch) {
                    currentProp = nameMatch[1];
                    // Reset value for currentProp, in case it's empty or multi-line
                    properties[currentProp] = ''; 
                }
                inValue = true; // Assume value might follow or be on the same line (though SVN usually puts it on next)
            } else if (line.includes('</property>')) {
                inValue = false;
                currentProp = '';
            } else if (inValue && currentProp) {
                // Accumulate value if it spans multiple lines or contains XML entities
                // This simple trim might not handle all XML cases correctly (e.g. CDATA)
                const valuePart = line.trim(); 
                if (valuePart) { // Append if not empty
                     properties[currentProp] = (properties[currentProp] ? properties[currentProp] + '\n' : '') + valuePart;
                }
            }
        }
        return properties;
    }

    /**
     * Convert single character SVN status code to enum
     */
    public convertCharToStatusCode(statusChar: string): SvnStatusCode {
        switch (statusChar) {
            case 'M': return SvnStatusCode.MODIFIED;
            case 'A': return SvnStatusCode.ADDED;
            case 'D': return SvnStatusCode.DELETED;
            case 'R': return SvnStatusCode.REPLACED;
            case 'C': return SvnStatusCode.CONFLICTED;
            case '?': return SvnStatusCode.UNVERSIONED;
            case '!': return SvnStatusCode.MISSING;
            case 'I': return SvnStatusCode.IGNORED;
            case 'X': return SvnStatusCode.EXTERNAL;
            case ' ': return SvnStatusCode.NORMAL;
            default:
                loggerWarn('SVNOutputParser', `Unknown SVN status code: ${statusChar}, defaulting to NORMAL`);
                return SvnStatusCode.NORMAL;
        }
    }
}
