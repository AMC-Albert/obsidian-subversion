# Subversion Plugin

This plugin integrates Subversion (SVN) version control into Obsidian, allowing users to manage individual file revisions with fine-grain control.

## Features

- View and manage file history for individual files.
- Checkout specific revisions of files.
- Easy configuration of SVN binary path.
- User-friendly interface for selecting revisions.

## Debug

To enable debug output for this plugin:

1. Open the developer console (`Ctrl+Shift+I` / `Cmd+Option+I`)
2. Run: `window.DEBUG.enable('subversion')`
3. Test debug output: `window.testSubversionDebug()`

To disable debug output: `window.DEBUG.disable('subversion')`

## Installation

1. Clone the repository:
   ```
   git clone https://github.com/yourusername/obsidian-svn-plugin.git
   ```

2. Navigate to the plugin directory:
   ```
   cd obsidian-svn-plugin
   ```

3. Install dependencies:
   ```
   npm install
   ```

4. Build the plugin:
   ```
   npm run build
   ```

5. Copy the plugin to your Obsidian plugins folder.

## Configuration

Before using the plugin, you need to specify the path to your SVN binary. You can do this in the plugin settings:

- Open the settings in Obsidian.
- Navigate to the SVN Plugin settings.
- Enter the path to your SVN binary or ensure it is in your PATH environment variable.

## Usage

- Access the file history view from the command palette.
- Select a file to view its revision history.
- Use the revision modal to checkout specific revisions.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request for any enhancements or bug fixes.

## License

This project is licensed under the MIT License. See the LICENSE file for details.