# Subversion Plugin

This plugin integrates Subversion (SVN) version control into Obsidian, allowing users to manage individual file revisions with fine-grain control.

## Features

- View and manage file history for individual files.
- Checkout specific revisions of files.
- Easy configuration of SVN binary path.
- User-friendly interface for selecting revisions.

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

## Debugging

In Developer Console (`Ctrl+Shift+I`), run `window.DEBUG['subversion'].enable()`

To learn more, see [obsidian-logger](https://github.com/AMC-Albert/obsidian-logger).